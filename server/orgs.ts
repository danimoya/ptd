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
import { invitationUrl, sendInvitationEmail } from "./email/send";
import { getOrgSecurity } from "./auth/security";
import { audit } from "./audit/log";
import { buildOrgExport, redeemExportToken } from "./export/orgExport";

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

  /**
   * The organization-wide 2FA policy, enforced at the one place every org-scoped
   * request passes through. Two deliberate exemptions:
   *
   *  - **Agent seats.** An agent cannot hold a phone. Its credential is a
   *    scoped bearer token an admin minted and can revoke, which is the control
   *    that applies to it. A *human's* API token is not exempt — `isAgent` is the
   *    test, not the auth path — so a member cannot side-step the policy by using
   *    the CLI.
   *  - **Nothing else.** Owners included: the action that turns the policy on
   *    refuses unless the caller already has 2FA, so this cannot lock out the
   *    person who set it.
   *
   * The account surface (/api/auth/**) is outside the org scope on purpose, so a
   * member who is refused here can still reach the page that fixes it.
   */
  const policy = await getOrgSecurity(row.orgId);
  if (policy.requireTotp && !ar.user[0].isAgent && !ar.user[0].totpEnabled) {
    return res.status(403).json({
      error: "totp_required",
      message:
        "This organization requires two-factor authentication. Set it up under Org → Security (or /api/auth/totp/setup) and sign in again.",
      setupPath: "/org/security",
    });
  }
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

/* ── Invitations ─────────────────────────────────────────────────────── */

/** How long an invitation stands: long enough to survive a holiday, short enough to expire. */
export const INVITATION_TTL_MS = 7 * 86_400_000;

export async function orgNameOf(orgId: number): Promise<string> {
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return org?.name ?? "your organization";
}

/**
 * Mail one invitation row.
 *
 * Exported so `invitation.resend` sends exactly the letter the original POST
 * sent — one template, one link shape, one place to change either. It cannot
 * throw: `sendLetter` reports a refusal as `{ sent: false, reason }`, so an
 * unreachable SMTP host never turns a created invitation into a 500.
 */
