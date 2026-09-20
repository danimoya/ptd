import type { Request } from "express";
import { publicBaseUrl } from "../shared/publicUrl";

/**
 * App-level GitHub configuration.
 *
 * One GitHub App serves every organization on a PTD deployment: the app id, its
 * private key, its slug and the webhook secret are deployment-wide env vars, while
 * the per-organization *installation* id lives in `org_integrations.config`. Without
 * the env vars the UI says "GitHub app not configured on this server" instead of
 * offering a button that could only fail.
 *
 * `GITHUB_APP_PRIVATE_KEY` is base64-encoded because a PEM is multi-line and .env
 * files are not; a raw PEM is accepted too, since sooner or later someone pastes one.
 */

export const GITHUB_BASE_PATH = "/api/integrations/github";

/** What the App needs, and nothing more: read/write issues, read metadata. */
export const GITHUB_PERMISSIONS = { issues: "write", metadata: "read" } as const;
/** The only two webhook events PTD subscribes to. */
export const GITHUB_EVENTS = ["issues", "issue_comment"] as const;

export interface GithubAppEnv {
  appId: string;
  /** PEM, decoded from base64 if that is how it was given. */
  privateKey: string;
  slug: string;
  webhookSecret: string;
}

const env = (name: string): string => (process.env[name] ?? "").trim();

/**
 * Accept a base64 blob, a PEM with real newlines, or a PEM with `\n` escapes, and hand
 * back one canonical form — OpenSSL is particular about the armour and not about the
 * trailing newline, so normalising here means the same key gives the same string
 * however it reached the env file.
 */
export function decodePrivateKey(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  const canonical = (pem: string): string => `${pem.replace(/\\n/g, "\n").trim()}\n`;
  if (value.includes("-----BEGIN")) return canonical(value);
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return decoded.includes("-----BEGIN") ? canonical(decoded) : "";
  } catch {
    return "";
  }
}

export function githubAppEnv(): GithubAppEnv {
  return {
    appId: env("GITHUB_APP_ID"),
    privateKey: decodePrivateKey(env("GITHUB_APP_PRIVATE_KEY")),
    slug: env("GITHUB_APP_SLUG"),
    webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
  };
}

/** Which env vars are still missing, for a status line an admin can act on. */
export function missingGithubEnv(app: GithubAppEnv = githubAppEnv()): string[] {
  const missing: string[] = [];
  if (!app.appId) missing.push("GITHUB_APP_ID");
  if (!app.privateKey) missing.push("GITHUB_APP_PRIVATE_KEY");
  if (!app.slug) missing.push("GITHUB_APP_SLUG");
  if (!app.webhookSecret) missing.push("GITHUB_WEBHOOK_SECRET");
  return missing;
}

export function isGithubAppConfigured(app: GithubAppEnv = githubAppEnv()): boolean {
  return missingGithubEnv(app).length === 0;
}

/** Public origin of this deployment — shared with the other adapters. */
export { publicBaseUrl } from "../shared/publicUrl";

/** Where GitHub sends `issues` / `issue_comment` deliveries. */
export function githubWebhookUrl(req?: Request): string {
  return `${publicBaseUrl(req)}${GITHUB_BASE_PATH}/webhook`;
}

/** Where GitHub returns after an install, with `installation_id` in the query. */
export function githubSetupUrl(req?: Request): string {
  const explicit = env("GITHUB_SETUP_URL");
  if (explicit) return explicit;
  return `${publicBaseUrl(req)}${GITHUB_BASE_PATH}/setup`;
}

/**
 * "Install on GitHub". The App's own setup URL (configured on the App) is where
 * GitHub returns to, so the only thing PTD adds is the signed `state` that says which
 * organization asked.
 */
export function installUrl(input: { slug: string; state: string }): string {
  return `https://github.com/apps/${encodeURIComponent(input.slug)}/installations/new?state=${encodeURIComponent(input.state)}`;
}

/** Where the browser lands after the install, with the outcome in the query string. */
export function integrationsTabUrl(outcome: string, detail?: string): string {
  const q = new URLSearchParams({ tab: "integrations", github: outcome });
  if (detail) q.set("reason", detail);
  return `/org/integrations?${q.toString()}`;
}

/** `owner/name`, lower-cased and stripped of a pasted URL or trailing `.git`. */
export function normaliseRepo(raw: string): string | null {
  const value = (raw ?? "")
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const match = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})$/.exec(value);
  if (!match) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}
