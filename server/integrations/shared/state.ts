import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * Signed, short-lived `state` for install round-trips (Slack OAuth, GitHub App).
 *
 * The browser leaves PTD, spends a minute on a third-party consent screen and comes
 * back with no PTD session of any kind — the callback is a fresh navigation. So the
 * `state` parameter is the only thing tying the return trip to an organization, and
 * it is signed (HMAC-SHA256, keyed from PTD_SECRET_KEY) and short-lived: a stolen or
 * hand-made state cannot install an app into someone else's organization.
 *
 * `purpose` separates the key per flow, so a Slack state can never be replayed as a
 * GitHub state.
 */

export const STATE_TTL_MS = 10 * 60 * 1000;

export interface StatePayload {
  orgId: number;
  userId: number;
  nonce: string;
  exp: number;
}

function stateKey(purpose: string): Buffer {
  const raw = process.env.PTD_SECRET_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production") throw new Error("PTD_SECRET_KEY must be set in production");
    return createHash("sha256").update(`${purpose}:ptd-dev-secret-key`).digest();
  }
  return createHash("sha256").update(`${purpose}:${raw}`).digest();
}

const b64 = (value: Buffer | string): string => Buffer.from(value as never).toString("base64url");

export function signState(
  purpose: string,
  payload: Omit<StatePayload, "nonce" | "exp"> & Partial<Pick<StatePayload, "nonce" | "exp">>,
  now = Date.now(),
): string {
  const full: StatePayload = {
    orgId: payload.orgId,
    userId: payload.userId,
    nonce: payload.nonce ?? randomBytes(9).toString("base64url"),
    exp: payload.exp ?? now + STATE_TTL_MS,
  };
  const body = b64(JSON.stringify(full));
  const mac = createHmac("sha256", stateKey(purpose)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export type StateFailure = "malformed" | "bad_signature" | "expired";

export type StateCheck = { ok: true; payload: StatePayload } | { ok: false; reason: StateFailure };

export function verifyState(purpose: string, raw: string, now = Date.now()): StateCheck {
  const [body, mac] = (raw ?? "").split(".");
  if (!body || !mac) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", stateKey(purpose)).update(body).digest("base64url");
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload?.orgId !== "number" || typeof payload?.userId !== "number" || typeof payload?.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
