import type { Express, Request, Response } from "express";
import { auth } from "../../auth";
import { requireRole, resolveOrg } from "../../orgs";
import { contextFromRequest } from "../../actions/context";
import type { OrgRequest } from "../../types";
import { db } from "../../../db";
import { organizations } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { SLACK_BASE_PATH, SLACK_SCOPES, integrationsTabUrl, isSlackAppConfigured, slackAppEnv, slackRedirectUri } from "./config";
import { STATE_TTL_MS, exchangeCode, installUrl, signState, verifyState } from "./oauth";
import { getSlackForTeam, saveSlackInstall } from "./store";
import { resolveSlackCaller } from "./identity";
import { handleLink, handleSlashCommand, handleUnlink, linkInstructions, parseSlashBody } from "./commands";
import { canonicalSub } from "./commands";
import { parseCommandText } from "./parse";
import { ephemeral, errorReply, type SlackReply } from "./format";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, VERIFY_MESSAGES, mountRawBodyCapture, rawBodyOf, verifySlackRequest } from "./verify";
import { postToResponseUrl } from "./web";

/**
 * HTTP surface of the Slack adapter. `registerSlackRoutes(app)` is the only export
 * the rest of the server needs.
 *
 *   POST /api/integrations/slack/commands      ← Slack (signed, unauthenticated)
 *   GET  /api/integrations/slack/install       ← admin with a JWT, 302 to Slack
 *   POST /api/integrations/slack/install-url   ← admin with a JWT, returns the URL
 *   GET  /api/integrations/slack/callback      ← Slack's OAuth redirect (state-signed)
 */

/** Slack hangs up on a slash command after 3s; leave room to answer in time. */
const INLINE_BUDGET_MS = 2_500;
const TIMED_OUT = Symbol("slack-timeout");

