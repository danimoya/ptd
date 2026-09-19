import type { Express, Request, Response, NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { z } from "zod";
import { db } from "../db";
import { organizations, memberships, invitations, users, ROLES, type Role } from "../db/schema";
import { auth, createOrganization } from "./auth";
import { validate } from "./validation";
import { hasRole, isRole, type AuthenticatedRequest, type OrgRequest } from "./types";
import { assertWithinPlan } from "./billing/limits";
import { ActionError } from "./actions/registry";

/**
 * Binds req.org = {id, role}. Order of precedence: X-Org-Id header, ?orgId,
 * the org a ptd_ token was minted for, else the caller's oldest membership.
 */
export async function resolveOrg(req: Request, res: Response, next: NextFunction) {
  const ar = req as AuthenticatedRequest;
  if (!ar.user?.[0]) return res.status(401).json({ error: "Unauthenticated" });
  const userId = ar.user[0].id;
  const raw = req.header("X-Org-Id") || (req.query.orgId as string | undefined) || (req.tokenOrgId ? String(req.tokenOrgId) : undefined);

  let row;
  if (raw) {
    const orgId = parseInt(raw, 10);
    if (!Number.isFinite(orgId)) return res.status(400).json({ error: "Invalid org id" });
    [row] = await db.select().from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId))).limit(1);
    if (!row) return res.status(403).json({ error: "Not a member of this organization" });
  } else {
    [row] = await db.select().from(memberships).where(eq(memberships.userId, userId)).orderBy(memberships.createdAt).limit(1);
    if (!row) return res.status(409).json({ error: "No organization bound to this account yet" });
  }
  req.org = { id: row.orgId, role: (isRole(row.role) ? row.role : "member") as Role };
  next();
}

export function requireRole(min: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = req as OrgRequest;
    if (!r.org) return res.status(403).json({ error: "No organization context" });
    if (!hasRole(r.org.role, min)) return res.status(403).json({ error: "Insufficient permissions" });
    next();
  };
}

const createOrgSchema = z.object({ name: z.string().min(1).max(255) });
const inviteSchema = z.object({ email: z.string().email().max(255), role: z.enum(["admin", "manager", "member"]) });
const roleSchema = z.object({ role: z.enum(ROLES) });
const acceptSchema = z.object({ token: z.string().min(8).max(64) });
const inviteCodeSchema = z.object({ regenerate: z.boolean().optional() });

export function registerOrgRoutes(app: Express) {
  app.get("/api/orgs", auth, async (req: Request, res: Response) => {
    const ar = req as AuthenticatedRequest;
    const rows = await db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, plan: organizations.plan, role: memberships.role, createdAt: organizations.createdAt })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.orgId, organizations.id))
      .where(eq(memberships.userId, ar.user[0].id))
      .orderBy(organizations.createdAt);
    res.json(rows);
  });

  app.post("/api/orgs", auth, validate(createOrgSchema), async (req: Request, res: Response) => {
    const ar = req as AuthenticatedRequest;
    const org = await createOrganization(req.body.name, ar.user[0].id);
    res.status(201).json({ ...org, role: "owner" });
  });

  app.get("/api/orgs/current", auth, resolveOrg, async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const [org] = await db.select().from(organizations).where(eq(organizations.id, r.org.id)).limit(1);
    if (!org) return res.status(404).json({ error: "Organization not found" });
    const { inviteCode, ...rest } = org;
    res.json({ ...rest, role: r.org.role, inviteCode: hasRole(r.org.role, "admin") ? inviteCode : undefined });
  });

  app.get("/api/orgs/current/members", auth, resolveOrg, async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const rows = await db
      .select({ userId: memberships.userId, role: memberships.role, email: users.email, displayName: users.displayName, isAgent: users.isAgent, joinedAt: memberships.createdAt })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.orgId, r.org.id))
      .orderBy(memberships.createdAt);
    res.json(rows);
  });

  app.post("/api/orgs/current/invitations", auth, resolveOrg, requireRole("admin"), validate(inviteSchema), async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const [row] = await db
      .insert(invitations)
      .values({ orgId: r.org.id, email: req.body.email, role: req.body.role, token: randomBytes(24).toString("hex"), invitedBy: r.user[0].id, expiresAt: new Date(Date.now() + 7 * 86_400_000) })
      .returning();
    res.status(201).json(row);
  });

  app.get("/api/orgs/current/invitations", auth, resolveOrg, requireRole("admin"), async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    res.json(await db.select().from(invitations).where(eq(invitations.orgId, r.org.id)).orderBy(invitations.createdAt));
  });

  app.post("/api/invitations/accept", auth, validate(acceptSchema), async (req: Request, res: Response) => {
    const ar = req as AuthenticatedRequest;
    const [invite] = await db.select().from(invitations).where(eq(invitations.token, req.body.token)).limit(1);
    if (!invite) return res.status(404).json({ error: "Invitation not found" });
    if (invite.acceptedAt) return res.status(400).json({ error: "Already accepted" });
    if (invite.expiresAt < new Date()) return res.status(400).json({ error: "Invitation expired" });
    if (invite.email.toLowerCase() !== ar.user[0].email.toLowerCase()) return res.status(403).json({ error: "Invitation email does not match" });
    const existing = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.orgId, invite.orgId), eq(memberships.userId, ar.user[0].id))).limit(1);
    if (existing.length === 0) {
      try {
        await assertWithinPlan(invite.orgId, "member");
      } catch (err) {
        if (err instanceof ActionError) return res.status(403).json({ error: "plan_limit", message: err.message });
        throw err;
      }
      await db.insert(memberships).values({ orgId: invite.orgId, userId: ar.user[0].id, role: invite.role, invitedBy: invite.invitedBy });
    }
    await db.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invite.id));
    res.json({ orgId: invite.orgId, role: invite.role });
  });

  app.post("/api/orgs/current/invite-code", auth, resolveOrg, requireRole("admin"), validate(inviteCodeSchema), async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const [org] = await db.select({ inviteCode: organizations.inviteCode }).from(organizations).where(eq(organizations.id, r.org.id)).limit(1);
    let code = org?.inviteCode ?? null;
    if (!code || req.body.regenerate) {
      code = randomBytes(8).toString("hex");
      await db.update(organizations).set({ inviteCode: code }).where(eq(organizations.id, r.org.id));
    }
    res.json({ inviteCode: code });
  });

  app.patch("/api/orgs/current/members/:userId", auth, resolveOrg, requireRole("owner"), validate(roleSchema), async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const targetId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Bad user id" });
    const [row] = await db.update(memberships).set({ role: req.body.role })
      .where(and(eq(memberships.orgId, r.org.id), eq(memberships.userId, targetId))).returning();
    if (!row) return res.status(404).json({ error: "Member not found" });
    res.json(row);
  });

  app.delete("/api/orgs/current/members/:userId", auth, resolveOrg, requireRole("admin"), async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const targetId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Bad user id" });
    if (targetId === r.user[0].id && r.org.role === "owner") return res.status(400).json({ error: "Owners cannot remove themselves" });
    const deleted = await db.delete(memberships).where(and(eq(memberships.orgId, r.org.id), eq(memberships.userId, targetId))).returning({ id: memberships.id });
    if (deleted.length === 0) return res.status(404).json({ error: "Member not found" });
    res.json({ removed: targetId });
  });
}
