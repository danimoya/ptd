import { TASK_STATUSES } from "../../../db/schema";
import { ActionError, getAction, runAction, type ActionContext } from "../../actions/registry";
import { hasRole } from "../../types";
import {
  errorReply,
  ephemeral,
  renderDone,
  renderHelp,
  renderLog,
  renderNext,
  renderPlan,
  renderStart,
  renderStats,
  renderStop,
  renderTasks,
  renderToday,
  renderWho,
  type HelpEntry,
  type SlackReply,
} from "./format";
import { resolveTaskRef, externalIdFor, linkSlackIdentity, unlinkSlackIdentity, type TaskRef } from "./identity";
import {
  clearLinkFailures,
  consumeLinkCode,
  linkAttemptsBlocked,
  peekLinkCode,
  recordLinkFailure,
} from "./linkCodes";
import { extractKeyValues, formatMinutes, parseCommandText, parseDuration, parseIsoDate, parseNumber, parsePositiveInt } from "./parse";

/**
 * `/ptd …` → one registry action.
 *
 * Every subcommand is a thin translation of words into an action's input schema;
 * the role gate, the org scoping and the work itself all stay in the registry, so
 * Slack can never do something the web app or MCP could not. `runAction` and the
 * task lookup are injected so the mapping can be tested without a database.
 */

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

