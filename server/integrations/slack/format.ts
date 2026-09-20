/**
 * Block Kit rendering — now shared with the Telegram and Teams adapters.
 *
 * The renderers moved to `../shared/format` when the second and third chat adapters
 * arrived: Block Kit + mrkdwn is the intermediate representation all three speak,
 * and `../shared/markup` converts it to Telegram HTML or Teams plain text. This
 * barrel keeps `./format` as the Slack adapter's door onto it, `SlackReply` included.
 */
export * from "../shared/format";
