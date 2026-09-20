import { createHmac, timingSafeEqual } from "crypto";

/**
 * Teams Outgoing Webhook verification.
 *
 * Teams sends `Authorization: HMAC <base64 HMAC-SHA256 of the raw body>`, keyed with
 * the secret it showed the team owner at creation. Two details matter and are easy to
 * get wrong:
 *
 *   - the secret is **base64** and the key is its decoded bytes, not the string;
 *   - the MAC is over the raw body bytes, which is why this path needs
 *     `../shared/rawBody` like the Slack and GitHub webhooks do.
 *
 * There is no timestamp in the scheme, so there is no replay window to enforce. Every
 * command is either a read or an idempotent write of the same shape a person could type
 * twice anyway, and a replay costs an attacker who has the secret nothing they could not
 * get by sending a fresh message.
 */

export const TEAMS_SIGNATURE_PREFIX = "HMAC ";

/** `HMAC <base64>` for a body and a base64 secret. */
export function teamsSignature(base64Secret: string, rawBody: string): string {
  const key = Buffer.from(base64Secret, "base64");
  return `${TEAMS_SIGNATURE_PREFIX}${createHmac("sha256", key).update(rawBody, "utf8").digest("base64")}`;
}

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, so the length check comes first.
  return left.length === right.length && timingSafeEqual(left, right);
}

export type VerifyFailure = "no_secret" | "missing_header" | "bad_signature";

export type VerifyResult = { ok: true; secret: string } | { ok: false; reason: VerifyFailure };

/**
 * Check the header against a set of candidate secrets and report WHICH one matched.
 *
 * That is not a nicety: a Teams Outgoing Webhook delivery says nothing about which PTD
 * organization it belongs to — no team id worth trusting, no tenant header — so the
 * secret that verifies the body *is* the tenant resolution. One secret per organization,
 * and the one that validates names the organization.
 */
export function verifyTeamsRequest(input: { rawBody: string; header?: string | null; secrets: (string | null | undefined)[] }): VerifyResult {
  const secrets = input.secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (secrets.length === 0) return { ok: false, reason: "no_secret" };

  const header = (input.header ?? "").trim();
  if (!header.toUpperCase().startsWith("HMAC ")) return { ok: false, reason: "missing_header" };
  const normalised = `${TEAMS_SIGNATURE_PREFIX}${header.slice(TEAMS_SIGNATURE_PREFIX.length).trim()}`;

  for (const secret of secrets) {
    if (equalStrings(teamsSignature(secret, input.rawBody), normalised)) return { ok: true, secret };
  }
  return { ok: false, reason: "bad_signature" };
}

export const VERIFY_MESSAGES: Record<VerifyFailure, string> = {
  no_secret: "No Teams outgoing webhook is connected to any organization on this server",
  missing_header: "Missing or malformed Authorization: HMAC header",
  bad_signature: "Teams HMAC did not verify against any connected organization's secret",
};

/** A Teams secret is base64 — reject a pasted value that cannot be one. */
export function looksLikeTeamsSecret(raw: string): boolean {
  const value = (raw ?? "").trim();
  if (value.length < 16) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) return false;
  return Buffer.from(value, "base64").length >= 12;
}
