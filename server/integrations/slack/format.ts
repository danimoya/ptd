import type { Role } from "../../../db/schema";
import { formatMinutes } from "./parse";

/**
 * Block Kit rendering.
 *
 * Every reply is ephemeral (only the person who typed the command sees it) and
 * mrkdwn — Slack's dialect, not Markdown: `*bold*`, `_italic_`, backticks for code.
 * Action results arrive as `unknown` from the registry, so everything here reads
 * defensively rather than casting: a field that moves shape shows as "—" instead of
 * crashing the command.
 */

export interface SlackReply {
  response_type: "ephemeral" | "in_channel";
  text: string;
  blocks: unknown[];
}

/** Slack's three reserved characters. Content from PTD is escaped before it is shown. */
export function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
export const contextLine = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
export const divider = { type: "divider" } as const;

/**
 * Timestamps reach here as a Date (the registry called in-process, e.g. from the
 * slash command) or as an ISO string (the same action's JSON over HTTP). Normalise
 * both, or a perfectly good timestamp renders as a dash.
 */
export function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value.length > 0) return Number.isNaN(Date.parse(value)) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

/** Slack renders a `!date` token in the viewer's own timezone — better than guessing one. */
export function slackTime(value: unknown, fallback = "—"): string {
  const stamp = iso(value);
  if (!stamp) return fallback;
  const epoch = Math.floor(Date.parse(stamp) / 1000);
  return `<!date^${epoch}^{date_short_pretty} {time}|${stamp.slice(0, 16).replace("T", " ")}Z>`;
}

export function ephemeral(lines: string[], context?: string[]): SlackReply {
  const body = lines.filter((l) => l.length > 0).join("\n");
  const blocks: unknown[] = [section(body.slice(0, 2900) || "—")];
  const extras = (context ?? []).filter((l) => l.length > 0);
  if (extras.length > 0) blocks.push(contextLine(extras.join("  ·  ")));
  return { response_type: "ephemeral", text: stripMrkdwn(body), blocks };
}

/** Plain-text fallback for notifications and accessibility. */
export function stripMrkdwn(text: string): string {
  return text
    .replace(/<!date\^\d+\^[^|]*\|([^>]*)>/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\n+/g, " · ")
    .slice(0, 300);
}

/* ── readers for `unknown` action results ─────────────────────────────── */

export const rec = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
export const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
export const int = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const n0 = (value: unknown): number => int(value) ?? 0;

export interface Taskish {
  id: number | null;
  title: string;
  externalKey: string | null;
  status: string | null;
  priorityScore: number | null;
  dueDate: string | null;
  streamName: string | null;
  assignedTo: number | null;
  assigneeName: string | null;
}

export function taskish(value: unknown): Taskish {
  const t = rec(value);
  return {
    id: int(t.id),
    title: str(t.title) ?? "(untitled)",
    externalKey: str(t.externalKey),
    status: str(t.status),
    priorityScore: int(t.priorityScore),
    dueDate: iso(t.dueDate),
    streamName: str(t.streamName),
    assignedTo: int(t.assignedTo),
    assigneeName: str(t.assigneeName),
  };
}

/**
 * Who holds the card. `task.list` serializes only the id while `tasks.query` joins
 * the name, and calling something "unassigned" because this payload happens not to
 * carry a name would be a lie.
 */
export function assigneeLabel(task: Taskish): string {
  if (task.assigneeName) return escape(task.assigneeName);
  if (task.assignedTo !== null) return `assigned to #${task.assignedTo}`;
  return "unassigned";
}

/** `` `PTD-12` Ship the adapter `` — the key if there is one, else `#id`. */
export function taskLabel(task: Taskish): string {
  const key = task.externalKey ?? (task.id !== null ? `#${task.id}` : "?");
  return `\`${escape(key)}\` ${escape(task.title)}`;
}

/* ── per-subcommand renderers ─────────────────────────────────────────── */

