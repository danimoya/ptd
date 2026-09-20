/**
 * `chat_identities.provider` values, in one place.
 *
 * A bare string constant module with no imports: the link-code store, the identity
 * helpers, the actions and the adapters all need these names, and none of them
 * should have to pull in the database to learn one.
 */

export const SLACK_PROVIDER = "slack";
export const TELEGRAM_PROVIDER = "telegram";
export const TEAMS_PROVIDER = "teams";

/** `org_integrations.kind` values owned by the chat and code-host adapters. */
export const SLACK_KIND = "slack";
export const TELEGRAM_KIND = "telegram";
export const TEAMS_KIND = "teams";
export const GITHUB_KIND = "github";

export type ChatProvider = typeof SLACK_PROVIDER | typeof TELEGRAM_PROVIDER | typeof TEAMS_PROVIDER;
