import express, { type Express, type Request, type RequestHandler } from "express";
import { createHmac, timingSafeEqual } from "crypto";

/**
 * Slack request verification (v0 signatures).
 *
 * Slack signs `v0:<timestamp>:<raw body>` with the app's signing secret and sends
 * the result in `X-Slack-Signature`. The signature is over the EXACT bytes, so the
 * raw body has to survive Express's global JSON/urlencoded parsers — see
 * `mountRawBodyCapture`, which is the only slightly devious thing in this adapter.
 */

export const SIGNATURE_HEADER = "x-slack-signature";
export const TIMESTAMP_HEADER = "x-slack-request-timestamp";
/** Slack's own recommendation: refuse anything older than five minutes (replay window). */
export const MAX_SKEW_SECONDS = 300;
export const SLACK_BODY_LIMIT = "256kb";

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

interface RawBodyRequest extends Request {
  rawBody?: string;
}

/** The raw request body as a string, or null when something already parsed it away. */
export function rawBodyOf(req: Request): string | null {
  const r = req as RawBodyRequest;
  if (typeof r.rawBody === "string") return r.rawBody;
  const body: unknown = (req as { body?: unknown }).body;
  if (Buffer.isBuffer(body)) {
    r.rawBody = body.toString("utf8");
    return r.rawBody;
  }
  if (typeof body === "string" && body.length > 0) {
    r.rawBody = body;
    return r.rawBody;
  }
  return null;
}

/** body-parser names its middleware, which is how we find where parsing starts. */
const PARSER_NAMES = new Set(["jsonParser", "urlencodedParser", "textParser", "rawParser"]);

interface LayerLike {
  handle?: { name?: string };
}

function routerStack(app: Express): LayerLike[] | null {
  // Express 4 keeps the app router on _router; Express 5 exposes `router`.
  const holder = app as unknown as { _router?: { stack?: unknown }; router?: { stack?: unknown } };
  const stack = holder._router?.stack ?? holder.router?.stack;
  return Array.isArray(stack) ? (stack as LayerLike[]) : null;
}

/**
 * Capture the raw body for everything under `basePath`.
 *
 * server/index.ts installs `express.json()` and `express.urlencoded()` globally
 * *before* routes are registered, and a slash command arrives as
 * `application/x-www-form-urlencoded` — so by the time a route handler runs the
 * stream is gone and the bytes Slack signed are unrecoverable. Appending another
 * parser cannot help (body-parser sets `req._body` and later parsers stand down),
 * so this moves one raw-body layer (express.raw, matching every content type) to
 * just before the first
 * body parser in the app's stack. Everything downstream then sees `req.body` as a
 * Buffer for Slack paths only, and the global parsers skip them.
 *
 * Returns where the layer ended up, which the tests assert on.
 */
export function mountRawBodyCapture(app: Express, basePath: string): "before-parsers" | "appended" {
  const raw = express.raw({ type: "*/*", limit: SLACK_BODY_LIMIT });
  const capture: RequestHandler = (req, res, next) => {
    raw(req, res, (err?: unknown) => {
      if (!err) rawBodyOf(req);
      next(err as never);
    });
  };
  Object.defineProperty(capture, "name", { value: "slackRawBodyCapture" });
  app.use(basePath, capture);

  const stack = routerStack(app);
  if (!stack || stack.length === 0) return "appended";
  const firstParser = stack.findIndex((layer) => PARSER_NAMES.has(layer?.handle?.name ?? ""));
  if (firstParser === -1 || firstParser >= stack.length - 1) return "appended";
  const layer = stack.pop();
  if (!layer) return "appended";
  stack.splice(firstParser, 0, layer);
  return "before-parsers";
}
