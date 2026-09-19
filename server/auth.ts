import type { Express, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { users, organizations, memberships } from "../db/schema";
import { validate } from "./validation";
import { authLimiter } from "./rate-limit";
import { verifyApiToken } from "./tokens";

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

function safeUser(u: typeof users.$inferSelect) {
  const { passwordHash: _pw, ...rest } = u;
  return rest;
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
