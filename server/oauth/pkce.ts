/**
 * PKCE and the small amount of crypto the OAuth layer needs. Deliberately free
 * of any database or express import so the rules can be unit-tested directly.
 *
 * Two kinds of secret live here, hashed two different ways on purpose:
 *  - client secrets are salted scrypt, like api_tokens — they are looked up by
 *    client_id, so a per-row salt costs nothing;
 *  - refresh tokens are a keyed SHA-256 (HMAC), because the row has to be found
 *    *by the token*. 192 bits of entropy make the digest unguessable, and the
 *    key means a stolen table alone cannot be used to forge lookups.
 */
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCb);

export const REFRESH_PREFIX = "ptdr_";
export const CLIENT_ID_PREFIX = "ptdc_";
/** Access tokens live an hour; the client refreshes with the 30-day refresh token. */
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;

/** RFC 7636 §4.1: 43–128 characters of the unreserved set. */
const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

export function newClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomBytes(16).toString("hex")}`;
}

export function newClientSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function newRefreshToken(): string {
  return `${REFRESH_PREFIX}${randomBytes(24).toString("hex")}`;
}

export function newAuthorizationCode(): string {
  return randomBytes(32).toString("hex");
}

/** base64url(SHA-256(ascii verifier)) — the S256 transformation. */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function isValidVerifier(value: unknown): value is string {
  return typeof value === "string" && PKCE_RE.test(value);
}

export function isValidChallenge(value: unknown): value is string {
  return typeof value === "string" && PKCE_RE.test(value);
}

/** Length-independent, constant-time-per-length string compare. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) {
    // Still burn one comparison so a length mismatch is not measurably faster.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** S256 only — `plain` is not accepted, per OAuth 2.1 / MCP. */
export function verifyPkce(verifier: unknown, challenge: unknown, method = "S256"): boolean {
  if (method !== "S256") return false;
  if (!isValidVerifier(verifier) || !isValidChallenge(challenge)) return false;
  return safeEqual(s256(verifier), challenge as string);
}

function hmacKey(): Buffer {
  const raw = process.env.PTD_SECRET_KEY || process.env.JWT_SECRET;
  if (!raw) {
    if (process.env.NODE_ENV === "production") throw new Error("PTD_SECRET_KEY or JWT_SECRET must be set in production");
    return createHash("sha256").update("ptd-dev-oauth-key").digest();
  }
  return createHash("sha256").update(raw).digest();
}

/** Deterministic digest for opaque tokens we must look up by value. */
export function hashOpaque(token: string): string {
  return createHmac("sha256", hmacKey()).update(token).digest("hex");
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scrypt(secret, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

export async function verifySecret(supplied: string, stored: string): Promise<boolean> {
  const [hashedHex, salt] = String(stored).split(".");
  if (!hashedHex || !salt) return false;
  const expected = Buffer.from(hashedHex, "hex");
  const actual = (await scrypt(String(supplied), salt, 64)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
