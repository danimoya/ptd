import type { Express, Request, Response } from "express";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { users, organizations, memberships } from "../db/schema";
import { createOrganization, slugify } from "./auth";
import { mintToken } from "./tokens";
import { authLimiter } from "./rate-limit";
import { buildManifest } from "./discovery";
import { assertWithinPlan } from "./billing/limits";
import { syncSeatQuantity } from "./billing/service";
import { ActionError } from "./actions/registry";
import { audit } from "./audit/log";

const schema = z
  .object({
    name: z.string().min(1).max(80),
    email: z.string().email().max(255).optional(),
    orgName: z.string().min(1).max(255).optional(),
    inviteCode: z.string().min(4).max(64).optional(),
  })
  .refine((d) => !(d.inviteCode && d.orgName), { message: "inviteCode and orgName are mutually exclusive", path: ["orgName"] });

/**
 * POST /api/agent/register — public. Creates an agent seat (users.is_agent)
 * plus either a new org (owner) or a membership in the org that owns the
 * invite code (member). Returns the bearer token exactly once.
 */
export function registerAgentSignup(app: Express) {
  app.post("/api/agent/register", authLimiter, async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", message: parsed.error.issues.map((i) => i.message).join(", ") });
    }
    const { name, email, orgName, inviteCode } = parsed.data;
    const agentEmail = email ?? `agent_${slugify(name).replace(/-/g, "_")}_${randomBytes(3).toString("hex")}@agents.ptd.local`;
    const taken = await db.select({ id: users.id }).from(users).where(eq(users.email, agentEmail)).limit(1);
    if (taken.length > 0) return res.status(409).json({ error: "email_taken", message: "Email already registered" });

    let orgId: number;
    let role: string;
    let orgLabel: string;
    if (inviteCode) {
      const [org] = await db.select().from(organizations).where(eq(organizations.inviteCode, inviteCode)).limit(1);
      if (!org) return res.status(404).json({ error: "invalid_invite_code", message: "No organization matches that invite code" });
      orgId = org.id; role = "member"; orgLabel = org.name;
      try {
        await assertWithinPlan(orgId, "agent");
      } catch (err) {
        if (err instanceof ActionError) return res.status(403).json({ error: "plan_limit", message: err.message });
        throw err;
      }
    } else {
      orgId = -1; role = "owner"; orgLabel = orgName?.trim() || `${name} organization`;
    }

    const [user] = await db
      .insert(users)
      .values({ email: agentEmail, passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10), displayName: name, isAgent: true })
      .returning();

    if (inviteCode) {
      await db.insert(memberships).values({ orgId, userId: user.id, role });
      // An agent seat is free on Team and Business, so this never moves the seat
      // quantity — it is here so that *every* path that adds a member reconciles,
      // and a future change to what agents cost cannot quietly skip one.
      await syncSeatQuantity(orgId);
    } else {
      const org = await createOrganization(orgLabel, user.id);
      orgId = org.id;
    }

    const minted = await mintToken(user.id, orgId, `${name} — initial`);
    // Public endpoint: an admin needs to be able to see, later, that a seat
    // appeared in their organization and which invite code opened it.
    audit({ orgId, userId: user.id, label: `${name} <${user.email}>` }, "agent.registered", user.email, {
      role,
      viaInviteCode: Boolean(inviteCode),
      tokenPrefix: minted.prefix,
    });
    const manifest = buildManifest(req);
    res.status(201).json({
      user: { id: user.id, email: user.email, displayName: user.displayName, isAgent: true },
      org: { id: orgId, name: orgLabel, role },
      token: { id: minted.id, name: minted.name, prefix: minted.prefix, secret: minted.secret },
      auth_header_example: `Authorization: Bearer ${minted.secret}`,
      mcp_url: manifest.endpoints.mcp.url,
      discovery_url: manifest.endpoints.discovery,
    });
  });
}
