import { TASK_STATUSES } from "../../../db/schema";
import { ActionError, getAction, type ActionContext } from "../../actions/registry";
import { hasRole } from "../../types";
import {
  ephemeral,
  escape,
  rec,
  str,
  renderDone,
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
  type Reply,
} from "./format";
import { resolveTaskRef, type TaskRef } from "./identity";
import { extractKeyValues, formatMinutes, parseDuration, parseIsoDate, parseNumber, parsePositiveInt } from "./parse";

/**
 * The PTD chat vocabulary — one table, three surfaces.
 *
 * Each verb is a thin translation of words into a registry action's input schema plus
 * the rendering of what comes back. The role gate, the org scoping and the work
 * itself all stay in the registry, so no chat surface can do something the web app or
 * MCP could not. `resolveTask` and `now` are injected so the mapping can be tested
 * without a database.
 *
 * Slack types these as `/ptd next`, Telegram as `/next` and Teams as `@PTD next`;
 * that is the whole difference, and it is the `prefix` on {@link VerbInput}. Adding a
 * verb here adds it to all three at once — which is the point of the table existing.
 */

export interface VerbDeps {
  resolveTask: (orgId: number, ref: string) => Promise<TaskRef>;
  now: () => number;
}

export const defaultVerbDeps: VerbDeps = {
  resolveTask: resolveTaskRef,
  now: () => Date.now(),
};

export interface VerbInput {
  ctx: ActionContext;
  /** Whitespace-separated words after the verb. */
  args: string[];
  /** Everything after the verb, verbatim (used for free-text notes). */
  rest: string;
  /** How a command is typed on this surface: `"/ptd "`, `"/"` or `"@PTD "`. */
  prefix: string;
  deps: VerbDeps;
  /** The chat account and scope, for `who`. Pre-escaped by the adapter. */
  who: { account: string; scope: string | null };
}

export interface Verb {
  name: string;
  action: string;
  /** Argument syntax after the verb, e.g. `"<TASK-KEY> [notes]"`. */
  tail: string;
  summary: string;
  build(input: VerbInput): Promise<Record<string, unknown>>;
  render(result: unknown, input: VerbInput): Reply;
}

/** `usageOf(start, "/ptd ")` → `"/ptd start <TASK-KEY> [notes]"`. */
export function usageOf(verb: Pick<Verb, "name" | "tail">, prefix: string): string {
  return `${prefix}${verb.name}${verb.tail ? ` ${verb.tail}` : ""}`;
}

const MAX_LOG_MINUTES = 24 * 60;

/** An example of this verb as typed on the caller's surface, for an error message. */
function example(input: VerbInput, tail: string): string {
  return `${input.prefix}${tail}`;
}

async function taskIdFrom(input: VerbInput, ref: string | undefined, usage: string): Promise<number> {
  if (!ref) throw new ActionError("invalid", `Name a task — \`${usage}\``);
  const task = await input.deps.resolveTask(input.ctx.orgId, ref);
  return task.id;
}

