import { TEAMS_PROVIDER } from "../shared/providers";
import {
  identitiesForUser,
  linkChatIdentity,
  removeIdentitiesForUser,
  resolveChatCaller,
  unlinkChatIdentity,
  type CallerResolution,
} from "../shared/identity";

/**
 * Who is talking in Teams.
 *
 * `from.aadObjectId` is the identifier to bind to: it is the person's object id in
 * Entra ID (Azure AD), stable across channels, teams and renames, and the same value
 * every Microsoft surface uses for them. `from.id` is per-conversation and `from.name`
 * is a display name, so neither is a key.
 *
 * Unlike Telegram there is no organization to guess: the Outgoing Webhook's secret is
 * per organization, so by the time the caller is resolved the org is already known.
 */

export { TEAMS_PROVIDER } from "../shared/providers";

export function externalIdFor(aadObjectId: string): string {
  return aadObjectId.trim().toLowerCase();
}

export function resolveTeamsCaller(orgId: number, aadObjectId: string): Promise<CallerResolution> {
  return resolveChatCaller(TEAMS_PROVIDER, "teams", orgId, externalIdFor(aadObjectId));
}

export function linkTeamsIdentity(userId: number, aadObjectId: string): Promise<void> {
  return linkChatIdentity(TEAMS_PROVIDER, userId, externalIdFor(aadObjectId));
}

export function unlinkTeamsIdentity(aadObjectId: string): Promise<number> {
  return unlinkChatIdentity(TEAMS_PROVIDER, externalIdFor(aadObjectId));
}

export function teamsIdentitiesForUser(userId: number): Promise<string[]> {
  return identitiesForUser(TEAMS_PROVIDER, userId);
}

export function removeTeamsIdentitiesForUser(userId: number): Promise<number> {
  return removeIdentitiesForUser(TEAMS_PROVIDER, userId);
}
