/**
 * JWT minting for the browser session and for the short-lived tokens that stand
 * in for one, plus the one rule that keeps them apart.
 *
 * A session token carries `{ id }` and nothing else. Every other token PTD signs
 * with the same secret carries a `purpose`, and `verifySessionJwt` refuses any
 * token that has one. Without that rule the five-minute token handed out between
 * a password and a TOTP code would *be* a session — the whole point of a second
 * factor is that the first one alone opens nothing.
 */
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "dev-secret");
if (!JWT_SECRET) throw new Error("JWT_SECRET must be set in production");

export const SESSION_TTL = "7d";
/** Long enough to fetch a phone out of a pocket, short enough to be worthless later. */
export const PRE_AUTH_TTL_SECONDS = 300;

export type Purpose = "mfa";

export function signSessionJwt(userId: number): string {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: SESSION_TTL });
}

/** Throws on anything that is not a plain session token — including a purposed one. */
export function verifySessionJwt(token: string): { id: number } {
  const payload = jwt.verify(token, JWT_SECRET) as { id: number; purpose?: string };
  if (payload.purpose) throw new Error("This token is not a session token");
  if (typeof payload.id !== "number") throw new Error("Malformed session token");
  return { id: payload.id };
}

export function signPurposeJwt(userId: number, purpose: Purpose, seconds = PRE_AUTH_TTL_SECONDS): string {
  return jwt.sign({ id: userId, purpose }, JWT_SECRET, { expiresIn: seconds });
}

/** Null rather than a throw: callers answer 401 with their own wording. */
export function verifyPurposeJwt(token: string, purpose: Purpose): { id: number } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: number; purpose?: string };
    if (payload.purpose !== purpose || typeof payload.id !== "number") return null;
    return { id: payload.id };
  } catch {
    return null;
  }
}