/** The whole chat vocabulary, in help order. */
export const VERBS: Verb[] = [
  {
    name: "next",
    action: "next_task",
    tail: "",
    summary: "the highest-priority task worth starting",
    build: async () => ({ assignee: "me" }),
    render: (result, input) => renderNext(result, input.prefix),
  },
  {
    name: "start",
    action: "time_entry.start",
    tail: "<TASK-KEY> [notes]",
    summary: "start your timer on a task",
    build: async (input) => {
      const taskId = await taskIdFrom(input, input.args[0], example(input, "start PTD-12"));
      const notes = input.args.slice(1).join(" ").trim();
      return { taskId, ...(notes ? { notes } : {}) };
    },
    render: (result, input) => renderStart(result, input.prefix),
  },
  {
    name: "stop",
    action: "time_entry.stop",
    tail: "[tokens=N] [cost=0.12] [notes]",
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
    tail: "45m <TASK-KEY> [notes]",
    summary: "log a finished session that ended just now",
    build: async (input) => {
      const minutes = parseDuration(input.args[0] ?? "");
      if (minutes === null) {
        throw new ActionError("invalid", `How long? Use \`45m\`, \`1h30m\` or \`90\` — \`${example(input, "log 45m PTD-12")}\``);
      }
      if (minutes > MAX_LOG_MINUTES) throw new ActionError("invalid", `${formatMinutes(minutes)} is longer than a day — log it in PTD instead.`);
      const taskId = await taskIdFrom(input, input.args[1], example(input, "log 45m PTD-12"));
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
    tail: "",
    summary: "your day so far",
    build: async () => ({}),
    render: (result) => renderToday(result),
  },
  {
    name: "tasks",
    action: "task.list",
    tail: "[status]",
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
    tail: "<TASK-KEY> <YYYY-MM-DD> [days]",
    summary: "put a task on the timeline (cascades its dependents)",
    build: async (input) => {
      const taskId = await taskIdFrom(input, input.args[0], example(input, "plan PTD-12 2026-10-01"));
      const startDate = parseIsoDate(input.args[1] ?? "");
      if (!startDate) {
        throw new ActionError("invalid", `Give the start date as \`YYYY-MM-DD\` — \`${example(input, "plan PTD-12 2026-10-01 3")}\``);
      }
      const days = input.args[2] !== undefined ? parsePositiveInt(input.args[2]) : null;
      if (input.args[2] !== undefined && days === null) throw new ActionError("invalid", `\`${input.args[2]}\` is not a number of days.`);
      return { taskId, startDate, ...(days !== null ? { estimatedDuration: days } : {}) };
    },
    render: (result) => renderPlan(result),
  },
  {
    name: "done",
    action: "task.complete",
    tail: "<TASK-KEY>",
    summary: "mark a task complete",
    build: async (input) => {
      const taskId = await taskIdFrom(input, input.args[0], example(input, "done PTD-12"));
      const note = input.args.slice(1).join(" ").trim();
      return { taskId, ...(note ? { note } : {}) };
    },
    render: (result) => renderDone(result),
  },
  {
    name: "comment",
    action: "task.comment_add",
    tail: "<TASK-KEY> <text>",
    summary: "add a comment to a task",
    build: async (input) => {
      const usage = example(input, "comment PTD-12 waiting on the vendor");
      const taskId = await taskIdFrom(input, input.args[0], usage);
      const body = input.args.slice(1).join(" ").trim();
      if (!body) throw new ActionError("invalid", `What should the comment say? — \`${usage}\``);
      return { taskId, body };
    },
    render: (result) => {
      const comment = rec(rec(result).comment);
      const body = (str(comment.body) ?? "").split("\n")[0];
      return ephemeral(["*Comment added.*", `> ${escape(body.slice(0, 240))}${body.length > 240 ? "…" : ""}`]);
    },
  },
  {
    name: "who",
    action: "whoami",
    tail: "",
    summary: "which PTD user this chat account is",
    build: async () => ({}),
    render: (result, input) => renderWho(result, input.who),
  },
  {
    name: "stats",
    action: "stats",
    tail: "",
    summary: "organization KPI roll-up",
    build: async () => ({}),
    render: (result) => renderStats(result),
  },
];

const BY_NAME = new Map(VERBS.map((v) => [v.name, v]));

/** Aliases for the words people actually type. */
export const ALIASES: Record<string, string> = {
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

export function canonicalVerb(word: string): string {
  const lowered = (word ?? "").toLowerCase();
  return ALIASES[lowered] ?? lowered;
}

export function verbByName(name: string): Verb | undefined {
  return BY_NAME.get(name);
}

export function requiredRoleOf(actionName: string) {
  return getAction(actionName)?.requiredRole ?? "member";
}

/** The help table for one caller on one surface, with the role gate already applied. */
export function helpEntriesFor(ctx: ActionContext, prefix: string, extras: { usage: string; summary: string }[] = []): HelpEntry[] {
  const entries: HelpEntry[] = VERBS.map((verb) => {
    const requiredRole = requiredRoleOf(verb.action);
    return {
      usage: usageOf(verb, prefix),
      summary: verb.summary,
      requiredRole,
      allowed: hasRole(ctx.role, requiredRole),
      name: verb.name,
    };
  });
  for (const extra of extras) {
    entries.push({ usage: extra.usage, summary: extra.summary, requiredRole: "member", allowed: true, name: extra.usage.trim().split(" ").pop() });
  }
  return entries;
}
