/**
 * Microsoft Teams, the cheap way: an Outgoing Webhook.
 *
 * Teams has two ways to run a bot. The Bot Framework one wants an Azure app
 * registration, a tenant, a channel registration and an outbound token dance. The other
 * is an "Outgoing Webhook", which a team owner creates in the Teams client in about a
 * minute: they name it, point it at a URL, and Teams hands them a secret. From then on
 * `@PTD next` in that team POSTs the message to the URL, signed with that secret, and
 * whatever JSON comes back is shown as the bot's reply.
 *
 * PTD takes the second road on purpose. There is no app registration to maintain, no
 * per-tenant configuration and nothing to publish; the cost is that the bot only works
 * where it is @mentioned (no DMs, no proactive notifications), which is why Teams is a
 * command surface here and not a notification one.
 */

export const TEAMS_BASE_PATH = "/api/integrations/teams";
/** How a Teams user types a command. The mention itself is stripped before parsing. */
export const TEAMS_PREFIX = "@PTD ";
export const TEAMS_AUTH_HEADER = "authorization";

/**
 * Strip the mention Teams puts at the front of the text.
 *
 * The raw text is like `<at>PTD</at> next` — and with mentions rendered off it can
 * arrive as plain `PTD next`, or with a non-breaking space. Everything up to and
 * including the first mention (or the bot's bare name) goes.
 */
export function stripMention(raw: string, botName = "PTD"): string {
  let text = (raw ?? "").replace(/ /g, " ");
  text = text.replace(/<at\b[^>]*>.*?<\/at>/gi, " ");
  text = text.replace(/&nbsp;/gi, " ");
  const name = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  text = text.replace(new RegExp(`^\\s*@?${name}\\b[:,]?`, "i"), " ");
  return text.replace(/\s+/g, " ").trim();
}
