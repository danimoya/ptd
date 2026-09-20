import type { Express, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { users, organizations, memberships, passwordResets } from "../db/schema";
import { validate } from "./validation";
import { authLimiter } from "./rate-limit";
import { verifyApiToken } from "./tokens";
import { hashOpaque } from "./oauth/pkce";
import { isEmailConfigured } from "./email/transport";
import { passwordResetUrl, sendPasswordResetEmail } from "./email/send";

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "dev-secret");
if (!JWT_SECRET) throw new Error("JWT_SECRET must be set in production");

export function signJwt(userId: number): string {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyJwt(token: string): { id: number } {
  return jwt.verify(token, JWT_SECRET) as { id: number };
}

/**
 * Accepts a JWT (browser session) or a ptd_… bearer token (agents, integrations).
 * Both populate req.user = [User]; the branch taken is recorded in req.authType,
 * which is the only source of truth for human-vs-agent attribution downstream.
 */
export const auth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const header = req.header("Authorization");
    if (!header || !header.startsWith("Bearer ")) return res.status(401).json({ error: "Please authenticate" });
    const raw = header.slice(7).trim();

    if (raw.startsWith("ptd_")) {
      const result = await verifyApiToken(header);
      if (!result) return res.status(401).json({ error: "Invalid API token" });
      req.user = [result.user];
      req.authType = "agent";
      req.tokenOrgId = result.orgId;
      return next();
    }

    const decoded = verifyJwt(raw);
    const rows = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    if (rows.length === 0) return res.status(401).json({ error: "User not found" });
    req.user = rows;
    req.authType = rows[0].isAgent ? "agent" : "human";
    next();
  } catch {
    res.status(401).json({ error: "Please authenticate" });
  }
};

export function slugify(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "org";
}

export async function createOrganization(name: string, ownerId: number) {
  const slug = `${slugify(name)}-${randomBytes(2).toString("hex")}`;
  const plan = process.env.PTD_HOSTED === "1" ? "free" : "self_hosted";
  const [org] = await db
    .insert(organizations)
    .values({ name, slug, plan, inviteCode: randomBytes(8).toString("hex") })
    .returning();
  await db.insert(memberships).values({ orgId: org.id, userId: ownerId, role: "owner" });
  return org;
}

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(255),
  displayName: z.string().min(1).max(120).optional(),
  orgName: z.string().min(1).max(255).optional(),
});
const loginSchema = z.object({ email: z.string().email().max(255), password: z.string().min(1).max(255) });
const forgotSchema = z.object({ email: z.string().email().max(255) });
const resetSchema = z.object({ token: z.string().min(16).max(128), password: z.string().min(8).max(255) });

function safeUser(u: typeof users.$inferSelect) {
  const { passwordHash: _pw, ...rest } = u;
  return rest;
}

/* ── Password reset ──────────────────────────────────────────────────── */

/**
 * Thirty minutes. A reset link is a bearer credential for the whole account, and
 * it arrives in a medium the account holder does not control end to end — an
 * inbox on a shared laptop, a mailing list that archives, a corporate scanner
 * that follows links. Long enough to read your mail, short enough that a stale
 * copy is worthless.
 */
export const RESET_TTL_MS = 30 * 60 * 1000;
export const RESET_TTL_MINUTES = RESET_TTL_MS / 60_000;

/** bcrypt work factor, the same one `register` uses. Changed in one place or not at all. */
const BCRYPT_ROUNDS = 12;

/**
 * Mint a reset token for one account and store only its keyed digest, so a
 * database dump cannot be replayed as a pile of reset links.
 */
export async function issuePasswordReset(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await db.insert(passwordResets).values({ userId, tokenHash: hashOpaque(token), expiresAt });
  return { token, expiresAt };
}

export type ResetOutcome =
  | { ok: true; userId: number; email: string; displayName: string }
  | { ok: false; reason: "unknown" | "used" | "expired" };

/**
 * Redeem a reset token: set the new password, stamp the token, and stamp every
 * other outstanding token for that account in the same statement — if a link was
 * forwarded or a second reset was requested "just in case", neither survives the
 * password actually changing.
 */
