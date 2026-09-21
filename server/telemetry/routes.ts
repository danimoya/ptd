import type { Express, NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "../auth";
import { resolveOrg } from "../orgs";
import { memberships } from "../../db/schema";
import type { AuthenticatedRequest } from "../types";
import { validate } from "../validation";
import { loadInstall } from "./install";
import {
  TELEMETRY_POLICY,
  OFFLINE_FORMATS,
  buildPayload,
  checkUpdates,
  offlineCommandsFor,
  ping,
  setPreferences,
  startTelemetryScheduler,
  statusOf,
} from "./service";

/**
 * The telemetry surface: four routes, all owner-only.
 *
 * Owner-only and *instance*-wide are in tension, and the gate resolves it the
 * blunt way: the caller must be the owner of at least one organization on this
 * deployment. The setting belongs to the installation, not to an org — one PTD
 * process serves many organizations and reports one install — so gating on the
 * currently selected org's role would let the owner of org A be refused while
 * looking at org B. `resolveOrg` still runs ahead of the gate, because it is
 * where the organization-wide 2FA policy is enforced and telemetry is not a
 * reason to skip it.
 *
 * Every verb here is also an action (`server/actions/telemetry.ts`) for the CLI,
 * MCP and the audit trail. These routes exist because the section reads four
 * things at once — status, the exact payload, the six offline snippets and the
 * policy text — and one GET is a better shape for that than four action calls.
 */

const preferencesSchema = z
  .object({
    telemetryEnabled: z.boolean().optional(),
    updateChecksEnabled: z.boolean().optional(),
    /** The first-run banner being dismissed: no toggle moves, the question still counts as answered. */
    dismissed: z.boolean().optional(),
  })
  .strict();

/** True when this user owns at least one organization here. */
export async function ownsAnyOrg(userId: number): Promise<boolean> {
  const { db } = await import("../../db");
  const rows = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.role, "owner")))
    .limit(1);
  return rows.length > 0;
}

/**
 * The gate, with the lookup injected so the rule can be tested without a
 * database. Anything that is not an owner gets 403 and no part of the record —
 * not even the installation id.
 */
export function ownerGate(isOwner: (userId: number) => Promise<boolean> = ownsAnyOrg) {
  return async function ptdTelemetryOwnerGate(req: Request, res: Response, next: NextFunction) {
    const user = (req as AuthenticatedRequest).user?.[0];
    if (!user) return res.status(401).json({ error: "Unauthenticated" });
    try {
      if (!(await isOwner(user.id))) {
        return res.status(403).json({
          error: "forbidden",
          message: "Installation telemetry is an instance-wide setting; only an organization owner can read or change it.",
        });
      }
    } catch {
      return res.status(500).json({ error: "internal", message: "Could not check ownership" });
    }
    next();
  };
}

export function registerTelemetryRoutes(app: Express): void {
  const owner = ownerGate();

  /**
   * Everything the section renders, in one call. The payload is stamped now, so
   * "Refresh timestamp" in the UI is a refetch of this route and the six
   * snippets always agree with the preview above them.
   */
  app.get("/api/telemetry", auth, resolveOrg, owner, async (_req: Request, res: Response) => {
    try {
      const install = await loadInstall();
      const payload = await buildPayload(install);
      res.json({
        status: statusOf(install),
        payload,
        offline: { formats: OFFLINE_FORMATS, commands: offlineCommandsFor(payload) },
        policy: TELEMETRY_POLICY,
      });
    } catch (error) {
      console.error("[telemetry] status failed:", error);
      res.status(500).json({ error: "internal", message: "Could not read the install record" });
    }
  });

  app.post("/api/telemetry/preferences", auth, resolveOrg, owner, validate(preferencesSchema), async (req: Request, res: Response) => {
    try {
      res.json(await setPreferences(req.body as z.infer<typeof preferencesSchema>));
    } catch (error) {
      console.error("[telemetry] preferences failed:", error);
      res.status(500).json({ error: "internal", message: "Could not write the install record" });
    }
  });

  /** Send one now. Answers 200 with `ok: false` when it failed — a refused ping is not a server error. */
  app.post("/api/telemetry/ping", auth, resolveOrg, owner, async (_req: Request, res: Response) => {
    res.json(await ping());
  });

  app.get("/api/telemetry/updates", auth, resolveOrg, owner, async (_req: Request, res: Response) => {
    res.json(await checkUpdates());
  });

  // The weekly ping. Hourly tick, pings when the last success is seven days old;
  // skipped when PTD_SCHEDULER=0, exactly like the recurrence scheduler, and a
  // no-op regardless while telemetry is off.
  startTelemetryScheduler();
}
