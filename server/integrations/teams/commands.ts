import { defaultDispatchDeps, dispatchCommand, type DispatchDeps } from "../shared/dispatch";
import { ephemeral, errorReply, escape, type Reply } from "../shared/format";
import { runLinkFlow } from "../shared/link";
import { TEAMS_PROVIDER } from "../shared/providers";
import { TEAMS_PREFIX, stripMention } from "./config";
import { linkTeamsIdentity, resolveTeamsCaller, unlinkTeamsIdentity } from "./identity";

/**
 * `@PTD next` → one registry action.
 *
 * The vocabulary is the shared one (`../shared/verbs`), so Teams understands exactly
 * what Slack and Telegram do; what is Teams' own is the Bot Framework `Activity`
 * envelope, the `<at>PTD</at>` mention to strip, and the fact that identity is an Entra
 * object id.
 */

export interface TeamsActivity {
  type: string | null;
  /** `from.aadObjectId` — the Entra object id of the person who typed the message. */
  aadObjectId: string | null;
  fromName: string | null;
  /** The message with the bot mention removed. */
  text: string;
  conversationId: string | null;
  teamName: string | null;
  serviceUrl: string | null;
}

interface RawActivity {
  type?: string;
  text?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  conversation?: { id?: string; name?: string };
  channelData?: { team?: { name?: string }; teamsTeamId?: string };
  serviceUrl?: string;
}

/** Pull the one shape this adapter cares about out of a Teams activity. */
export function readActivity(body: unknown, botName = "PTD"): TeamsActivity | null {
  const activity = (body ?? {}) as RawActivity;
  if (typeof activity.text !== "string" && activity.type !== "message") return null;
  return {
    type: activity.type ?? null,
    aadObjectId: activity.from?.aadObjectId ?? null,
    fromName: activity.from?.name ?? null,
    text: stripMention(activity.text ?? "", botName),
    conversationId: activity.conversation?.id ?? null,
    teamName: activity.channelData?.team?.name ?? activity.conversation?.name ?? null,
    serviceUrl: activity.serviceUrl ?? null,
  };
}

/** `@PTD unlink` is the adapter's own plumbing, but it belongs in help. */
const HELP_EXTRAS = [{ usage: `${TEAMS_PREFIX}unlink`, summary: "disconnect this Teams account from PTD" }];

export interface TeamsDeps extends DispatchDeps {
  link: typeof linkTeamsIdentity;
  unlink: typeof unlinkTeamsIdentity;
  resolveCaller: typeof resolveTeamsCaller;
}

export const defaultTeamsDeps: TeamsDeps = {
  ...defaultDispatchDeps,
  link: linkTeamsIdentity,
  unlink: unlinkTeamsIdentity,
  resolveCaller: resolveTeamsCaller,
};

export interface Handled {
  reply: Reply;
  command: string;
  orgId: number;
}

export function linkInstructions(orgName?: string | null): Reply {
  return ephemeral(
    [
      "*This Teams account is not linked to a PTD user yet.*",
      `Open PTD${orgName ? ` (${orgName})` : ""} → *Org → Integrations → Microsoft Teams*, mint a link code, then send \`@PTD link <code>\` here.`,
    ],
    ["codes last ten minutes and work once"],
  );
}

function accountLabel(activity: TeamsActivity): string {
  return escape(activity.fromName ?? activity.aadObjectId ?? "this account");
}

/**
 * One @mention → one reply.
 *
 * The organization is already known (the webhook secret named it), so unlike Telegram
 * there is nothing to choose; and `link`/`unlink` run before the caller is resolved,
 * because they are how a caller comes to exist.
 */
export async function handleTeamsActivity(
  input: { activity: TeamsActivity; orgId: number; orgName: string | null; teamName: string | null },
  overrides: Partial<TeamsDeps> = {},
): Promise<Handled> {
  const deps: TeamsDeps = { ...defaultTeamsDeps, ...overrides };
  const aadObjectId = input.activity.aadObjectId;
  const words = input.activity.text.split(/\s+/).filter(Boolean);
  const command = (words[0] ?? "").toLowerCase();

  if (!aadObjectId) {
    return {
      command,
      orgId: input.orgId,
      reply: errorReply("Teams did not tell me who you are.", [
        "the outgoing webhook must be @mentioned from a Teams account with an Entra (Azure AD) identity",
      ]),
    };
  }

  if (command === "link") {
    const { reply } = await runLinkFlow({
      provider: TEAMS_PROVIDER,
      accountKey: aadObjectId,
      orgId: input.orgId,
      orgName: input.orgName,
      code: words[1],
      now: Date.now(),
      example: `${TEAMS_PREFIX}link ABC123`,
      mintPath: "PTD → Org → Integrations → Microsoft Teams",
      scopeLabel: "Teams team",
      account: accountLabel(input.activity),
      suggestions: ["`@PTD next`", "`@PTD start PTD-12`", "`@PTD today`"],
      link: (entry) => deps.link(entry.userId, aadObjectId),
    });
    return { command: "link", orgId: input.orgId, reply };
  }

  if (command === "unlink") {
    const removed = await deps.unlink(aadObjectId);
    if (removed === 0) return { command, orgId: input.orgId, reply: errorReply("This Teams account was not linked to a PTD user.") };
    return {
      command,
      orgId: input.orgId,
      reply: ephemeral(["*Unlinked.* This Teams account no longer acts as a PTD user."], ["`@PTD link <code>` to link it again"]),
    };
  }

  const caller = await deps.resolveCaller(input.orgId, aadObjectId);
  if (!caller.ok) {
    if (caller.reason === "no_membership") {
      return {
        command,
        orgId: input.orgId,
        reply: errorReply(`Your PTD account is not a member of ${input.orgName ?? "the organization"} this team is connected to.`, [
          "ask an admin for an invitation, or `@PTD unlink` and link the right account",
        ]),
      };
    }
    return { command, orgId: input.orgId, reply: linkInstructions(input.orgName) };
  }

  const { reply } = await dispatchCommand(
    {
      ctx: caller.ctx,
      text: input.activity.text,
      prefix: TEAMS_PREFIX,
      who: { account: accountLabel(input.activity), scope: input.teamName ?? input.activity.teamName },
      helpExtras: HELP_EXTRAS,
      surface: "teams",
    },
    deps,
  );
  return { command, orgId: input.orgId, reply };
}
