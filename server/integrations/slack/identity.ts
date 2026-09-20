import { SLACK_PROVIDER } from "../shared/providers";
import {
  externalIdForUser,
  identitiesForUser,
  linkChatIdentity,
  removeIdentitiesForUser,
  resolveChatCaller,
  unlinkChatIdentity,
  type CallerResolution,
} from "../shared/identity";

/**
 * Who is talking, and which task they mean.
 *
 * A Slack user is a person, so the context built here is always
 * `authType: "human"`, `via: "slack"` — and the role comes from their PTD
 * membership, which is what makes the registry's role gate apply to Slack exactly
 * as it applies to the web app and to MCP.
 *
 * The queries moved to `../shared/identity` when Telegram and Teams arrived: all
 * three resolve a `chat_identities` row the same way and differ only in what an
 * `externalId` means. Slack's is `<teamId>:<slackUserId>`, which is also its scope
 * prefix — that is the whole of what this module adds.
 */

export { SLACK_PROVIDER } from "../shared/providers";
export { resolveTaskRef, type CallerResolution, type TaskRef } from "../shared/identity";

/** `<teamId>:<slackUserId>` — scoped to the workspace so the same person can link two workspaces. */
export function externalIdFor(teamId: string, slackUserId: string): string {
  return `${teamId}:${slackUserId}`;
}

export function teamOf(externalId: string): string {
  return externalId.split(":")[0] ?? "";
}

/** Slack identity → PTD user → membership in the workspace's org → ActionContext. */
export function resolveSlackCaller(orgId: number, externalId: string): Promise<CallerResolution> {
  return resolveChatCaller(SLACK_PROVIDER, "slack", orgId, externalId);
}

/**
 * Bind a Slack user to a PTD user. One Slack account maps to one PTD user per
 * workspace and vice versa, so both sides of any previous binding are cleared first
 * — re-linking is how you fix a mistake.
 */
export function linkSlackIdentity(userId: number, teamId: string, slackUserId: string): Promise<void> {
  return linkChatIdentity(SLACK_PROVIDER, userId, externalIdFor(teamId, slackUserId), `${teamId}:`);
}

export function unlinkSlackIdentity(teamId: string, slackUserId: string): Promise<number> {
  return unlinkChatIdentity(SLACK_PROVIDER, externalIdFor(teamId, slackUserId));
}

/** Every Slack identity a PTD user holds (used by the Org UI and by `slack.unlink`). */
export function slackIdentitiesForUser(userId: number): Promise<string[]> {
  return identitiesForUser(SLACK_PROVIDER, userId);
}

export function removeSlackIdentitiesForUser(userId: number): Promise<number> {
  return removeIdentitiesForUser(SLACK_PROVIDER, userId);
}

/** The Slack user id a PTD user has in one workspace, for DMing them. */
export async function slackUserIdFor(userId: number, teamId: string): Promise<string | null> {
  const externalId = await externalIdForUser(SLACK_PROVIDER, userId, `${teamId}:`);
  if (!externalId) return null;
  const slackUserId = externalId.slice(teamId.length + 1);
  return slackUserId.length > 0 ? slackUserId : null;
}
