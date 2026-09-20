import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { chatIdentities } from "../../../db/schema";
import { TELEGRAM_PROVIDER } from "../shared/providers";
import {
  identitiesForUser,
  linkChatIdentity,
  orgsForUser,
  removeIdentitiesForUser,
  resolveCallerForUser,
  unlinkChatIdentity,
  userIdForIdentity,
  type CallerResolution,
  type OrgMembership,
} from "../shared/identity";

/**
 * Who is talking on Telegram, and which organization they mean.
 *
 * Slack knows the organization from the workspace install; Telegram cannot. One bot
 * token serves the whole deployment, a Telegram user id is global, and a person may
 * belong to several PTD organizations. So the resolution is:
 *
 *   1. `chat_identities` (provider `telegram`, externalId = the Telegram user id) says
 *      which PTD user is talking;
 *   2. the organization is the one they chose with `/org <id>`, if any;
 *   3. otherwise their oldest membership — the same default `resolveOrg` applies to a
 *      web request that arrives without an `X-Org-Id` header.
 *
 * The chosen organization is the identity row's own `org_id` column, NOT a suffix on
 * `externalId`: that column is the join key every lookup and every outbound DM matches
 * on, so encoding a mutable preference into it would mean rewriting the key on every
 * `/org` and breaking any row written before the suffix existed. Because the choice is
 * a column, it survives a restart and it is the same choice on every app replica.
 */

export const TELEGRAM_PROVIDER_NAME = TELEGRAM_PROVIDER;

export function externalIdFor(telegramUserId: string | number): string {
  return String(telegramUserId);
}

function identityWhere(externalId: string) {
  return and(eq(chatIdentities.provider, TELEGRAM_PROVIDER), eq(chatIdentities.externalId, externalId));
}

/**
 * Remember the `/org` choice.
 *
 * Never rejects: `/org` is a chat command whose answer has already been composed by
 * the time this runs, and a database hiccup there should show up in the log, not as
 * an unhandled rejection in the webhook handler.
 */
export async function rememberOrgChoice(externalId: string, orgId: number): Promise<void> {
  try {
    await db.update(chatIdentities).set({ orgId }).where(identityWhere(externalId));
  } catch (err) {
    console.warn(`[telegram] could not store the /org choice for ${externalId}:`, err instanceof Error ? err.message : err);
  }
}

export async function forgetOrgChoice(externalId: string): Promise<void> {
  try {
    await db.update(chatIdentities).set({ orgId: null }).where(identityWhere(externalId));
  } catch (err) {
    console.warn(`[telegram] could not clear the /org choice for ${externalId}:`, err instanceof Error ? err.message : err);
  }
}

export async function orgChoiceOf(externalId: string): Promise<number | null> {
  const [row] = await db.select({ orgId: chatIdentities.orgId }).from(chatIdentities).where(identityWhere(externalId)).limit(1);
  return row?.orgId ?? null;
}

export type TelegramResolution =
  | { ok: true; ctx: import("../../actions/registry").ActionContext; userId: number; orgs: OrgMembership[] }
  | { ok: false; reason: "not_linked" }
  | { ok: false; reason: "no_membership"; userId: number }
  | { ok: false; reason: "not_a_member_of_choice"; userId: number; orgs: OrgMembership[] };

/** Telegram identity → PTD user → chosen (or oldest) org → ActionContext. */
export async function resolveTelegramCaller(externalId: string): Promise<TelegramResolution> {
  const userId = await userIdForIdentity(TELEGRAM_PROVIDER, externalId);
  if (userId === null) return { ok: false, reason: "not_linked" };

  const orgs = await orgsForUser(userId);
  if (orgs.length === 0) return { ok: false, reason: "no_membership", userId };

  const chosen = await orgChoiceOf(externalId);
  if (chosen !== null && !orgs.some((o) => o.orgId === chosen)) {
    // They were removed from the organization they had selected; make them pick again
    // rather than silently acting on a different one.
    await forgetOrgChoice(externalId);
    return { ok: false, reason: "not_a_member_of_choice", userId, orgs };
  }

  const orgId = chosen ?? orgs[0].orgId;
  const resolved: CallerResolution = await resolveCallerForUser("telegram", orgId, userId);
  if (!resolved.ok) return { ok: false, reason: "no_membership", userId };
  return { ok: true, ctx: resolved.ctx, userId: resolved.userId, orgs };
}

export function linkTelegramIdentity(userId: number, externalId: string): Promise<void> {
  return linkChatIdentity(TELEGRAM_PROVIDER, userId, externalId);
}

/** Unlinking deletes the identity row, which takes the `/org` choice with it. */
export function unlinkTelegramIdentity(externalId: string): Promise<number> {
  return unlinkChatIdentity(TELEGRAM_PROVIDER, externalId);
}

export function telegramIdentitiesForUser(userId: number): Promise<string[]> {
  return identitiesForUser(TELEGRAM_PROVIDER, userId);
}

export function removeTelegramIdentitiesForUser(userId: number): Promise<number> {
  return removeIdentitiesForUser(TELEGRAM_PROVIDER, userId);
}

/**
 * The chat to DM a PTD user in. In a private chat Telegram's chat id *is* the user id,
 * which is why the identity row is all the outbound side needs — provided the person
 * has opened a conversation with the bot, which linking required them to do.
 */
export async function telegramChatFor(userId: number): Promise<string | null> {
  const ids = await telegramIdentitiesForUser(userId);
  return ids[0] ?? null;
}

export { orgsForUser };
