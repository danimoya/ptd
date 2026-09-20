import type { Request } from "express";
import { publicBaseUrl as publicBase } from "../shared/publicUrl";

/**
 * App-level Slack configuration.
 *
 * One Slack app serves every organization on a PTD deployment: the client id,
 * client secret and signing secret are deployment-wide env vars, while the
 * per-workspace bot token lives sealed in `org_integrations.config`. Without the
 * env vars the UI says "Slack app not configured on this server" instead of
 * offering a button that could only fail.
 */

export const SLACK_BASE_PATH = "/api/integrations/slack";

/** Bot scopes the install asks for. `commands` alone would not let us reply outside the slash command. */
export const SLACK_SCOPES = ["commands", "chat:write", "users:read", "users:read.email"] as const;

export interface SlackAppEnv {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

const env = (name: string): string => (process.env[name] ?? "").trim();

export function slackAppEnv(): SlackAppEnv {
  return {
    clientId: env("SLACK_CLIENT_ID"),
    clientSecret: env("SLACK_CLIENT_SECRET"),
    signingSecret: env("SLACK_SIGNING_SECRET"),
  };
}

export function isSlackAppConfigured(app: SlackAppEnv = slackAppEnv()): boolean {
  return app.clientId !== "" && app.clientSecret !== "" && app.signingSecret !== "";
}

/** Public origin of this deployment — shared with the other adapters. */
export { publicBaseUrl } from "../shared/publicUrl";

/**
 * The redirect URI handed to Slack. It must match the one registered on the app
 * exactly, so an explicit override exists for deployments whose public URL is not
 * what the request header says.
 */
export function slackRedirectUri(req?: Request): string {
  const explicit = env("SLACK_REDIRECT_URI");
  if (explicit) return explicit;
  return `${publicBase(req)}${SLACK_BASE_PATH}/callback`;
}

/** Where the browser lands after the OAuth dance, with the outcome in the query string. */
export function integrationsTabUrl(outcome: string, detail?: string): string {
  const q = new URLSearchParams({ tab: "integrations", slack: outcome });
  if (detail) q.set("reason", detail);
  return `/org/integrations?${q.toString()}`;
}
