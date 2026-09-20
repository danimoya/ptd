import type { Express } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { RAW_BODY_LIMIT } from "../shared/rawBody";

/**
 * Slack request verification (v0 signatures).
 *
 * Slack signs `v0:<timestamp>:<raw body>` with the app's signing secret and sends
 * the result in `X-Slack-Signature`. The signature is over the EXACT bytes, so the
 * raw body has to survive Express's global JSON/urlencoded parsers — see
 * `mountRawBodyCapture` in `../shared/rawBody`, which GitHub and Teams need for the
 * same reason and which this module re-exports for the adapter's own use.
 */

export const SIGNATURE_HEADER = "x-slack-signature";
export const TIMESTAMP_HEADER = "x-slack-request-timestamp";
/** Slack's own recommendation: refuse anything older than five minutes (replay window). */
export const MAX_SKEW_SECONDS = 300;
export const SLACK_BODY_LIMIT = RAW_BODY_LIMIT;

export function slackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex")}`;
}

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, so the length check comes first.
  return left.length === right.length && timingSafeEqual(left, right);
}

export type VerifyFailure = "no_secret" | "missing_headers" | "stale_timestamp" | "bad_signature";

export interface VerifyInput {
  rawBody: string;
  timestamp?: string | null;
  signature?: string | null;
  /** Candidate signing secrets: the app-level env var, plus any per-install override. */
  secrets: (string | null | undefined)[];
  nowMs?: number;
  maxSkewSeconds?: number;
}

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

export function verifySlackRequest(input: VerifyInput): VerifyResult {
  const secrets = input.secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (secrets.length === 0) return { ok: false, reason: "no_secret" };

  const timestamp = (input.timestamp ?? "").trim();
  const signature = (input.signature ?? "").trim();
  if (!/^\d{1,12}$/.test(timestamp) || !signature.startsWith("v0=")) return { ok: false, reason: "missing_headers" };

  const now = input.nowMs ?? Date.now();
  const skew = Math.abs(now / 1000 - Number(timestamp));
  if (skew > (input.maxSkewSeconds ?? MAX_SKEW_SECONDS)) return { ok: false, reason: "stale_timestamp" };

  for (const secret of secrets) {
    if (equalStrings(slackSignature(secret, timestamp, input.rawBody), signature)) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}

export const VERIFY_MESSAGES: Record<VerifyFailure, string> = {
  no_secret: "SLACK_SIGNING_SECRET is not set on this server",
  missing_headers: "Missing or malformed Slack signature headers",
  stale_timestamp: "Slack request timestamp is outside the 5 minute window",
  bad_signature: "Slack signature did not verify",
};

/* ── Raw body ─────────────────────────────────────────────────────────── */

/**
 * The raw-body capture moved to `../shared/rawBody` when GitHub (X-Hub-Signature-256)
 * and Teams (Authorization: HMAC …) turned out to need exactly the same trick. The
 * layer is named `slackRawBodyCapture` here so a router-stack dump still says which
 * adapter asked for it.
 */
export { RAW_BODY_LIMIT, rawBodyOf } from "../shared/rawBody";
import { mountRawBodyCapture as mountShared } from "../shared/rawBody";

export function mountRawBodyCapture(app: Express, basePath: string): "before-parsers" | "appended" {
  return mountShared(app, basePath, "slackRawBodyCapture");
}
