/**
 * The three short-lived secrets an OIDC round trip needs, and where each lives.
 *
 * 1. `state` — signed, not stored: an HMAC over `{nonce, redirectTo, inviteToken}`
 *    so the callback can trust where it was told to go without a session.
 * 2. The PKCE verifier — stored, not signed: it must never travel with the
 *    request that carries its challenge, so it stays server-side keyed by nonce.
 *    The nonce entry is also what makes a state single-use.
 * 3. The handoff code — stored: the JWT itself never appears in a URL. The
 *    callback redirects with a code, and the SPA trades it for the token over
 *    POST, so no session token lands in browser history, a Referer header or an
 *    access log.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { OidcProvider } from "./providers";

const SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "dev-secret");
if (!SECRET) throw new Error("JWT_SECRET must be set in production");

export const STATE_TTL_MS = 10 * 60 * 1000;
export const HANDOFF_TTL_MS = 2 * 60 * 1000;

export interface StatePayload {
  nonce: string;
  provider: OidcProvider;
  redirectTo: string;
  inviteToken?: string;
  issuedAt: number;
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("base64url");
}

export function encodeState(payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function decodeState(raw: string): StatePayload | null {
  const [body, mac] = (raw ?? "").split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body), "utf8");
  const given = Buffer.from(mac, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
    if (!payload?.nonce || !payload.provider) return null;
    if (Date.now() - payload.issuedAt > STATE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ── PKCE + nonce single-use store ───────────────────────────────────── */

interface Pending {
  provider: OidcProvider;
  verifier: string | null;
  expiresAt: number;
}

const pending = new Map<string, Pending>();

function sweep(map: Map<string, { expiresAt: number }>) {
  const now = Date.now();
  for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
}

export interface StartedFlow {
  nonce: string;
  verifier: string | null;
  challenge: string | null;
}

/** RFC 7636: 43–128 characters of unreserved alphabet, hashed with S256. */
export function startFlow(provider: OidcProvider, usePkce: boolean): StartedFlow {
  sweep(pending);
  const nonce = randomBytes(16).toString("base64url");
  const verifier = usePkce ? randomBytes(32).toString("base64url") : null;
  pending.set(nonce, { provider, verifier, expiresAt: Date.now() + STATE_TTL_MS });
  return { nonce, verifier, challenge: verifier ? pkceChallenge(verifier) : null };
}

/** S256: the base64url of the SHA-256 of the verifier, no padding. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Single use: consuming the nonce is what stops a state from being replayed. */
export function consumeFlow(nonce: string, provider: OidcProvider): Pending | null {
  sweep(pending);
  const entry = pending.get(nonce);
  if (!entry) return null;
  pending.delete(nonce);
  if (entry.provider !== provider || entry.expiresAt <= Date.now()) return null;
  return entry;
}

/* ── Handoff codes ───────────────────────────────────────────────────── */

export interface Handoff {
  expiresAt: number;
  /** A finished session, or a 2FA challenge the SPA still has to answer. */
  payload:
    | { kind: "session"; token: string; userId: number; email: string; displayName: string; orgId: number | null; created: boolean; linked: boolean; provider: OidcProvider }
    | { kind: "mfa"; preAuthToken: string; email: string; provider: OidcProvider };
}

const handoffs = new Map<string, Handoff>();

export function mintHandoff(payload: Handoff["payload"]): string {
  sweep(handoffs);
  const code = randomBytes(24).toString("base64url");
  handoffs.set(code, { expiresAt: Date.now() + HANDOFF_TTL_MS, payload });
  return code;
}

export function redeemHandoff(code: string): Handoff["payload"] | null {
  sweep(handoffs);
  const entry = handoffs.get(code);
  if (!entry) return null;
  handoffs.delete(code);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.payload;
}

/** Test seam: the stores are process-local by design, so tests can reset them. */
export function resetOidcStores() {
  pending.clear();
  handoffs.clear();
}

/**
 * Where the SPA should land afterwards. Only ever a path inside this app: an open
 * redirector on the sign-in route is a phishing primitive, so anything absolute
 * or protocol-relative is thrown away rather than sanitised.
 *
 * Lives here rather than in ./routes so it can be reasoned about (and tested)
 * without the database the route module pulls in.
 */
export function safeRedirect(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value.slice(0, 200);
}