export async function redeemPasswordReset(token: string, password: string): Promise<ResetOutcome> {
  const [row] = await db.select().from(passwordResets).where(eq(passwordResets.tokenHash, hashOpaque(token))).limit(1);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt < new Date()) return { ok: false, reason: "expired" };
  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user) return { ok: false, reason: "unknown" };

  await db.update(users).set({ passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) }).where(eq(users.id, user.id));
  await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
  return { ok: true, userId: user.id, email: user.email, displayName: user.displayName };
}

export function registerAuthRoutes(app: Express) {
  app.post("/api/auth/register", authLimiter, validate(registerSchema), async (req: Request, res: Response) => {
    const { email, password, displayName, orgName } = req.body as z.infer<typeof registerSchema>;
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) return res.status(400).json({ error: "Email already registered" });
    const name = displayName?.trim() || email.split("@")[0];
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash: await bcrypt.hash(password, 12), displayName: name })
      .returning();
    const org = await createOrganization(orgName?.trim() || `${name}'s organization`, user.id);
    res.status(201).json({ user: safeUser(user), org: { id: org.id, name: org.name, slug: org.slug, role: "owner" }, token: signJwt(user.id) });
  });

  app.post("/api/auth/login", authLimiter, validate(loginSchema), async (req: Request, res: Response) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    res.json({ user: safeUser(user), token: signJwt(user.id) });
  });

  /**
   * Ask for a reset link. Always 200, always the same body: whether an address
   * has an account is not something an unauthenticated caller gets to learn, and
   * a 404 here would turn this endpoint into an account-enumeration oracle.
   * Rate-limited with the rest of the auth surface, because "always 200" would
   * otherwise make it a free mail cannon.
   */
  app.post("/api/auth/forgot", authLimiter, validate(forgotSchema), async (req: Request, res: Response) => {
    const { email } = req.body as z.infer<typeof forgotSchema>;
    const answer: Record<string, unknown> = { ok: true, message: "If that address has an account, a reset link is on its way." };
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    // An agent seat has a random password and no mailbox: a reset link for one
    // would be a way in with no way to receive it. Treated as "no account".
    if (user && !user.isAgent) {
      const { token } = await issuePasswordReset(user.id);
      const delivery = await sendPasswordResetEmail({
        email: user.email,
        displayName: user.displayName,
        token,
        expiresMinutes: RESET_TTL_MINUTES,
      });
      // With no SMTP the link would be unreachable, so it goes to the operator:
      // the server log always, and the response only outside production. Neither
      // path leaks anything to a stranger — the log is the operator's, and a
      // development deployment has no third parties.
      if (!delivery.sent) {
        const link = passwordResetUrl(token);
        if (!isEmailConfigured()) {
          console.log(`[auth] no SMTP configured — password reset link for ${user.email}: ${link}`);
          if (process.env.NODE_ENV !== "production") answer.resetUrl = link;
        }
      }
    }
    res.json(answer);
  });

  /** Redeem a reset token. Single use; sets the password and signs the caller in. */
  app.post("/api/auth/reset", authLimiter, validate(resetSchema), async (req: Request, res: Response) => {
    const { token, password } = req.body as z.infer<typeof resetSchema>;
    const outcome = await redeemPasswordReset(token, password);
    if (!outcome.ok) {
      const message =
        outcome.reason === "expired"
          ? "That reset link has expired — ask for a new one."
          : outcome.reason === "used"
            ? "That reset link has already been used — ask for a new one."
            : "That reset link is not valid.";
      return res.status(400).json({ error: message, reason: outcome.reason });
    }
    const [user] = await db.select().from(users).where(eq(users.id, outcome.userId)).limit(1);
    res.json({ ok: true, user: user ? safeUser(user) : undefined, token: signJwt(outcome.userId) });
  });

  app.get("/api/auth/me", auth, async (req: Request, res: Response) => {
    const user = req.user![0];
    const orgs = await db
      .select({ orgId: organizations.id, name: organizations.name, slug: organizations.slug, plan: organizations.plan, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.orgId, organizations.id))
      .where(eq(memberships.userId, user.id))
      .orderBy(memberships.createdAt);
    res.json({ user: safeUser(user), authType: req.authType, orgs });
  });
}
