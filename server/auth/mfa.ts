/**
 * The second factor, as it touches the database.
 *
 * Three columns on `users`: the sealed TOTP secret, whether it is live, and the
 * sealed recovery codes. Sealed means AES-256-GCM under `PTD_SECRET_KEY` — the
 * same treatment integration credentials get, and for the same reason: a secret
 * that can be replayed from a database dump is not a second factor.
 *
 * Setup is two steps on purpose. `beginTotpSetup` writes the secret with
 * `totpEnabled` still false, so a half-finished enrolment (scanned the code,
 * closed the tab) locks nobody out; only `completeTotpSetup`, which needs a code
 * the authenticator actually produced, flips the flag.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users, type User } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../crypto";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  matchRecoveryCode,
  otpauthUri,
  verifyTotp,
  RECOVERY_CODE_COUNT,
} from "./totp";
import { qrSvg } from "./qr";

export const TOTP_ISSUER = process.env.PTD_TOTP_ISSUER || "PTD";

export interface TotpEnrolment {
  secret: string;
  uri: string;
  qrSvg: string;
  digits: number;
  period: number;
}

function safeUnseal(sealed: string | null): string | null {
  if (!sealed) return null;
  try {
    return decryptSecret(sealed);
  } catch {
    // A rotated PTD_SECRET_KEY leaves undecryptable ciphertext. Treated as "no
    // secret": the member re-enrols rather than being locked out by a key change.
    return null;
  }
}

export async function beginTotpSetup(user: User): Promise<TotpEnrolment> {
  const secret = generateTotpSecret();
  await db.update(users).set({ totpSecretSealed: encryptSecret(secret) }).where(eq(users.id, user.id));
  const uri = otpauthUri({ issuer: TOTP_ISSUER, account: user.email, secret });
  return { secret, uri, qrSvg: qrSvg(uri, { level: "M", title: "TOTP enrolment" }), digits: 6, period: 30 };
}

export interface CompleteResult {
  ok: boolean;
  reason?: "no_secret" | "bad_code" | "already_enabled";
  recoveryCodes?: string[];
}

export async function completeTotpSetup(user: User, code: string): Promise<CompleteResult> {
  if (user.totpEnabled) return { ok: false, reason: "already_enabled" };
  const secret = safeUnseal(user.totpSecretSealed);
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!verifyTotp(secret, code)) return { ok: false, reason: "bad_code" };
  const recoveryCodes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  await db
    .update(users)
    .set({ totpEnabled: true, recoveryCodesSealed: encryptSecret(JSON.stringify(recoveryCodes)) })
    .where(eq(users.id, user.id));
  return { ok: true, recoveryCodes };
}

/** Verify a live code against the enabled secret. False whenever anything is missing. */
export function verifyUserTotp(user: User, code: string): boolean {
  const secret = safeUnseal(user.totpSecretSealed);
  if (!secret) return false;
  return verifyTotp(secret, code);
}

export function remainingRecoveryCodes(user: User): number {
  const raw = safeUnseal(user.recoveryCodesSealed);
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Spend one recovery code. Single use: the list is rewritten without it before
 * this returns, so the same slip of paper never opens the door twice.
 */
export async function consumeRecoveryCode(user: User, supplied: string): Promise<boolean> {
  const raw = safeUnseal(user.recoveryCodesSealed);
  if (!raw) return false;
  let codes: string[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return false;
    codes = parsed.map(String);
  } catch {
    return false;
  }
  const index = matchRecoveryCode(codes, supplied);
  if (index < 0) return false;
  const left = codes.filter((_, i) => i !== index);
  await db
    .update(users)
    .set({ recoveryCodesSealed: left.length > 0 ? encryptSecret(JSON.stringify(left)) : null })
    .where(eq(users.id, user.id));
  return true;
}

export async function regenerateRecoveryCodes(user: User): Promise<string[]> {
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  await db.update(users).set({ recoveryCodesSealed: encryptSecret(JSON.stringify(codes)) }).where(eq(users.id, user.id));
  return codes;
}

/** Turning 2FA off needs a live code: a stolen session must not be able to do it. */
export async function disableTotp(user: User, code: string): Promise<{ ok: boolean; reason?: "not_enabled" | "bad_code" }> {
  if (!user.totpEnabled) return { ok: false, reason: "not_enabled" };
  const live = verifyUserTotp(user, code);
  const viaRecovery = live ? false : await consumeRecoveryCode(user, code);
  if (!live && !viaRecovery) return { ok: false, reason: "bad_code" };
  await db
    .update(users)
    .set({ totpEnabled: false, totpSecretSealed: null, recoveryCodesSealed: null })
    .where(eq(users.id, user.id));
  return { ok: true };
}

export async function reloadUser(userId: number): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}
