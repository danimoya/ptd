import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { SLACK_SCOPES, slackAppEnv } from "./config";
import { oauthAccess } from "./web";
import type { SlackInstall } from "./store";

/**
 * Slack OAuth v2 ("Add to Slack").
 *
 * The `state` parameter is the only thing tying the browser round-trip back to a
 * PTD organization, so it is signed (HMAC-SHA256, keyed from PTD_SECRET_KEY) and
 * short-lived: the callback needs no PTD session, and a stolen or hand-made state
 * cannot install an app into someone else's organization.
 */

export const STATE_TTL_MS = 10 * 60 * 1000;
export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

export interface StatePayload {
  orgId: number;
  userId: number;
  nonce: string;
  exp: number;
}

function stateKey(): Buffer {
  const raw = process.env.PTD_SECRET_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production") throw new Error("PTD_SECRET_KEY must be set in production");
    return createHash("sha256").update("ptd-dev-secret-key").digest();
  }
  return createHash("sha256").update(`slack-oauth-state:${raw}`).digest();
}

const b64 = (value: Buffer | string): string => Buffer.from(value as never).toString("base64url");

export function signState(payload: Omit<StatePayload, "nonce" | "exp"> & Partial<Pick<StatePayload, "nonce" | "exp">>, now = Date.now()): string {
  const full: StatePayload = {
    orgId: payload.orgId,
    userId: payload.userId,
    nonce: payload.nonce ?? randomBytes(9).toString("base64url"),
    exp: payload.exp ?? now + STATE_TTL_MS,
  };
  const body = b64(JSON.stringify(full));
  const mac = createHmac("sha256", stateKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export type StateFailure = "malformed" | "bad_signature" | "expired";

export function verifyState(raw: string, now = Date.now()): { ok: true; payload: StatePayload } | { ok: false; reason: StateFailure } {
  const [body, mac] = (raw ?? "").split(".");
  if (!body || !mac) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", stateKey()).update(body).digest("base64url");
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload?.orgId !== "number" || typeof payload?.userId !== "number" || typeof payload?.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

export function installUrl(input: { clientId: string; redirectUri: string; state: string; scopes?: readonly string[] }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    scope: (input.scopes ?? SLACK_SCOPES).join(","),
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

export type ExchangeResult = { ok: true; install: SlackInstall } | { ok: false; error: string };

/** Turn the `code` Slack sends back into a bot token. Never throws. */
export async function exchangeCode(code: string, redirectUri: string): Promise<ExchangeResult> {
  const app = slackAppEnv();
  if (!app.clientId || !app.clientSecret) return { ok: false, error: "app_not_configured" };
  const body = await oauthAccess({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri });
  if (!body.ok) return { ok: false, error: String(body.error ?? "oauth_failed") };

  const team = (body.team ?? {}) as { id?: string; name?: string };
  const authedUser = (body.authed_user ?? {}) as { id?: string };
  const botToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!team.id || !botToken) return { ok: false, error: "incomplete_oauth_response" };

  return {
    ok: true,
    install: {
      teamId: team.id,
      teamName: team.name ?? null,
      botUserId: typeof body.bot_user_id === "string" ? body.bot_user_id : null,
      botToken,
      appId: typeof body.app_id === "string" ? body.app_id : null,
      scope: typeof body.scope === "string" ? body.scope : null,
      authedUserId: authedUser.id ?? null,
    },
  };
}
