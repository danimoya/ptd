/**
 * The 2FA surface. Enrolment and the step-up that finishes a sign-in.
 *
 *   POST /api/auth/totp/setup           a fresh secret, its URI and a QR (session)
 *   POST /api/auth/totp/verify          a code from the app turns 2FA on (session)
 *   POST /api/auth/totp/disable         a code turns it off again (session)
 *   POST /api/auth/totp/recovery-codes  a code mints ten new ones (session)
 *   POST /api/auth/totp/login           pre-auth token + code → the real session
 *   GET  /api/auth/security             this account's second-factor state
 *
 * Everything here is deliberately *outside* the organization scope. An
 * organization that requires 2FA answers 403 on org-scoped calls until the member
 * has it — so the very page they are sent to must not need the thing it exists to
 * set up.
 */
import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { memberships, organizations, users } from "../../db/schema";
import { auth } from "../auth";
import { authLimiter } from "../rate-limit";
import { validate } from "../validation";
import { audit } from "../audit/log";
import { configuredProviders } from "../oidc/providers";
import { listIdentities, unlinkIdentity } from "../oidc/link";
import { getOrgSecurity } from "./security";
import { signSessionJwt, verifyPurposeJwt } from "./jwt";
import {
  beginTotpSetup,
  completeTotpSetup,
  consumeRecoveryCode,
  disableTotp,
  regenerateRecoveryCodes,
  reloadUser,
  remainingRecoveryCodes,
  verifyUserTotp,
} from "./mfa";

const codeSchema = z.object({ code: z.string().min(6).max(24) });
const loginSchema = z
  .object({
    preAuthToken: z.string().min(16).max(2000),
    code: z.string().min(6).max(12).optional(),
    recoveryCode: z.string().min(8).max(24).optional(),
  })
  .refine((d) => Boolean(d.code || d.recoveryCode), { message: "Send either code or recoveryCode", path: ["code"] });

/**
 * Five wrong answers in five minutes and this account's step-up stops accepting
 * any, pre-auth token or not. A six-digit code inside a 90-second window is
 * 1-in-a-million per try; the IP rate limit alone would let a botnet grind at it.
 */
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const attempts = new Map<number, { count: number; first: number }>();

function tooManyAttempts(userId: number): boolean {
  const row = attempts.get(userId);
  if (!row) return false;
  if (Date.now() - row.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(userId);
    return false;
  }
  return row.count >= MAX_ATTEMPTS;
}

function noteFailure(userId: number) {
  const row = attempts.get(userId);
  if (!row || Date.now() - row.first > ATTEMPT_WINDOW_MS) attempts.set(userId, { count: 1, first: Date.now() });
  else row.count++;
}

export function clearMfaAttempts(userId?: number) {
  if (userId === undefined) attempts.clear();
  else attempts.delete(userId);
}

function safeUser(u: typeof users.$inferSelect) {
  const { passwordHash: _pw, totpSecretSealed: _s, recoveryCodesSealed: _r, ...rest } = u;
  return rest;
}

