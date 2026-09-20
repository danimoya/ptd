/**
 * Slash-command text parsing — now shared with the Telegram and Teams adapters.
 *
 * The implementation moved to `../shared/parse` when the second and third chat
 * adapters arrived; this barrel keeps `./parse` as the Slack adapter's door onto it
 * so nothing inside the adapter (or its tests) had to move with it.
 */
export * from "../shared/parse";
