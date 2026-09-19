import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../../../db";
import { chatIdentities, memberships, tasks, users, type Role } from "../../../db/schema";
import { ActionError, type ActionContext } from "../../actions/registry";
import { isRole } from "../../types";

/**
 * Who is talking, and which task they mean.
 *
 * A Slack user is a person, so the context built here is always
 * `authType: "human"`, `via: "slack"` — and the role comes from their PTD
 * membership, which is what makes the registry's role gate apply to Slack exactly
 * as it applies to the web app and to MCP.
 */

export const SLACK_PROVIDER = "slack";

/** `<teamId>:<slackUserId>` — scoped to the workspace so the same person can link two workspaces. */
export function externalIdFor(teamId: string, slackUserId: string): string {
  return `${teamId}:${slackUserId}`;
}

export function teamOf(externalId: string): string {
  return externalId.split(":")[0] ?? "";
}

export type CallerResolution =
  | { ok: true; ctx: ActionContext; userId: number }
  | { ok: false; reason: "not_linked" }
  | { ok: false; reason: "no_membership"; userId: number };

/** Slack identity → PTD user → membership in the workspace's org → ActionContext. */
export async function resolveSlackCaller(orgId: number, externalId: string): Promise<CallerResolution> {
  const [identity] = await db
    .select({ userId: chatIdentities.userId })
    .from(chatIdentities)
    .where(and(eq(chatIdentities.provider, SLACK_PROVIDER), eq(chatIdentities.externalId, externalId)))
    .limit(1);
  if (!identity) return { ok: false, reason: "not_linked" };

  const [row] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName, role: memberships.role })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, orgId)))
    .where(eq(users.id, identity.userId))
    .limit(1);
  if (!row) return { ok: false, reason: "no_membership", userId: identity.userId };

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
      // A Slack user is a person, whatever they are automating on the other side.
      authType: "human",
      via: "slack",
    },
  };
}

/**
 * Bind a Slack user to a PTD user. One Slack account maps to one PTD user per
 * workspace and vice versa, so both sides of any previous binding are cleared first
 * — re-linking is how you fix a mistake.
 */
export async function linkSlackIdentity(userId: number, teamId: string, slackUserId: string): Promise<void> {
  const externalId = externalIdFor(teamId, slackUserId);
  await db.delete(chatIdentities).where(and(eq(chatIdentities.provider, SLACK_PROVIDER), eq(chatIdentities.externalId, externalId)));
  await db
    .delete(chatIdentities)
    .where(and(eq(chatIdentities.provider, SLACK_PROVIDER), eq(chatIdentities.userId, userId), like(chatIdentities.externalId, `${teamId}:%`)));
  await db.insert(chatIdentities).values({ userId, provider: SLACK_PROVIDER, externalId });
}

export async function unlinkSlackIdentity(teamId: string, slackUserId: string): Promise<number> {
  const rows = await db
    .delete(chatIdentities)
    .where(and(eq(chatIdentities.provider, SLACK_PROVIDER), eq(chatIdentities.externalId, externalIdFor(teamId, slackUserId))))
    .returning({ id: chatIdentities.id });
  return rows.length;
}

/** Every Slack identity a PTD user holds (used by the Org UI and by `slack.unlink`). */
export async function slackIdentitiesForUser(userId: number): Promise<string[]> {
  const rows = await db
    .select({ externalId: chatIdentities.externalId })
    .from(chatIdentities)
    .where(and(eq(chatIdentities.provider, SLACK_PROVIDER), eq(chatIdentities.userId, userId)));
  return rows.map((r) => r.externalId);
}

export async function removeSlackIdentitiesForUser(userId: number): Promise<number> {
  const rows = await db
    .delete(chatIdentities)
    .where(and(eq(chatIdentities.provider, SLACK_PROVIDER), eq(chatIdentities.userId, userId)))
    .returning({ id: chatIdentities.id });
  return rows.length;
}

/** The Slack user id a PTD user has in one workspace, for DMing them. */
export async function slackUserIdFor(userId: number, teamId: string): Promise<string | null> {
  const rows = await db
    .select({ externalId: chatIdentities.externalId })
    .from(chatIdentities)
    .where(and(eq(chatIdentities.provider, SLACK_PROVIDER), eq(chatIdentities.userId, userId), like(chatIdentities.externalId, `${teamId}:%`)))
    .limit(1);
  const externalId = rows[0]?.externalId;
  if (!externalId) return null;
  const slackUserId = externalId.slice(teamId.length + 1);
  return slackUserId.length > 0 ? slackUserId : null;
}

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