export function registerTotpRoutes(app: Express) {
  app.get("/api/auth/security", auth, async (req: Request, res: Response) => {
    const user = req.user![0];
    const rows = await db
      .select({ orgId: memberships.orgId, name: organizations.name, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.orgId, organizations.id))
      .where(eq(memberships.userId, user.id))
      .orderBy(memberships.createdAt);
    const orgs = await Promise.all(
      rows.map(async (row) => ({ ...row, requireTotp: (await getOrgSecurity(row.orgId)).requireTotp })),
    );
    res.json({
      totpEnabled: user.totpEnabled,
      setupStarted: Boolean(user.totpSecretSealed) && !user.totpEnabled,
      recoveryCodesLeft: remainingRecoveryCodes(user),
      identities: await listIdentities(user.id),
      providers: configuredProviders(),
      orgs,
      // True when at least one of this account's organizations will refuse it.
      blocked: orgs.some((o) => o.requireTotp) && !user.totpEnabled,
    });
  });

  app.post("/api/auth/totp/setup", authLimiter, auth, async (req: Request, res: Response) => {
    const user = req.user![0];
    if (user.isAgent) return res.status(400).json({ error: "agent_account", message: "An agent seat authenticates with a token, not a code." });
    if (user.totpEnabled) {
      return res.status(409).json({ error: "already_enabled", message: "Two-factor authentication is already on. Turn it off first to enrol a new device." });
    }
    const enrolment = await beginTotpSetup(user);
    res.json({ ...enrolment, account: user.email });
  });

  app.post("/api/auth/totp/verify", authLimiter, auth, validate(codeSchema), async (req: Request, res: Response) => {
    const user = req.user![0];
    const outcome = await completeTotpSetup(user, req.body.code);
    if (!outcome.ok) {
      const message =
        outcome.reason === "no_secret"
          ? "No enrolment in progress — start again from the Security tab."
          : outcome.reason === "already_enabled"
            ? "Two-factor authentication is already on."
            : "That code is not right. Check the clock on your phone and try the next one.";
      return res.status(400).json({ error: outcome.reason, message });
    }
    audit(req, "totp.enabled", user.email, { recoveryCodes: outcome.recoveryCodes?.length ?? 0 });
    res.json({ enabled: true, recoveryCodes: outcome.recoveryCodes, shownOnce: true });
  });

  app.post("/api/auth/totp/disable", authLimiter, auth, validate(codeSchema), async (req: Request, res: Response) => {
    const user = req.user![0];
    const outcome = await disableTotp(user, req.body.code);
    if (!outcome.ok) {
      return res.status(400).json({
        error: outcome.reason,
        message: outcome.reason === "not_enabled" ? "Two-factor authentication is not on." : "That code is not right.",
      });
    }
    clearMfaAttempts(user.id);
    audit(req, "totp.disabled", user.email);
    res.json({ enabled: false });
  });

  app.post("/api/auth/totp/recovery-codes", authLimiter, auth, validate(codeSchema), async (req: Request, res: Response) => {
    const user = req.user![0];
    if (!user.totpEnabled) return res.status(400).json({ error: "not_enabled", message: "Turn two-factor authentication on first." });
    if (!verifyUserTotp(user, req.body.code)) return res.status(400).json({ error: "bad_code", message: "That code is not right." });
    const codes = await regenerateRecoveryCodes(user);
    audit(req, "totp.recovery_regenerated", user.email, { count: codes.length });
    res.json({ recoveryCodes: codes, shownOnce: true });
  });

  /** Step two of a sign-in: the pre-auth token plus a code, for the real session. */
  app.post("/api/auth/totp/login", authLimiter, validate(loginSchema), async (req: Request, res: Response) => {
    const { preAuthToken, code, recoveryCode } = req.body as z.infer<typeof loginSchema>;
    const claim = verifyPurposeJwt(preAuthToken, "mfa");
    if (!claim) {
      return res.status(401).json({ error: "expired", message: "That sign-in took too long — enter your password again." });
    }
    const user = await reloadUser(claim.id);
    if (!user || !user.totpEnabled) return res.status(401).json({ error: "invalid", message: "That sign-in is no longer valid." });
    if (tooManyAttempts(user.id)) {
      return res.status(429).json({ error: "too_many_attempts", message: "Too many wrong codes. Wait five minutes and try again." });
    }

    const usedRecovery = Boolean(recoveryCode);
    const ok = usedRecovery ? await consumeRecoveryCode(user, recoveryCode!) : verifyUserTotp(user, code!);
    if (!ok) {
      noteFailure(user.id);
      audit({ userId: user.id, label: `${user.displayName} <${user.email}>` }, "auth.mfa_failed", user.email, { usedRecovery });
      return res.status(401).json({ error: "bad_code", message: usedRecovery ? "That recovery code is not valid, or has been used." : "That code is not right." });
    }

    clearMfaAttempts(user.id);
    // Re-read after spending a recovery code: the count the client shows ("two
    // left") has to be the count after this sign-in, not before it.
    const after = usedRecovery ? ((await reloadUser(user.id)) ?? user) : user;
    const left = remainingRecoveryCodes(after);
    if (usedRecovery) audit({ userId: user.id, label: `${user.displayName} <${user.email}>` }, "auth.recovery_code_used", user.email, { remaining: left });
    audit({ userId: user.id, label: `${user.displayName} <${user.email}>` }, "auth.mfa_success", user.email, { usedRecovery });
    res.json({
      token: signSessionJwt(user.id),
      user: safeUser(user),
      usedRecoveryCode: usedRecovery,
      recoveryCodesLeft: left,
    });
  });

  /**
   * Unlink a provider, outside the org scope for the same reason as the rest of
   * this file. The last one needs `confirm`, because an account created through a
   * provider has a password nobody knows — dropping its only identity means
   * going through "forgot password" to get back in.
   */
  app.delete("/api/auth/identities/:id", auth, async (req: Request, res: Response) => {
    const user = req.user![0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "bad_id" });
    const all = await listIdentities(user.id);
    if (!all.some((i) => i.id === id)) return res.status(404).json({ error: "not_found", message: "No such linked account." });
    if (all.length === 1 && req.query.confirm !== "1") {
      return res.status(409).json({
        error: "last_identity",
        message:
          "This is the only provider linked to your account. Unlinking it leaves the password as your only way in — set one with “Forgot password” first, or repeat with confirm=1.",
      });
    }
    const removed = await unlinkIdentity(user.id, id);
    audit(req, "oidc.unlinked", user.email, { provider: removed?.provider });
    res.json({ unlinked: id, provider: removed?.provider });
  });
}
