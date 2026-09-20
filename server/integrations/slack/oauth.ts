import { SLACK_SCOPES, slackAppEnv } from "./config";
import { oauthAccess } from "./web";
import type { SlackInstall } from "./store";
import {
  signState as signSharedState,
  verifyState as verifySharedState,
  type StateCheck,
  type StatePayload,
} from "../shared/state";

/**
 * Slack OAuth v2 ("Add to Slack").
 *
 * The `state` parameter is the only thing tying the browser round-trip back to a
 * PTD organization, so it is signed and short-lived — see `../shared/state`, which
 * the GitHub App install uses for the same reason under its own purpose string.
 */

export const SLACK_STATE_PURPOSE = "slack-oauth-state";
export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

export { STATE_TTL_MS, type StateFailure, type StatePayload } from "../shared/state";

/** Slack's install state, signed with the shared helper under the Slack purpose. */
export function signState(
  payload: Omit<StatePayload, "nonce" | "exp"> & Partial<Pick<StatePayload, "nonce" | "exp">>,
  now = Date.now(),
): string {
  return signSharedState(SLACK_STATE_PURPOSE, payload, now);
}

export function verifyState(raw: string, now = Date.now()): StateCheck {
  return verifySharedState(SLACK_STATE_PURPOSE, raw, now);
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