export function mailInvitation(invite: typeof invitations.$inferSelect, orgName: string, inviterName?: string | null) {
  return sendInvitationEmail({
    orgName,
    role: invite.role,
    email: invite.email,
    inviterName: inviterName ?? null,
    token: invite.token,
    expiresAt: invite.expiresAt,
  });
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
    audit({ orgId: org.id, userId: ar.user[0].id, label: `${ar.user[0].displayName} <${ar.user[0].email}>` }, "org.created", org.name, { slug: org.slug });
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
      .values({ orgId: r.org.id, email: req.body.email, role: req.body.role, token: randomBytes(24).toString("hex"), invitedBy: r.user[0].id, expiresAt: new Date(Date.now() + INVITATION_TTL_MS) })
      .returning();
    // The letter is a courtesy, not the mechanism: `acceptUrl` comes back either
    // way so an admin on a deployment without SMTP can paste the link themselves.
    const delivery = await mailInvitation(row, await orgNameOf(r.org.id), r.user[0].displayName);
    audit(req, "invite.created", req.body.email, { role: req.body.role, delivered: delivery.sent });
    res.status(201).json({ ...row, acceptUrl: invitationUrl(row.token), delivery });
  });

  /**
   * Public: what an invitation link is for, so `/auth?invite=…` can name the
   * organization before anyone signs in. Deliberately thin — the org's name, the
   * role offered, the address it is bound to, and whether it is still good. The
   * token is 48 hex characters, so enumeration is not a threat; guessing one is
   * the same problem as guessing a session.
   */
  app.get("/api/invitations/:token", async (req: Request, res: Response) => {
    const token = String(req.params.token ?? "");
    if (!/^[a-f0-9]{16,64}$/i.test(token)) return res.status(404).json({ error: "Invitation not found" });
    const [invite] = await db
      .select({
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        orgName: organizations.name,
      })
      .from(invitations)
      .innerJoin(organizations, eq(invitations.orgId, organizations.id))
      .where(eq(invitations.token, token))
      .limit(1);
    if (!invite) return res.status(404).json({ error: "Invitation not found" });
    res.json({
      orgName: invite.orgName,
      role: invite.role,
      email: invite.email,
      expired: invite.expiresAt < new Date(),
      accepted: invite.acceptedAt !== null,
      expiresAt: invite.expiresAt,
    });
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
    audit({ orgId: invite.orgId, userId: ar.user[0].id, label: `${ar.user[0].displayName} <${ar.user[0].email}>` }, "member.joined", ar.user[0].email, { role: invite.role });
    res.json({ orgId: invite.orgId, role: invite.role });
  });

  app.post("/api/orgs/current/invite-code", auth, resolveOrg, requireRole("admin"), validate(inviteCodeSchema), async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const [org] = await db.select({ inviteCode: organizations.inviteCode }).from(organizations).where(eq(organizations.id, r.org.id)).limit(1);
    let code = org?.inviteCode ?? null;
    if (!code || req.body.regenerate) {
      code = randomBytes(8).toString("hex");
      await db.update(organizations).set({ inviteCode: code }).where(eq(organizations.id, r.org.id));
      // Regenerating is a revocation: every agent still holding the old code is
      // locked out of self-registration, so it belongs in the audit log.
      audit(req, "invite.code_regenerated", `org:${r.org.id}`, { regenerate: req.body.regenerate === true });
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
    audit(req, "member.role_changed", `user:${targetId}`, { role: req.body.role });
    res.json(row);
  });

  /**
   * The export download. Authorised by a one-time token the `org.export` action
   * minted, because a browser cannot attach an Authorization header to a plain
   * navigation and an action result is JSON — a multi-megabyte ZIP is not. The
   * token is single-use, good for five minutes, and bound to one organization and
   * one user, whose ownership is re-checked here rather than trusted from the
   * token: a role can be taken away between minting and clicking.
   */
  app.get("/api/org/export", async (req: Request, res: Response) => {
    const token = String(req.query.token ?? "");
    if (!/^[a-f0-9]{16,96}$/i.test(token)) return res.status(400).json({ error: "bad_token" });
    const grant = redeemExportToken(token);
    if (!grant) return res.status(404).json({ error: "expired", message: "That download link has expired or has already been used." });

    const [membership] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.orgId, grant.orgId), eq(memberships.userId, grant.userId)))
      .limit(1);
    if (!membership || membership.role !== "owner") return res.status(403).json({ error: "forbidden" });

    const [user] = await db.select().from(users).where(eq(users.id, grant.userId)).limit(1);
    try {
      const archive = await buildOrgExport(grant.orgId, { email: user?.email ?? "unknown", displayName: user?.displayName ?? "unknown" });
      audit({ orgId: grant.orgId, userId: grant.userId, label: user ? `${user.displayName} <${user.email}>` : null }, "org.exported", archive.filename, archive.summary);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${archive.filename}"`);
      res.setHeader("Content-Length", String(archive.zip.length));
      res.setHeader("Cache-Control", "no-store");
      res.end(archive.zip);
    } catch (err) {
      // Express 4 does not catch a rejected async handler, and an unhandled
      // rejection ends the process — so this one owns its own failure.
      console.error("[export] could not build the archive:", err);
      res.status(500).json({ error: "export_failed", message: "The archive could not be built. The error is in the server log." });
    }
  });

  app.delete("/api/orgs/current/members/:userId", auth, resolveOrg, requireRole("admin"), async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const targetId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Bad user id" });
    if (targetId === r.user[0].id && r.org.role === "owner") return res.status(400).json({ error: "Owners cannot remove themselves" });
    const deleted = await db.delete(memberships).where(and(eq(memberships.orgId, r.org.id), eq(memberships.userId, targetId))).returning({ id: memberships.id });
    if (deleted.length === 0) return res.status(404).json({ error: "Member not found" });
    audit(req, "member.removed", `user:${targetId}`, { self: targetId === r.user[0].id });
    res.json({ removed: targetId });
  });
}
