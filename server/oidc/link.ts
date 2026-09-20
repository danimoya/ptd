/**
 * What a provider profile means for the accounts we already have.
 *
 * Three outcomes, in this order:
 *
 * 1. **Known identity** — `(provider, subject)` is already on file: sign that
 *    user in. The subject, not the address, is the identity: a renamed GitHub
 *    login or a changed work address must not become a different person.
 * 2. **Verified address we know** — link the identity to that account and sign
 *    in. Only ever on a *verified* address: an unverified one would let anyone
 *    who can create an account at a provider take over a PTD account by typing
 *    someone else's address into it.
 * 3. **Nobody** — create the account, with a random password (the holder resets
 *    it if they ever want to sign in without the provider) and either the
 *    organization their invitation names or a fresh one of their own.
 */
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { invitations, memberships, userIdentities, users, type User } from "../../db/schema";
import { createOrganization } from "../auth";
import { assertWithinPlan } from "../billing/limits";
import { ActionError } from "../actions/registry";
import type { OidcProfile } from "./profile";
import type { OidcProvider } from "./providers";

export interface LinkOutcome {
  user: User;
  orgId: number | null;
  created: boolean;
  linked: boolean;
  joinedOrgId?: number;
}

export class LinkError extends Error {
  constructor(
    readonly code: "no_email" | "email_unverified" | "plan_limit",
    message: string,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

async function oldestOrgId(userId: number): Promise<number | null> {
  const [row] = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(memberships.createdAt)
    .limit(1);
  return row?.orgId ?? null;
}

/** Accept an invitation that matches this address, if one is outstanding. */
async function acceptInvitationFor(user: User, token: string | undefined): Promise<number | null> {
  if (!token) return null;
  const [invite] = await db.select().from(invitations).where(eq(invitations.token, token)).limit(1);
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) return null;
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) return null;
  const existing = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.orgId, invite.orgId), eq(memberships.userId, user.id)))
    .limit(1);
  if (existing.length === 0) {
    try {
      await assertWithinPlan(invite.orgId, "member");
    } catch (err) {
      if (err instanceof ActionError) throw new LinkError("plan_limit", err.message);
      throw err;
    }
    await db.insert(memberships).values({ orgId: invite.orgId, userId: user.id, role: invite.role, invitedBy: invite.invitedBy });
  }
  await db.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invite.id));
  return invite.orgId;
}

export async function resolveOidcLogin(input: {
  provider: OidcProvider;
  profile: OidcProfile;
  inviteToken?: string;
}): Promise<LinkOutcome> {
  const { provider, profile } = input;

  const [identity] = await db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, profile.subject)))
    .limit(1);

  if (identity) {
    const [user] = await db.select().from(users).where(eq(users.id, identity.userId)).limit(1);
    if (user) {
      // Keep the recorded address current — it is shown on the Security tab.
      if (profile.email && profile.email !== identity.email) {
        await db.update(userIdentities).set({ email: profile.email }).where(eq(userIdentities.id, identity.id));
      }
      const joined = await acceptInvitationFor(user, input.inviteToken);
      return { user, orgId: joined ?? (await oldestOrgId(user.id)), created: false, linked: false, joinedOrgId: joined ?? undefined };
    }
    // Orphaned row (user deleted): drop it and carry on as if it were absent.
    await db.delete(userIdentities).where(eq(userIdentities.id, identity.id));
  }

  if (!profile.email) {
    throw new LinkError("no_email", "That account has no email address PTD can use — add one at the provider, or sign in with a password.");
  }
  if (!profile.emailVerified) {
    throw new LinkError(
      "email_unverified",
      "That provider did not confirm the email address, so PTD will not attach it to an account. Verify the address with the provider and try again.",
    );
  }

  const [existing] = await db.select().from(users).where(eq(users.email, profile.email)).limit(1);
  if (existing) {
    await db.insert(userIdentities).values({ userId: existing.id, provider, subject: profile.subject, email: profile.email });
    const joined = await acceptInvitationFor(existing, input.inviteToken);
    return { user: existing, orgId: joined ?? (await oldestOrgId(existing.id)), created: false, linked: true, joinedOrgId: joined ?? undefined };
  }

  const displayName = profile.displayName?.trim() || profile.email.split("@")[0];
  const [created] = await db
    .insert(users)
    .values({
      email: profile.email,
      // 32 random bytes, bcrypt at the same cost as a chosen password. Nobody
      // knows it, including us; "forgot password" is how it ever becomes usable.
      passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 12),
      displayName: displayName.slice(0, 120),
    })
    .returning();
  await db.insert(userIdentities).values({ userId: created.id, provider, subject: profile.subject, email: profile.email });

  const joined = await acceptInvitationFor(created, input.inviteToken);
  if (joined) return { user: created, orgId: joined, created: true, linked: true, joinedOrgId: joined };

  const org = await createOrganization(`${displayName}'s organization`, created.id);
  return { user: created, orgId: org.id, created: true, linked: true };
}

export interface IdentityView {
  id: number;
  provider: string;
  subject: string;
  email: string | null;
  createdAt: Date;
}

export async function listIdentities(userId: number): Promise<IdentityView[]> {
  return db
    .select({
      id: userIdentities.id,
      provider: userIdentities.provider,
      subject: userIdentities.subject,
      email: userIdentities.email,
      createdAt: userIdentities.createdAt,
    })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .orderBy(userIdentities.createdAt);
}

export async function unlinkIdentity(userId: number, id: number): Promise<IdentityView | null> {
  const [row] = await db
    .delete(userIdentities)
    .where(and(eq(userIdentities.id, id), eq(userIdentities.userId, userId)))
    .returning();
  if (!row) return null;
  return { id: row.id, provider: row.provider, subject: row.subject, email: row.email, createdAt: row.createdAt };
}
