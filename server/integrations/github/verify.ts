import { createHmac, timingSafeEqual } from "crypto";

/**
 * GitHub webhook verification (`X-Hub-Signature-256`).
 *
 * GitHub HMACs the EXACT request body with the webhook secret and sends
 * `sha256=<hex>`. There is no timestamp in the scheme, so — unlike Slack — there is no
 * replay window to enforce; what protects against a replay is that every handler is
 * idempotent (the upsert is keyed on `externalKey`).
 *
 * The raw body comes from `../shared/rawBody`, because Express's global parsers would
 * otherwise have consumed the bytes GitHub signed.
 */

export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
export const GITHUB_EVENT_HEADER = "x-github-event";
export const GITHUB_DELIVERY_HEADER = "x-github-delivery";

export function githubSignature(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, so the length check comes first.
  return left.length === right.length && timingSafeEqual(left, right);
}

export type VerifyFailure = "no_secret" | "missing_signature" | "bad_signature";

export interface VerifyInput {
  rawBody: string;
  signature?: string | null;
  /** Candidate secrets: the deployment-wide env var, plus any per-install override. */
  secrets: (string | null | undefined)[];
}

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

export function verifyGithubRequest(input: VerifyInput): VerifyResult {
  const secrets = input.secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (secrets.length === 0) return { ok: false, reason: "no_secret" };

  const signature = (input.signature ?? "").trim();
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature)) return { ok: false, reason: "missing_signature" };

  for (const secret of secrets) {
    if (equalStrings(githubSignature(secret, input.rawBody), signature.toLowerCase())) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}

export const VERIFY_MESSAGES: Record<VerifyFailure, string> = {
  no_secret: "GITHUB_WEBHOOK_SECRET is not set on this server",
  missing_signature: "Missing or malformed X-Hub-Signature-256 header",
  bad_signature: "GitHub signature did not verify",
};
