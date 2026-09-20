import { type ActionContext, runAction } from "../../actions/registry";
import { dispatchCommand, type DispatchDeps } from "../shared/dispatch";
import { ephemeral, errorReply, type HelpEntry, type SlackReply } from "../shared/format";
import { canonicalVerb, helpEntriesFor, usageOf, VERBS, type Verb } from "../shared/verbs";
import { runLinkFlow } from "../shared/link";
import { SLACK_PROVIDER } from "../shared/providers";
import { externalIdFor, linkSlackIdentity, resolveTaskRef, unlinkSlackIdentity, type TaskRef } from "./identity";
import { parseCommandText } from "./parse";

/**
 * `/ptd …` → one registry action.
 *
 * The vocabulary itself (which words map to which action, and how the arguments are
 * read) lives in `../shared/verbs`, and the dispatch in `../shared/dispatch`, because
 * Telegram and Teams speak the same language; what is Slack's own is the slash-command
 * envelope, the `<@U…>` mention in `who`, and the link/unlink flow below.
 *
 * Every subcommand is a thin translation of words into an action's input schema;
 * the role gate, the org scoping and the work itself all stay in the registry, so
 * Slack can never do something the web app or MCP could not. `runAction` and the
 * task lookup are injected so the mapping can be tested without a database.
 */

/** How a Slack user types a command: `/ptd next`. */
export const SLACK_PREFIX = "/ptd ";

export interface SlashPayload {
  teamId: string;
  teamDomain: string | null;
  channelId: string | null;
  channelName: string | null;
  userId: string;
  userName: string | null;
  command: string;
  text: string;
  responseUrl: string | null;
  triggerId: string | null;
  apiAppId: string | null;
}

/** Slack posts slash commands as `application/x-www-form-urlencoded`. */
export function parseSlashBody(rawBody: string): SlashPayload {
  const form = new URLSearchParams(rawBody);
  const get = (key: string): string | null => {
    const value = form.get(key);
    return value !== null && value.length > 0 ? value : null;
  };
  return {
    teamId: get("team_id") ?? "",
    teamDomain: get("team_domain"),
    channelId: get("channel_id"),
    channelName: get("channel_name"),
    userId: get("user_id") ?? "",
    userName: get("user_name"),
    command: get("command") ?? "/ptd",
    text: form.get("text") ?? "",
    responseUrl: get("response_url"),
    triggerId: get("trigger_id"),
    apiAppId: get("api_app_id"),
  };
}

export interface CommandDeps extends DispatchDeps {
  resolveTask: (orgId: number, ref: string) => Promise<TaskRef>;
  linkIdentity: typeof linkSlackIdentity;
  unlinkIdentity: typeof unlinkSlackIdentity;
}

export const defaultDeps: CommandDeps = {
  runAction,
  resolveTask: resolveTaskRef,
  linkIdentity: linkSlackIdentity,
  unlinkIdentity: unlinkSlackIdentity,
  now: () => Date.now(),
};

export interface DispatchInput {
  ctx: ActionContext;
  payload: SlashPayload;
  teamName: string | null;
}

/** The shared verb table, with Slack's `/ptd …` usage line filled in. */
export interface Subcommand extends Verb {
  usage: string;
}

export const SUBCOMMANDS: Subcommand[] = VERBS.map((verb) => ({ ...verb, usage: usageOf(verb, SLACK_PREFIX) }));

/** `/ptd unlink` is not a verb — it is the adapter's own plumbing, but it belongs in help. */
const HELP_EXTRAS = [{ usage: `${SLACK_PREFIX}unlink`, summary: "disconnect this Slack account from PTD" }];

export function canonicalSub(sub: string): string {
  return canonicalVerb(sub);
}

export function helpEntries(ctx: ActionContext): HelpEntry[] {
  return helpEntriesFor(ctx, SLACK_PREFIX, HELP_EXTRAS);
}

/* ── dispatch ─────────────────────────────────────────────────────────── */

export async function handleSlashCommand(input: DispatchInput, overrides: Partial<CommandDeps> = {}): Promise<SlackReply> {
  const deps: CommandDeps = { ...defaultDeps, ...overrides };
  const parsed = parseCommandText(input.payload.text);
  if (canonicalSub(parsed.sub) === "link") {
    return ephemeral(
      ["*This Slack account is already linked.*"],
      ["`/ptd unlink` first if you need to point it at a different PTD user"],
    );
  }

  const { reply } = await dispatchCommand(
    {
      ctx: input.ctx,
      text: input.payload.text,
      prefix: SLACK_PREFIX,
      who: { account: `<@${input.payload.userId}>`, scope: input.teamName },
      helpExtras: HELP_EXTRAS,
      surface: "slack",
    },
    deps,
  );
  return reply;
}

/* ── identity linking ─────────────────────────────────────────────────── */

export function linkInstructions(orgName?: string | null): SlackReply {
  return ephemeral(
    [
      "*This Slack account is not linked to a PTD user yet.*",
      `Open PTD${orgName ? ` (${orgName})` : ""} → *Org → Integrations → Slack*, mint a link code, then run \`/ptd link <code>\` here.`,
    ],
    ["codes last ten minutes and work once"],
  );
}

export async function handleLink(input: { payload: SlashPayload; orgId: number; orgName: string | null; code: string | undefined }, overrides: Partial<CommandDeps> = {}): Promise<SlackReply> {
  const deps: CommandDeps = { ...defaultDeps, ...overrides };
  const { reply } = await runLinkFlow({
    provider: SLACK_PROVIDER,
    accountKey: externalIdFor(input.payload.teamId, input.payload.userId),
    orgId: input.orgId,
    orgName: input.orgName,
    code: input.code,
    now: deps.now(),
    example: `${SLACK_PREFIX}link ABC123`,
    mintPath: "PTD → Org → Integrations → Slack",
    scopeLabel: "Slack workspace",
    account: `<@${input.payload.userId}>`,
    suggestions: ["`/ptd next`", "`/ptd start PTD-12`", "`/ptd today`"],
    link: (entry) => deps.linkIdentity(entry.userId, input.payload.teamId, input.payload.userId),
  });
  return reply;
}

export async function handleUnlink(input: { payload: SlashPayload }, overrides: Partial<CommandDeps> = {}): Promise<SlackReply> {
  const deps: CommandDeps = { ...defaultDeps, ...overrides };
  const removed = await deps.unlinkIdentity(input.payload.teamId, input.payload.userId);
  if (removed === 0) return errorReply("This Slack account was not linked to a PTD user.");
  return ephemeral(["*Unlinked.* This Slack account no longer acts as a PTD user."], ["`/ptd link <code>` to link it again"]);
}