export function renderNext(result: unknown): SlackReply {
  const payload = rec(result);
  if (!payload.task) {
    return ephemeral(["*Nothing claimable right now.*"], ["everything in scope is assigned to someone else, done, or blocked"]);
  }
  const task = taskish(payload.task);
  const why = rec(payload.why);
  const facts = [
    task.priorityScore !== null ? `score *${task.priorityScore}*` : "",
    str(why.band) ? `${escape(str(why.band)!)}` : "",
    task.status ? escape(task.status) : "",
    task.streamName ? `stream ${escape(task.streamName)}` : "",
    task.dueDate ? `due ${task.dueDate.slice(0, 10)}` : "",
  ].filter(Boolean);
  const key = task.externalKey ?? String(task.id ?? "");
  return ephemeral(
    [`*Next up* — ${taskLabel(task)}`, facts.join(" · "), str(why.formula) ? `_${escape(str(why.formula)!)}_` : ""],
    [`start it with \`/ptd start ${escape(key)}\``],
  );
}

function entryOf(result: unknown): Record<string, unknown> {
  return rec(rec(result).entry);
}

export function renderStart(result: unknown): SlackReply {
  const entry = entryOf(result);
  const cut = rec(rec(result).cut);
  const target = str(entry.taskTitle) ?? str(entry.streamName) ?? "no task";
  const lines = [
    `*Timer running* — ${escape(target)}`,
    `since ${slackTime(entry.checkIn)}${str(entry.notes) ? ` · _${escape(str(entry.notes)!)}_` : ""}`,
  ];
  if (int(cut.id) !== null) lines.push(`_cut the previous ${cut.isBreak ? "break" : "session"} after ${formatMinutes(n0(cut.minutes))}_`);
  return ephemeral(lines, ["stop it with `/ptd stop`"]);
}

export function renderStop(result: unknown): SlackReply {
  const payload = rec(result);
  const entry = entryOf(result);
  const ignored = arr(payload.ignored).filter((v): v is string => typeof v === "string");
  const target = str(entry.taskTitle) ?? str(entry.streamName) ?? "no task";
  return ephemeral(
    [`*Stopped* — ${escape(target)}`, `${formatMinutes(n0(payload.minutes))} logged, ${slackTime(entry.checkIn)} → ${slackTime(entry.checkOut)}`],
    ignored.length > 0 ? [`${ignored.join(", ")} ignored — ${escape(str(payload.ignoredReason) ?? "only agent sessions carry tokens and cost")}`] : [],
  );
}

export function renderLog(result: unknown): SlackReply {
  const payload = rec(result);
  const entry = entryOf(result);
  const target = str(entry.taskTitle) ?? str(entry.streamName) ?? "no task";
  return ephemeral([
    `*Logged ${formatMinutes(n0(payload.minutes))}* — ${escape(target)}`,
    `${slackTime(entry.checkIn)} → ${slackTime(entry.checkOut)}${str(entry.notes) ? ` · _${escape(str(entry.notes)!)}_` : ""}`,
  ]);
}

export function renderToday(result: unknown): SlackReply {
  const payload = rec(result);
  const bySource = rec(payload.bySource);
  const human = rec(bySource.human);
  const agent = rec(bySource.agent);
  const lines = [
    `*Today* — ${formatMinutes(n0(payload.minutes))} worked${n0(payload.breakMinutes) > 0 ? `, ${formatMinutes(n0(payload.breakMinutes))} on breaks` : ""}`,
  ];
  if (n0(agent.minutes) > 0 || n0(agent.tokens) > 0) {
    lines.push(`human ${formatMinutes(n0(human.minutes))} · agent ${formatMinutes(n0(agent.minutes))} (${n0(agent.tokens).toLocaleString("en-US")} tokens, $${n0(agent.costUsd).toFixed(2)})`);
  }
  const streams = arr(payload.byStream).slice(0, 6);
  for (const raw of streams) {
    const s = rec(raw);
    lines.push(`• ${escape(str(s.streamName) ?? "(no stream)")} — ${formatMinutes(n0(s.minutes))}`);
  }
  const open = rec(payload.open);
  if (int(open.id) !== null) {
    lines.push(`_running now:_ ${escape(str(open.taskTitle) ?? str(open.streamName) ?? "no task")} · ${formatMinutes(n0(open.elapsedMinutes))}`);
  }
  return ephemeral(lines, [`date ${escape(str(payload.date) ?? "")}`]);
}

const MAX_ROWS = 10;

