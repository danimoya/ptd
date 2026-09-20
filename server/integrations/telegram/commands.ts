import { defaultDispatchDeps, dispatchCommand, type DispatchDeps } from "../shared/dispatch";
import { ephemeral, errorReply, escape, type Reply } from "../shared/format";
import { runLinkFlow } from "../shared/link";
import { orgNameOf } from "../shared/identity";
import { TELEGRAM_PROVIDER } from "../shared/providers";
import { TELEGRAM_PREFIX } from "./config";
import {
  linkTelegramIdentity,
  rememberOrgChoice,
  resolveTelegramCaller,
  unlinkTelegramIdentity,
  type TelegramResolution,
} from "./identity";
import type { OrgMembership } from "../shared/identity";

/**
 * `/next`, `/start PTD-12`, `/log 45m PTD-12 …` → one registry action.
 *
 * The vocabulary is the shared one (`../shared/verbs`), so Telegram understands exactly
 * what Slack does and nothing more; what is Telegram's own is the `Update` envelope,
 * the `/command@botname` suffix groups add, `/org` (because a Telegram bot has no
 * workspace to imply an organization), and the fact that `/start` is Telegram's own
 * "open the chat" command as well as PTD's timer verb.
 */

export interface TelegramMessage {
  updateId: number | null;
  chatId: number | string | null;
  chatType: string | null;
  /** Telegram user id, as a string — the `chat_identities.externalId`. */
  fromId: string | null;
  username: string | null;
  firstName: string | null;
  text: string;
}

interface RawUpdate {
  update_id?: number;
  message?: RawMessage;
  edited_message?: RawMessage;
  channel_post?: RawMessage;
}

interface RawMessage {
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string; username?: string; first_name?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
}

/** Pull the one shape this adapter cares about out of a Telegram `Update`. */
export function readUpdate(body: unknown): TelegramMessage | null {
  const update = (body ?? {}) as RawUpdate;
  const message = update.message ?? update.edited_message ?? update.channel_post;
  if (!message) return null;
  if (message.from?.is_bot) return null;
  const text = (message.text ?? message.caption ?? "").trim();
  return {
    updateId: update.update_id ?? null,
    chatId: message.chat?.id ?? null,
    chatType: message.chat?.type ?? null,
    fromId: message.from?.id !== undefined ? String(message.from.id) : null,
    username: message.from?.username ?? null,
    firstName: message.from?.first_name ?? null,
    text,
  };
}

export interface ParsedTelegramCommand {
  /** The verb without its slash, lower-cased. Empty when the text is not a command. */
  command: string;
  /** Everything after the verb. */
  rest: string;
  /** The `@botname` a group chat appends, when there was one. */
  botName: string | null;
}

/**
 * `/log@ptd_bot 45m PTD-12` → `{ command: "log", rest: "45m PTD-12", botName: "ptd_bot" }`.
 * Plain text (no leading slash) is treated as a bare command, so someone typing
 * `next` in a private chat gets what they meant.
 */
export function parseTelegramCommand(text: string): ParsedTelegramCommand {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { command: "", rest: "", botName: null };
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const spaceAt = withoutSlash.search(/\s/);
  const head = spaceAt === -1 ? withoutSlash : withoutSlash.slice(0, spaceAt);
  const rest = spaceAt === -1 ? "" : withoutSlash.slice(spaceAt + 1).trim();
  const at = head.indexOf("@");
  return {
    command: (at === -1 ? head : head.slice(0, at)).toLowerCase(),
    rest,
    botName: at === -1 ? null : head.slice(at + 1),
  };
}

/** `/org` and `/unlink` are the adapter's own plumbing, but they belong in help. */
const HELP_EXTRAS = [
  { usage: "/org <id>", summary: "act on a different organization you belong to" },
  { usage: "/unlink", summary: "disconnect this Telegram account from PTD" },
];

/** How this person is written in a reply: `@handle`, else their first name, else the id. */
export function accountLabel(message: TelegramMessage): string {
  if (message.username) return escape(`@${message.username}`);
  if (message.firstName) return escape(message.firstName);
  return escape(message.fromId ?? "this account");
}

export interface TelegramDeps extends DispatchDeps {
  link: typeof linkTelegramIdentity;
  unlink: typeof unlinkTelegramIdentity;
  resolveCaller: typeof resolveTelegramCaller;
}

export const defaultTelegramDeps: TelegramDeps = {
  ...defaultDispatchDeps,
  link: linkTelegramIdentity,
  unlink: unlinkTelegramIdentity,
  resolveCaller: resolveTelegramCaller,
};

export interface Handled {
  reply: Reply;
  /** The org the command ran against, when it ran. */
  orgId?: number;
  command: string;
}

export function linkInstructions(): Reply {
  return ephemeral(
    [
      "*This Telegram account is not linked to a PTD user yet.*",
      "Open PTD → *Org → Integrations → Telegram*, mint a link code, then send `/link <code>` here.",
    ],
    ["codes last ten minutes and work once"],
  );
}