export interface CommandDeps {
  runAction: typeof runAction;
  resolveTask: (orgId: number, ref: string) => Promise<TaskRef>;
  linkIdentity: typeof linkSlackIdentity;
  unlinkIdentity: typeof unlinkSlackIdentity;
  now: () => number;
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

interface BuildInput extends DispatchInput {
  args: string[];
  rest: string;
  deps: CommandDeps;
}

interface Subcommand {
  name: string;
  action: string;
  usage: string;
  summary: string;
  build(input: BuildInput): Promise<Record<string, unknown>>;
  render(result: unknown, input: BuildInput): SlackReply;
}

const MAX_LOG_MINUTES = 24 * 60;

async function taskIdFrom(input: BuildInput, ref: string | undefined, usage: string): Promise<number> {
  if (!ref) throw new ActionError("invalid", `Name a task — \`${usage}\``);
  const task = await input.deps.resolveTask(input.ctx.orgId, ref);
  return task.id;
}

/** The whole Slack vocabulary, in help order. */
export const SUBCOMMANDS: Subcommand[] = [
  {
    name: "next",
    action: "next_task",
    usage: "/ptd next",
    summary: "the highest-priority task worth starting",
    build: async () => ({ assignee: "me" }),
    render: (result) => renderNext(result),
  },
  {
    name: "start",
    action: "time_entry.start",
    usage: "/ptd start <TASK-KEY> [notes]",
    summary: "start your timer on a task",
    build: async (input) => {
      const taskId = await taskIdFrom(input, input.args[0], "/ptd start PTD-12");
      const notes = input.args.slice(1).join(" ").trim();
      return { taskId, ...(notes ? { notes } : {}) };
    },
    render: (result) => renderStart(result),
  },
  {
    name: "stop",
    action: "time_entry.stop",
    usage: "/ptd stop [tokens=N] [cost=0.12] [notes]",
    summary: "stop your timer",
    build: async (input) => {
      const { values, rest } = extractKeyValues(input.args, ["tokens", "cost"]);
      const tokensUsed = parseNumber(values.tokens);
      const apiCostUsd = parseNumber(values.cost);
      if (values.tokens !== undefined && tokensUsed === null) throw new ActionError("invalid", `\`tokens=${values.tokens}\` is not a number.`);
      if (values.cost !== undefined && apiCostUsd === null) throw new ActionError("invalid", `\`cost=${values.cost}\` is not a number.`);
      const notes = rest.join(" ").trim();
      return {
        ...(tokensUsed !== null ? { tokensUsed: Math.round(tokensUsed) } : {}),
        ...(apiCostUsd !== null ? { apiCostUsd } : {}),
        ...(notes ? { notes } : {}),
      };
    },
    render: (result) => renderStop(result),
  },
  {
    name: "log",
    action: "time_entry.log_past",
    usage: "/ptd log 45m <TASK-KEY> [notes]",
    summary: "log a finished session that ended just now",
    build: async (input) => {
      const minutes = parseDuration(input.args[0] ?? "");
      if (minutes === null) throw new ActionError("invalid", "How long? Use `45m`, `1h30m` or `90` — `/ptd log 45m PTD-12`");
      if (minutes > MAX_LOG_MINUTES) throw new ActionError("invalid", `${formatMinutes(minutes)} is longer than a day — log it in PTD instead.`);
      const taskId = await taskIdFrom(input, input.args[1], "/ptd log 45m PTD-12");
      const end = input.deps.now();
      const notes = input.args.slice(2).join(" ").trim();
      return {
        checkIn: new Date(end - minutes * 60_000).toISOString(),
        checkOut: new Date(end).toISOString(),
        taskId,
        ...(notes ? { notes } : {}),
      };
    },
    render: (result) => renderLog(result),
  },
  {
    name: "today",
    action: "today_summary",
    usage: "/ptd today",
    summary: "your day so far",
    build: async () => ({}),
    render: (result) => renderToday(result),
  },
  {
    name: "tasks",
    action: "task.list",
    usage: "/ptd tasks [status]",
    summary: "the organization's open tasks",
    build: async (input) => {
      const status = input.args[0]?.toLowerCase();
      if (!status) return {};
      if (!(TASK_STATUSES as readonly string[]).includes(status)) {
        throw new ActionError("invalid", `\`${status}\` is not a status. Pick one of ${TASK_STATUSES.join(", ")}.`);
      }
      return { status, ...(status === "completed" || status === "wontfix" ? { includeCompleted: true } : {}) };
    },
    render: (result, input) => renderTasks(result, input.args[0]?.toLowerCase()),
  },
  {
    name: "plan",
    action: "task.schedule",
    usage: "/ptd plan <TASK-KEY> <YYYY-MM-DD> [days]",
    summary: "put a task on the timeline (cascades its dependents)",
    build: async (input) => {
      const taskId = await taskIdFrom(input, input.args[0], "/ptd plan PTD-12 2026-10-01");
      const startDate = parseIsoDate(input.args[1] ?? "");
      if (!startDate) throw new ActionError("invalid", "Give the start date as `YYYY-MM-DD` — `/ptd plan PTD-12 2026-10-01 3`");
      const days = input.args[2] !== undefined ? parsePositiveInt(input.args[2]) : null;
      if (input.args[2] !== undefined && days === null) throw new ActionError("invalid", `\`${input.args[2]}\` is not a number of days.`);
      return { taskId, startDate, ...(days !== null ? { estimatedDuration: days } : {}) };
    },
    render: (result) => renderPlan(result),
  },
  {
    name: "done",
    action: "task.complete",
    usage: "/ptd done <TASK-KEY>",
    summary: "mark a task complete",
    build: async (input) => {
      const taskId = await taskIdFrom(input, input.args[0], "/ptd done PTD-12");
      const note = input.args.slice(1).join(" ").trim();
      return { taskId, ...(note ? { note } : {}) };
    },
    render: (result) => renderDone(result),
  },
  {
    name: "who",
    action: "whoami",
    usage: "/ptd who",
    summary: "which PTD user this Slack account is",
    build: async () => ({}),
    render: (result, input) => renderWho(result, { slackUserId: input.payload.userId, teamName: input.teamName }),
  },
  {
    name: "stats",
    action: "stats",
    usage: "/ptd stats",
    summary: "organization KPI roll-up",
    build: async () => ({}),
    render: (result) => renderStats(result),
  },
];

const BY_NAME = new Map(SUBCOMMANDS.map((s) => [s.name, s]));

/** Aliases for the words people actually type. */
const ALIASES: Record<string, string> = {
  "": "help",
  "?": "help",
  h: "help",
  begin: "start",
  end: "stop",
  finish: "done",
  complete: "done",
  close: "done",
  list: "tasks",
  backlog: "tasks",
  me: "who",
  whoami: "who",
  schedule: "plan",
  day: "today",
};

export function canonicalSub(sub: string): string {
  const lowered = sub.toLowerCase();
  return ALIASES[lowered] ?? lowered;
}

function requiredRoleOf(actionName: string) {
  return getAction(actionName)?.requiredRole ?? "member";
}

export function helpEntries(ctx: ActionContext): HelpEntry[] {
  const entries: HelpEntry[] = SUBCOMMANDS.map((sub) => {
    const requiredRole = requiredRoleOf(sub.action);
    return { usage: sub.usage, summary: sub.summary, requiredRole, allowed: hasRole(ctx.role, requiredRole) };
  });
  entries.push({ usage: "/ptd unlink", summary: "disconnect this Slack account from PTD", requiredRole: "member", allowed: true });
  return entries;
}

/* ── dispatch ─────────────────────────────────────────────────────────── */

export async function handleSlashCommand(input: DispatchInput, overrides: Partial<CommandDeps> = {}): Promise<SlackReply> {
  const deps: CommandDeps = { ...defaultDeps, ...overrides };
  const parsed = parseCommandText(input.payload.text);
  const name = canonicalSub(parsed.sub);

  if (name === "help") return renderHelp(helpEntries(input.ctx), input.ctx.role);
  if (name === "link") {
    return ephemeral(
      ["*This Slack account is already linked.*"],
      ["`/ptd unlink` first if you need to point it at a different PTD user"],
    );
  }

  const sub = BY_NAME.get(name);
  if (!sub) {
    return errorReply(`I don't know \`${input.payload.command} ${parsed.sub}\`.`, ["`/ptd help` lists what you can run"]);
  }

  const requiredRole = requiredRoleOf(sub.action);
  if (!hasRole(input.ctx.role, requiredRole)) {
    return errorReply(`Your role (${input.ctx.role}) can't do that — ask a manager.`, [`\`${sub.usage}\` needs ${requiredRole} or higher`]);
  }

  const buildInput: BuildInput = { ...input, args: parsed.args, rest: parsed.rest, deps };
  try {
    const args = await sub.build(buildInput);
    const result = await deps.runAction(sub.action, args, input.ctx);
    return sub.render(result, buildInput);
  } catch (err) {
    return failureReply(err, sub, input.ctx.role);
  }
}

function failureReply(err: unknown, sub: Subcommand, role: string): SlackReply {
  if (err instanceof ActionError) {
    switch (err.code) {
      case "forbidden":
        return errorReply(`Your role (${role}) can't do that — ask a manager.`, [err.message]);
      case "not_found":
        return errorReply(`Nothing found. ${err.message}`, [`\`${sub.usage}\``]);
      case "invalid":
        return errorReply(err.message, [`\`${sub.usage}\``]);
      case "conflict":
        return errorReply(err.message);
    }
  }
  console.error(`[slack] ${sub.action} failed:`, err);
  return errorReply("Something went wrong on the PTD side — the server log has the details.");
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
  const key = externalIdFor(input.payload.teamId, input.payload.userId);
  const now = deps.now();

  if (linkAttemptsBlocked(key, now)) {
    return errorReply("Too many bad codes. Wait ten minutes, then mint a fresh one in PTD.");
  }
  if (!input.code) {
    return errorReply("Give me the code: `/ptd link ABC123`.", ["mint one in PTD → Org → Integrations → Slack"]);
  }

  const peeked = peekLinkCode(input.code, now);
  if (!peeked) {
    const { failures } = recordLinkFailure(key, now);
    return errorReply("That code is not valid — it may have expired, or already been used.", [`mint a fresh one in PTD (attempt ${failures})`]);
  }
  if (peeked.orgId !== input.orgId) {
    const { failures } = recordLinkFailure(key, now);
    return errorReply(
      "That code belongs to a different PTD organization than this Slack workspace is connected to.",
      [`mint the code while the ${input.orgName ?? "connected"} organization is selected (attempt ${failures})`],
    );
  }

  const entry = consumeLinkCode(input.code, now);
  if (!entry) {
    recordLinkFailure(key, now);
    return errorReply("That code expired while we were looking at it — mint a fresh one.");
  }
  await deps.linkIdentity(entry.userId, input.payload.teamId, input.payload.userId);
  clearLinkFailures(key);
  return ephemeral(
    [`*Linked.* <@${input.payload.userId}> is now ${entry.displayName} in PTD${input.orgName ? ` (${input.orgName})` : ""}.`],
    ["try `/ptd next`, `/ptd start PTD-12`, `/ptd today`"],
  );
}

export async function handleUnlink(input: { payload: SlashPayload }, overrides: Partial<CommandDeps> = {}): Promise<SlackReply> {
  const deps: CommandDeps = { ...defaultDeps, ...overrides };
  const removed = await deps.unlinkIdentity(input.payload.teamId, input.payload.userId);
  if (removed === 0) return errorReply("This Slack account was not linked to a PTD user.");
  return ephemeral(["*Unlinked.* This Slack account no longer acts as a PTD user."], ["`/ptd link <code>` to link it again"]);
}