export function renderTasks(result: unknown, status?: string): SlackReply {
  const payload = rec(result);
  const tasks = arr(payload.tasks).map(taskish);
  const count = int(payload.count) ?? tasks.length;
  if (tasks.length === 0) return ephemeral([`*No ${status ? `${escape(status)} ` : ""}tasks.*`]);
  const lines = [`*${count} ${status ? `${escape(status)} ` : "open "}task${count === 1 ? "" : "s"}*`];
  for (const task of tasks.slice(0, MAX_ROWS)) {
    const bits = [task.priorityScore !== null ? `score ${task.priorityScore}` : "", task.status ? escape(task.status) : "", assigneeLabel(task)].filter(Boolean);
    lines.push(`• ${taskLabel(task)} — ${bits.join(" · ")}`);
  }
  return ephemeral(lines, tasks.length > MAX_ROWS ? [`showing ${MAX_ROWS} of ${tasks.length} — the rest are in PTD`] : []);
}

export function renderPlan(result: unknown): SlackReply {
  const payload = rec(result);
  const task = taskish(payload.task);
  const cascaded = arr(payload.cascaded);
  return ephemeral(
    [
      `*Scheduled* — ${taskLabel(task)}`,
      `${iso(rec(payload.task).startDate)?.slice(0, 10) ?? "—"} → ${iso(rec(payload.task).end)?.slice(0, 10) ?? "—"}${int(rec(payload.task).estimatedDuration) !== null ? ` · ${int(rec(payload.task).estimatedDuration)}d` : ""}`,
    ],
    cascaded.length > 0 ? [`${cascaded.length} dependent task${cascaded.length === 1 ? "" : "s"} shifted`] : [],
  );
}

export function renderDone(result: unknown): SlackReply {
  const payload = rec(result);
  const task = taskish(payload.task);
  if (payload.changed === false) return ephemeral([`${taskLabel(task)} was already complete.`]);
  return ephemeral([`*Done* — ${taskLabel(task)} :white_check_mark:`]);
}

export function renderWho(result: unknown, extra: { slackUserId: string; teamName: string | null }): SlackReply {
  const payload = rec(result);
  const org = rec(payload.org);
  return ephemeral(
    [
      `*${escape(str(payload.displayName) ?? "you")}* — ${escape(str(payload.email) ?? "")}`,
      `role *${escape(str(payload.role) ?? "?")}* in ${escape(str(org.name) ?? "your organization")} · authenticated as ${escape(str(payload.authType) ?? "human")}`,
    ],
    [`linked to <@${escape(extra.slackUserId)}>${extra.teamName ? ` in ${escape(extra.teamName)}` : ""}`],
  );
}

export function renderStats(result: unknown): SlackReply {
  const payload = rec(result);
  const tasks = rec(payload.tasks);
  const bands = rec(payload.byPriorityBand);
  const members = rec(payload.members);
  const cost = rec(payload.agentCost);
  const last7d = rec(cost.last7d);
  return ephemeral([
    `*Organization stats*`,
    `tasks: ${n0(tasks.open)} open · ${n0(tasks.inProgress)} in progress · ${n0(tasks.completed)} done · ${n0(payload.overdue)} overdue`,
    `priority: ${n0(bands.critical)} critical · ${n0(bands.high)} high · ${n0(bands.medium)} medium · ${n0(bands.low)} low`,
    `seats: ${n0(members.humans)} human · ${n0(members.agents)} agent · ${n0(payload.apps)} apps · ${n0(payload.streams)} streams`,
    `agent spend: $${n0(cost.costUsd).toFixed(2)} all time, $${n0(last7d.costUsd).toFixed(2)} in the last 7 days (${formatMinutes(n0(cost.minutes))})`,
  ]);
}

export interface HelpEntry {
  usage: string;
  summary: string;
  requiredRole: Role;
  allowed: boolean;
}

export function renderHelp(entries: HelpEntry[], role: Role): SlackReply {
  const allowed = entries.filter((e) => e.allowed);
  const hidden = entries.filter((e) => !e.allowed);
  const lines = [`*PTD commands* — your role is *${escape(role)}*`];
  for (const entry of allowed) lines.push(`\`${escape(entry.usage)}\` — ${escape(entry.summary)}`);
  const context = hidden.length > 0 ? [`${hidden.length} more command${hidden.length === 1 ? "" : "s"} need a higher role (${hidden.map((h) => h.usage.split(" ")[1] ?? h.usage).join(", ")})`] : [];
  return ephemeral(lines, context);
}

export function errorReply(text: string, hints: string[] = []): SlackReply {
  return ephemeral([text], hints);
}
