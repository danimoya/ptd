import { and, asc, eq, like, sql } from "drizzle-orm";
import { db } from "../../../db";
import { chatIdentities, memberships, organizations, tasks, users, type Role } from "../../../db/schema";
import { ActionError, type ActionContext, type Via } from "../../actions/registry";
import { hasRole, isRole } from "../../types";

/**
 * Who is talking, and which task they mean — for every chat adapter.
 *
 * A chat user is a person, so the context built here is always `authType: "human"`
 * and the role comes from their PTD membership: that is what makes the registry's
 * role gate apply to Slack, Telegram and Teams exactly as it applies to the web app
 * and to MCP. No adapter builds an ActionContext any other way.
 */

export type CallerResolution =
  | { ok: true; ctx: ActionContext; userId: number }
  | { ok: false; reason: "not_linked" }
  | { ok: false; reason: "no_membership"; userId: number };

/** The PTD user a chat identity points at, or null when that account is not linked. */
export async function userIdForIdentity(provider: string, externalId: string): Promise<number | null> {
  const [identity] = await db
    .select({ userId: chatIdentities.userId })
    .from(chatIdentities)
    .where(and(eq(chatIdentities.provider, provider), eq(chatIdentities.externalId, externalId)))
    .limit(1);
  return identity?.userId ?? null;
}

/** Chat identity → PTD user → membership in `orgId` → ActionContext. */
export async function resolveChatCaller(provider: string, via: Via, orgId: number, externalId: string): Promise<CallerResolution> {
  const userId = await userIdForIdentity(provider, externalId);
  if (userId === null) return { ok: false, reason: "not_linked" };
  return resolveCallerForUser(via, orgId, userId);
}

/** The same context, for a user we already identified (Telegram resolves the org first). */
export async function resolveCallerForUser(via: Via, orgId: number, userId: number): Promise<CallerResolution> {
  const [row] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName, role: memberships.role })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, orgId)))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return { ok: false, reason: "no_membership", userId };

  const role: Role = isRole(row.role) ? row.role : "member";
  return {
    ok: true,
    userId: row.id,
    ctx: {
      userId: row.id,
      email: row.email,
      displayName: row.displayName,
      orgId,
      role,
      // A chat user is a person, whatever they are automating on the other side.
      authType: "human",
      via,
    },
  };
}

/**
 * Bind a chat account to a PTD user. One chat account maps to one PTD user per scope
 * (a Slack workspace, the Telegram bot, a Teams tenant) and vice versa, so both sides
 * of any previous binding are cleared first — re-linking is how you fix a mistake.
 *
 * `scopePrefix` is the `externalId` prefix that defines "per scope": Slack passes
 * `<teamId>:`, Telegram and Teams have a single scope and pass nothing.
 */
export async function linkChatIdentity(provider: string, userId: number, externalId: string, scopePrefix?: string): Promise<void> {
  await db.delete(chatIdentities).where(and(eq(chatIdentities.provider, provider), eq(chatIdentities.externalId, externalId)));
  await db
    .delete(chatIdentities)
    .where(
      scopePrefix
        ? and(eq(chatIdentities.provider, provider), eq(chatIdentities.userId, userId), like(chatIdentities.externalId, `${scopePrefix}%`))
        : and(eq(chatIdentities.provider, provider), eq(chatIdentities.userId, userId)),
    );
  await db.insert(chatIdentities).values({ userId, provider, externalId });
}

export async function unlinkChatIdentity(provider: string, externalId: string): Promise<number> {
  const rows = await db
    .delete(chatIdentities)
    .where(and(eq(chatIdentities.provider, provider), eq(chatIdentities.externalId, externalId)))
    .returning({ id: chatIdentities.id });
  return rows.length;
}

/** Every identity a PTD user holds with one provider (used by the Org UI and `*.unlink`). */
export async function identitiesForUser(provider: string, userId: number): Promise<string[]> {
  const rows = await db
    .select({ externalId: chatIdentities.externalId })
    .from(chatIdentities)
    .where(and(eq(chatIdentities.provider, provider), eq(chatIdentities.userId, userId)));
  return rows.map((r) => r.externalId);
}

export async function removeIdentitiesForUser(provider: string, userId: number): Promise<number> {
  const rows = await db
    .delete(chatIdentities)
    .where(and(eq(chatIdentities.provider, provider), eq(chatIdentities.userId, userId)))
    .returning({ id: chatIdentities.id });
  return rows.length;
}