export function registerSlackRoutes(app: Express): void {
  // Must run before Express's global body parsers — see verify.ts.
  const placement = mountRawBodyCapture(app, SLACK_BASE_PATH);
  if (placement === "appended") {
    console.warn("[slack] raw-body capture could not be placed before the body parsers; slash-command signatures may not verify");
  }

  app.post(`${SLACK_BASE_PATH}/install-url`, auth, resolveOrg, requireRole("admin"), (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const appEnv = slackAppEnv();
    if (!isSlackAppConfigured(appEnv)) {
      return res.status(503).json({ error: "slack_not_configured", message: "Slack app not configured on this server (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_SIGNING_SECRET)" });
    }
    const redirectUri = slackRedirectUri(req);
    const state = signState({ orgId: r.org.id, userId: r.user[0].id });
    res.json({
      url: installUrl({ clientId: appEnv.clientId, redirectUri, state }),
      redirectUri,
      scopes: [...SLACK_SCOPES],
      expiresInSeconds: Math.round(STATE_TTL_MS / 1000),
    });
  });

  app.get(`${SLACK_BASE_PATH}/install`, auth, resolveOrg, requireRole("admin"), (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const appEnv = slackAppEnv();
    if (!isSlackAppConfigured(appEnv)) {
      return res.status(503).json({ error: "slack_not_configured", message: "Slack app not configured on this server" });
    }
    const state = signState({ orgId: r.org.id, userId: r.user[0].id });
    res.redirect(302, installUrl({ clientId: appEnv.clientId, redirectUri: slackRedirectUri(req), state }));
  });

  /**
   * The OAuth redirect carries no PTD session (it is a fresh browser navigation), so
   * the signed `state` is what proves which organization asked for the install.
   */
  app.get(`${SLACK_BASE_PATH}/callback`, async (req: Request, res: Response) => {
    const denied = typeof req.query.error === "string" ? req.query.error : null;
    if (denied) return res.redirect(302, integrationsTabUrl("error", denied));

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code) return res.redirect(302, integrationsTabUrl("error", "missing_code"));

    const checked = verifyState(state);
    if (!checked.ok) return res.redirect(302, integrationsTabUrl("error", `state_${checked.reason}`));

    const exchanged = await exchangeCode(code, slackRedirectUri(req));
    if (!exchanged.ok) return res.redirect(302, integrationsTabUrl("error", exchanged.error));

    try {
      await saveSlackInstall(checked.payload.orgId, checked.payload.userId, exchanged.install);
    } catch (err) {
      console.error("[slack] could not store the install:", err);
      return res.redirect(302, integrationsTabUrl("error", "store_failed"));
    }
    res.redirect(302, integrationsTabUrl("connected"));
  });

  app.post(`${SLACK_BASE_PATH}/commands`, async (req: Request, res: Response) => {
    const raw = rawBodyOf(req);
    if (raw === null) {
      console.error("[slack] slash command arrived without a raw body — the capture layer is not in front of the parsers");
      return res.status(400).json({ error: "raw_body_unavailable" });
    }

    const payload = parseSlashBody(raw);
    if (!payload.teamId || !payload.userId) return res.status(400).json({ error: "not_a_slash_command" });

    // Read-only lookup before verification: it only tells us which signing secret to try.
    const row = await getSlackForTeam(payload.teamId).catch(() => null);
    const verified = verifySlackRequest({
      rawBody: raw,
      timestamp: req.header(TIMESTAMP_HEADER),
      signature: req.header(SIGNATURE_HEADER),
      secrets: [slackAppEnv().signingSecret, row?.config.signingSecret],
    });
    if (!verified.ok) {
      const status = verified.reason === "no_secret" ? 503 : 401;
      return res.status(status).json({ error: verified.reason, message: VERIFY_MESSAGES[verified.reason] });
    }

    if (!row || !row.enabled) {
      return res.json(errorReply(
        "This Slack workspace is not connected to a PTD organization.",
        ["a PTD admin connects it from Org → Integrations → Slack"],
      ));
    }

    const orgName = await orgNameOf(row.orgId);
    const parsed = parseCommandText(payload.text);
    const sub = canonicalSub(parsed.sub);

    try {
      if (sub === "link") {
        return res.json(await handleLink({ payload, orgId: row.orgId, orgName, code: parsed.args[0] }));
      }
      if (sub === "unlink") {
        return res.json(await handleUnlink({ payload }));
      }

      const caller = await resolveSlackCaller(row.orgId, `${payload.teamId}:${payload.userId}`);
      if (!caller.ok) {
        if (caller.reason === "no_membership") {
          return res.json(errorReply(
            `Your PTD account is not a member of ${orgName ?? "the organization"} this workspace is connected to.`,
            ["ask an admin for an invitation, or `/ptd unlink` and link the right account"],
          ));
        }
        return res.json(linkInstructions(orgName));
      }

      await respondWithin(res, payload.responseUrl, handleSlashCommand({ ctx: caller.ctx, payload, teamName: row.config.teamName }));
    } catch (err) {
      console.error("[slack] slash command failed:", err);
      if (!res.headersSent) res.json(errorReply("Something went wrong on the PTD side — the server log has the details."));
    }
  });
}

async function orgNameOf(orgId: number): Promise<string | null> {
  try {
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    return org?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Answer inline when the action is quick (all of them are), and fall back to
 * `response_url` if it is not — Slack shows "operation timed out" after 3 seconds,
 * and a late answer is much better than an error the user has to interpret.
 */
export async function respondWithin(res: Response, responseUrl: string | null, work: Promise<SlackReply>, budgetMs = INLINE_BUDGET_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
    timer.unref?.();
  });
  const first = await Promise.race([work, deadline]);
  if (timer) clearTimeout(timer);

  if (first !== TIMED_OUT) {
    res.json(first);
    return;
  }
  res.json(ephemeral(["_Working on it…_"]));
  void work
    .then((reply) => (responseUrl ? postToResponseUrl(responseUrl, reply) : undefined))
    .catch((err) => console.error("[slack] late reply failed:", err));
}