function orgList(orgs: OrgMembership[]): string[] {
  return orgs.map((o) => `• \`${o.orgId}\` ${escape(o.name)} — ${o.role}`);
}

/**
 * One message → one reply.
 *
 * `link` and `unlink` run before the caller is resolved (they are how a caller comes to
 * exist); everything else needs an identity and an organization first.
 */
export async function handleTelegramMessage(message: TelegramMessage, overrides: Partial<TelegramDeps> = {}): Promise<Handled> {
  const deps: TelegramDeps = { ...defaultTelegramDeps, ...overrides };
  const parsed = parseTelegramCommand(message.text);
  const externalId = message.fromId ?? "";
  if (!externalId) return { command: parsed.command, reply: errorReply("I could not tell who sent that.") };

  if (parsed.command === "link") {
    const { reply } = await runLinkFlow({
      provider: TELEGRAM_PROVIDER,
      accountKey: externalId,
      // The bot serves every organization, so whichever org minted the code is the
      // right one — there is no workspace install to contradict it.
      orgId: null,
      orgName: null,
      orgNameFor: orgNameOf,
      code: parsed.rest.split(/\s+/)[0] || undefined,
      now: Date.now(),
      example: "/link ABC123",
      mintPath: "PTD → Org → Integrations → Telegram",
      scopeLabel: "bot",
      account: accountLabel(message),
      suggestions: ["`/next`", "`/start PTD-12`", "`/today`"],
      link: (entry) => deps.link(entry.userId, externalId),
    });
    return { command: "link", reply };
  }

  if (parsed.command === "unlink") {
    const removed = await deps.unlink(externalId);
    if (removed === 0) return { command: "unlink", reply: errorReply("This Telegram account was not linked to a PTD user.") };
    return {
      command: "unlink",
      reply: ephemeral(["*Unlinked.* This Telegram account no longer acts as a PTD user."], ["`/link <code>` to link it again"]),
    };
  }

  const caller: TelegramResolution = await deps.resolveCaller(externalId);
  if (!caller.ok) {
    if (caller.reason === "not_linked") return { command: parsed.command, reply: linkInstructions() };
    if (caller.reason === "not_a_member_of_choice") {
      return {
        command: parsed.command,
        reply: errorReply("You are no longer a member of the organization you had selected.", [
          `pick one with \`/org <id>\`: ${caller.orgs.map((o) => o.orgId).join(", ")}`,
        ]),
      };
    }
    return {
      command: parsed.command,
      reply: errorReply("Your PTD account does not belong to an organization yet.", ["ask an admin for an invitation"]),
    };
  }

  if (parsed.command === "org") {
    return { command: "org", orgId: caller.ctx.orgId, reply: switchOrg(message, caller, parsed.rest) };
  }

  // Telegram sends a bare `/start` when someone opens the chat, before they could
  // possibly mean the timer — answer with help rather than "name a task".
  const text = parsed.command === "start" && parsed.rest === "" ? "help" : `${parsed.command} ${parsed.rest}`.trim();

  const { reply } = await dispatchCommand(
    {
      ctx: caller.ctx,
      text,
      prefix: TELEGRAM_PREFIX,
      who: { account: accountLabel(message), scope: caller.orgs.find((o) => o.orgId === caller.ctx.orgId)?.name ?? null },
      helpExtras: HELP_EXTRAS,
      surface: "telegram",
    },
    deps,
  );
  return { command: parsed.command, orgId: caller.ctx.orgId, reply };
}

/** `/org` lists what you belong to; `/org 3` selects one for this chat. */
function switchOrg(message: TelegramMessage, caller: Extract<TelegramResolution, { ok: true }>, rest: string): Reply {
  const wanted = rest.trim();
  const current = caller.orgs.find((o) => o.orgId === caller.ctx.orgId);
  if (!wanted) {
    return ephemeral(
      [`*Your organizations* — currently acting on *${escape(current?.name ?? String(caller.ctx.orgId))}*`, ...orgList(caller.orgs)],
      ["switch with `/org <id>`"],
    );
  }
  if (!/^\d{1,9}$/.test(wanted)) {
    return errorReply(`\`${escape(wanted)}\` is not an organization id.`, [`\`/org <id>\` — yours are ${caller.orgs.map((o) => o.orgId).join(", ")}`]);
  }
  const orgId = Number(wanted);
  const target = caller.orgs.find((o) => o.orgId === orgId);
  if (!target) {
    return errorReply(`You are not a member of organization ${orgId}.`, [`yours are ${caller.orgs.map((o) => o.orgId).join(", ")}`]);
  }
  rememberOrgChoice(message.fromId ?? "", orgId);
  return ephemeral(
    [`*Now acting on ${escape(target.name)}* as *${target.role}*.`],
    ["kept until this PTD server restarts, then your oldest organization comes back"],
  );
}