/** The external id a PTD user has in one scope, for DMing them. */
export async function externalIdForUser(provider: string, userId: number, scopePrefix = ""): Promise<string | null> {
  const rows = await db
    .select({ externalId: chatIdentities.externalId })
    .from(chatIdentities)
    .where(
      scopePrefix
        ? and(eq(chatIdentities.provider, provider), eq(chatIdentities.userId, userId), like(chatIdentities.externalId, `${scopePrefix}%`))
        : and(eq(chatIdentities.provider, provider), eq(chatIdentities.userId, userId)),
    )
    .limit(1);
  return rows[0]?.externalId ?? null;
}

export interface OrgMembership {
  orgId: number;
  name: string;
  slug: string;
  role: Role;
}

/**
 * Every organization a user belongs to, oldest membership first.
 *
 * Telegram needs this: its bot has no workspace to identify an org with, so the
 * default is the oldest membership and `/org <id>` picks another.
 */
export async function orgsForUser(userId: number): Promise<OrgMembership[]> {
  const rows = await db
    .select({ orgId: memberships.orgId, name: organizations.name, slug: organizations.slug, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt));
  return rows.map((r) => ({ orgId: r.orgId, name: r.name, slug: r.slug, role: isRole(r.role) ? r.role : ("member" as Role) }));
}

export async function orgNameOf(orgId: number): Promise<string | null> {
  try {
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    return org?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * A server-side context for an inbound integration event (GitHub webhooks).
 *
 * There is no human at the wheel, so the write is attributed to the member who set
 * the mapping up and carries THEIR role — an integration must not be able to do more
 * than the person who connected it. If that member has left the organization the
 * context falls back to its oldest owner/admin, because a repo left mapped must keep
 * syncing rather than fail silently; `minRole` is what the caller needs (manager, for
 * task.create/update) and a context that cannot reach it is refused outright.
 */
export async function serverContextFor(
  orgId: number,
  userId: number | null,
  via: Via,
  minRole: Role = "manager",
): Promise<ActionContext | null> {
  const candidates: number[] = [];
  if (userId !== null) candidates.push(userId);
  const fallback = await db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(memberships.createdAt));
  for (const row of fallback) {
    if (isRole(row.role) && hasRole(row.role, "admin") && !candidates.includes(row.userId)) candidates.push(row.userId);
  }

  for (const candidate of candidates) {
    const resolved = await resolveCallerForUser(via, orgId, candidate);
    if (resolved.ok && hasRole(resolved.ctx.role, minRole)) return resolved.ctx;
  }
  return null;
}

/* ── task references ──────────────────────────────────────────────────── */

export interface TaskRef {
  id: number;
  title: string;
  externalKey: string | null;
}

/** ilike is a pattern match, so a key containing % or _ must not become a wildcard. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * `PTD-12` → the task carrying that `externalKey` in this org; `42` → task 42.
 * The key wins, because that is what people paste out of GitHub and Jira.
 */
export async function resolveTaskRef(orgId: number, raw: string): Promise<TaskRef> {
  const ref = (raw ?? "").trim().replace(/^#/, "");
  if (!ref) throw new ActionError("invalid", "Name a task — its key (PTD-12) or its numeric id.");

  const columns = { id: tasks.id, title: tasks.title, externalKey: tasks.externalKey };
  const [byKey] = await db
    .select(columns)
    .from(tasks)
    .where(and(eq(tasks.orgId, orgId), sql`${tasks.externalKey} ilike ${escapeLike(ref)}`))
    .limit(1);
  if (byKey) return byKey;

  if (/^\d{1,9}$/.test(ref)) {
    const [byId] = await db
      .select(columns)
      .from(tasks)
      .where(and(eq(tasks.orgId, orgId), eq(tasks.id, Number(ref))))
      .limit(1);
    if (byId) return byId;
  }
  throw new ActionError("not_found", `No task matches "${raw}" in this organization — use its key (PTD-12) or its numeric id.`);
}

/** The task whose `externalKey` is exactly `key`, or null. Used by the GitHub sync. */
export async function taskByExternalKey(orgId: number, key: string): Promise<TaskRef | null> {
  const [row] = await db
    .select({ id: tasks.id, title: tasks.title, externalKey: tasks.externalKey })
    .from(tasks)
    .where(and(eq(tasks.orgId, orgId), eq(tasks.externalKey, key)))
    .limit(1);
  return row ?? null;
}

/** An org member whose email matches (case-insensitively), for mapping a remote user onto a seat. */
export async function memberByEmail(orgId: number, email: string): Promise<{ userId: number; displayName: string } | null> {
  const wanted = (email ?? "").trim().toLowerCase();
  if (!wanted) return null;
  const rows = await db
    .select({ userId: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, orgId)));
  const hit = rows.find((r) => r.email.toLowerCase() === wanted);
  return hit ? { userId: hit.userId, displayName: hit.displayName } : null;
}
