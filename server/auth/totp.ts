/**
 * TOTP — RFC 6238 on top of RFC 4226, with Node's `crypto` and nothing else.
 *
 * A second factor is a thirty-line algorithm and a shared secret; pulling a
 * dependency in for it would mean auditing that dependency forever. HMAC-SHA1
 * is not a preference, it is what every authenticator app implements: the
 * secret never leaves the two endpoints, the digest is truncated to six digits,
 * and SHA-1's collision weakness has no bearing on a 30-second HMAC.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 step: one step of clock drift each way, and no more — 90 seconds of validity. */
export const TOTP_WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded — what authenticator apps expect in an `otpauth://` URI. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error(`Not base32: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, the SHA-1 block-matched length RFC 4226 recommends. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** RFC 4226 §5.3: HMAC, dynamic truncation, modulo 10^digits. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpCounter(atMs: number = Date.now(), step = TOTP_STEP_SECONDS): number {
  return Math.floor(atMs / 1000 / step);
}

export function totp(secretBase32: string, atMs: number = Date.now(), step = TOTP_STEP_SECONDS, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretBase32), totpCounter(atMs, step), digits);
}

/**
 * Compare in constant time against every code in the window. Every candidate is
 * compared even after a match: an early return would leak which step matched,
 * and the loop is eight HMACs at most.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { atMs?: number; window?: number; step?: number; digits?: number } = {},
): boolean {
  const digits = opts.digits ?? TOTP_DIGITS;
  const supplied = (code ?? "").replace(/\D/g, "");
  if (supplied.length !== digits) return false;
  const secret = base32Decode(secretBase32);
  const centre = totpCounter(opts.atMs ?? Date.now(), opts.step ?? TOTP_STEP_SECONDS);
  const window = opts.window ?? TOTP_WINDOW;
  const given = Buffer.from(supplied, "utf8");
  let ok = false;
  for (let drift = -window; drift <= window; drift++) {
    const candidate = Buffer.from(hotp(secret, centre + drift, digits), "utf8");
    if (candidate.length === given.length && timingSafeEqual(candidate, given)) ok = true;
  }
  return ok;
}

/** The URI an authenticator app scans. Label and issuer are percent-encoded. */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export const RECOVERY_CODE_COUNT = 10;

/**
 * Recovery codes: ten of them, `xxxxx-xxxxx` from a 32-character alphabet with
 * the shapes that get mistyped (0/O, 1/I/L) left out. 50 bits each, which is far
 * more than a six-digit code — they are the thing that gets written on paper.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(10);
    let body = "";
    for (let j = 0; j < 10; j++) body += alphabet[bytes[j] % alphabet.length];
    codes.push(`${body.slice(0, 5)}-${body.slice(5)}`);
  }
  return codes;
}

/** Forgiving on presentation (case, spaces, the dash), exact on content. */
export function normaliseRecoveryCode(code: string): string {
  return (code ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Constant-time membership test, so a near-miss does not time differently. */
export function matchRecoveryCode(codes: string[], supplied: string): number {
  const given = Buffer.from(normaliseRecoveryCode(supplied), "utf8");
  let found = -1;
  codes.forEach((candidate, index) => {
    const buf = Buffer.from(normaliseRecoveryCode(candidate), "utf8");
    if (buf.length > 0 && buf.length === given.length && timingSafeEqual(buf, given)) found = index;
  });
  return found;
}
