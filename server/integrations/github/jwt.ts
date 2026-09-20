import { createSign } from "crypto";

/**
 * The GitHub App's own credential: an RS256 JWT signed with the App's private key.
 *
 * Written against Node's `crypto` rather than `jsonwebtoken` — not because the
 * dependency is unavailable, but because this is nine lines of signing and PTD's
 * package.json is frozen for this work. The JWT authenticates the *App* (`/app/…`
 * endpoints, minting installation tokens); every call that touches a repository uses
 * an installation access token instead.
 *
 * GitHub's rules: RS256, `iss` = the App id, at most ten minutes of life, and clocks
 * that are allowed to disagree — hence backdating `iat` by a minute.
 */

export const JWT_TTL_SECONDS = 9 * 60;
const CLOCK_SKEW_SECONDS = 60;

const b64url = (value: string | Buffer): string => Buffer.from(value as never).toString("base64url");

export interface AppJwtClaims {
  iat: number;
  exp: number;
  iss: string;
}

export function appJwtClaims(appId: string, now = Date.now()): AppJwtClaims {
  const seconds = Math.floor(now / 1000);
  return { iat: seconds - CLOCK_SKEW_SECONDS, exp: seconds + JWT_TTL_SECONDS, iss: appId };
}

/**
 * `<base64url header>.<base64url claims>.<base64url signature>`.
 *
 * Throws when the key is not a usable PEM — the caller (always a route or an action)
 * turns that into "GitHub app not configured on this server", because a broken key is
 * a deployment mistake and not something to retry.
 */
export function signAppJwt(input: { appId: string; privateKey: string }, now = Date.now()): string {
  if (!input.appId) throw new Error("GITHUB_APP_ID is not set");
  if (!input.privateKey) throw new Error("GITHUB_APP_PRIVATE_KEY is not set or is not a PEM");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify(appJwtClaims(input.appId, now)));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  const signature = signer.sign(input.privateKey).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

/** Decode the claims of a JWT this module produced (tests and diagnostics). */
export function decodeJwtClaims(token: string): AppJwtClaims | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as AppJwtClaims;
  } catch {
    return null;
  }
}
