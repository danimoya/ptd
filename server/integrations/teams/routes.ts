import type { Express, Request, Response } from "express";
import { orgNameOf } from "../shared/identity";
import { replyToPlainText } from "../shared/markup";
import { mountRawBodyCapture, rawBodyOf } from "../shared/rawBody";
import { TEAMS_AUTH_HEADER, TEAMS_BASE_PATH } from "./config";
import { handleTeamsActivity, readActivity } from "./commands";
import { allTeamsRows, patchTeamsConfig, secretOf } from "./store";
import { VERIFY_MESSAGES, verifyTeamsRequest } from "./verify";

/**
 * HTTP surface of the Teams adapter. `registerTeamsRoutes(app)` is the only export the
 * rest of the server needs.
 *
 *   POST /api/integrations/teams/webhook   ← Teams (HMAC-signed, unauthenticated)
 *
 * One route, and the signature does double duty: it proves the delivery is genuine AND
 * it names the organization, because a Teams Outgoing Webhook tells you nothing else
 * you could trust. Each connected organization's secret is tried against the body, and
 * the one that verifies is the tenant.
 *
 * The reply is the HTTP response — `{"type":"message","text":"…"}` — which is the whole
 * Outgoing Webhook contract: no outbound call, no token, no Bot Framework.
 */

/** Teams gives up on an outgoing webhook after ~5s. */
export const TEAMS_BUDGET_MS = 4_000;

function messageReply(text: string) {
  return { type: "message", text };
}

export function registerTeamsRoutes(app: Express): void {
  // Must run before Express's global body parsers — see ../shared/rawBody.
  const placement = mountRawBodyCapture(app, TEAMS_BASE_PATH, "teamsRawBodyCapture");
  if (placement === "appended") {
    console.warn("[teams] raw-body capture could not be placed before the body parsers; webhook HMACs may not verify");
  }

  app.post(`${TEAMS_BASE_PATH}/webhook`, async (req: Request, res: Response) => {
    const raw = rawBodyOf(req);
    if (raw === null) {
      console.error("[teams] webhook arrived without a raw body — the capture layer is not in front of the parsers");
      return res.status(400).json(messageReply("PTD could not read that request."));
    }

    // Read-only lookup before verification: it only tells us which secrets to try.
    const rows = await allTeamsRows().catch(() => []);
    const verified = verifyTeamsRequest({
      rawBody: raw,
      header: req.header(TEAMS_AUTH_HEADER),
      secrets: rows.map((row) => secretOf(row.config)),
    });
    if (!verified.ok) {
      const status = verified.reason === "bad_signature" ? 401 : verified.reason === "no_secret" ? 503 : 400;
      return res.status(status).json(messageReply(VERIFY_MESSAGES[verified.reason]));
    }
    const row = rows.find((candidate) => secretOf(candidate.config) === verified.secret);
    if (!row) return res.status(401).json(messageReply(VERIFY_MESSAGES.bad_signature));

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return res.status(400).json(messageReply("PTD could not read that message."));
    }

    const activity = readActivity(body);
    if (!activity || !activity.text) {
      return res.json(messageReply("Say what you want — try `@PTD help`."));
    }

    try {
      const orgName = await orgNameOf(row.orgId);
      const handled = await handleTeamsActivity({
        activity,
        orgId: row.orgId,
        orgName,
        teamName: row.config.teamName ?? activity.teamName,
      });
      void patchTeamsConfig(row.orgId, { lastEventAt: new Date().toISOString(), lastError: null }).catch(() => null);
      res.json(messageReply(replyToPlainText(handled.reply)));
    } catch (err) {
      console.error("[teams] activity failed:", err);
      void patchTeamsConfig(row.orgId, { lastError: err instanceof Error ? err.message : String(err) }).catch(() => null);
      res.json(messageReply("Something went wrong on the PTD side — the server log has the details."));
    }
  });
}
