import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { memberships, organizations, users } from "../../db/schema";
import { defineAction } from "./registry";

defineAction({
  name: "whoami",
  title: "Who am I",
  description: "Identity, organization and role of the caller, plus whether it authenticated as a human or an agent.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => {
    const [org] = await db.select({ id: organizations.id, name: organizations.name, slug: organizations.slug }).from(organizations).where(eq(organizations.id, ctx.orgId)).limit(1);
    return { userId: ctx.userId, email: ctx.email, displayName: ctx.displayName, role: ctx.role, authType: ctx.authType, org };
  },
});

defineAction({
  name: "org.members",
  title: "List members",
  description: "Members of the organization with role and whether each is an agent seat.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) =>
    db
      .select({ userId: memberships.userId, displayName: users.displayName, email: users.email, role: memberships.role, isAgent: users.isAgent })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.orgId, ctx.orgId))
      .orderBy(memberships.createdAt),
});
