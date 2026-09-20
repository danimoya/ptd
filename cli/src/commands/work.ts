/**
 * The sugar: eight commands that each wrap one action with the arguments a person
 * would otherwise have to remember. Nothing here has privileges of its own — the
 * role gate lives in the server's registry.
 */
import { numberFlag, parseDuration, stringFlag } from "../args.ts";
import { callAction } from "../api.ts";
import { bold, cyan, dim, green, yellow } from "../color.ts";
import { CliError, UsageError } from "../errors.ts";
import { json, keyValue, minutes, summarize, table } from "../table.ts";
import { label, listTasks, resolveTask } from "../tasks.ts";
import type { Ctx } from "../context.ts";

/* ── reads ───────────────────────────────────────────────────────────── */

export async function next(ctx: Ctx): Promise<void> {
  const args: Record<string, unknown> = {};
  const stream = stringFlag(ctx.flags, "stream");
  const app = stringFlag(ctx.flags, "app");
  const assignee = stringFlag(ctx.flags, "assignee");
  if (stream !== undefined) args.streamId = scope(stream, "--stream");
  if (app !== undefined) args.appId = scope(app, "--app");
  if (assignee !== undefined) args.assignee = /^\d+$/.test(assignee) ? Number(assignee) : assignee;

  const result = (await callAction(ctx.client, "next_task", args)) as { task?: Record<string, unknown> | null; why?: Record<string, unknown> | null };
  if (ctx.raw) return ctx.print(json(result));
  const task = result?.task;
  if (!task) return ctx.print(dim("Nothing to start: no backlog or triaged card matches."));

  ctx.print(bold(label(task as never)));
  ctx.print(
    keyValue({
      status: task.status,
      priority: `${task.priorityScore} (${result.why?.band ?? "?"})`,
      why: result.why?.formula,
      stream: task.streamName ?? dim("—"),
      app: task.appKey ?? dim("—"),
      assignee: task.assigneeName ?? dim("unclaimed"),
      due: (task.dueDate as string | null)?.slice(0, 10) ?? dim("—"),
    }),
  );
  ctx.print(dim(`\nStart it with \`ptd start ${task.externalKey ?? task.id}\`.`));
}

export async function tasks(ctx: Ctx): Promise<void> {
  const args: Record<string, unknown> = {};
  const status = stringFlag(ctx.flags, "status");
  const stream = stringFlag(ctx.flags, "stream");
  const app = stringFlag(ctx.flags, "app");
  if (status) args.status = status;
  if (stream !== undefined) args.streamId = scope(stream, "--stream") === "none" ? null : Number(stream);
  if (app !== undefined) args.appId = scope(app, "--app") === "none" ? null : Number(app);
  if (ctx.flags.has("all")) args.includeCompleted = true;

  const rows = await listTasks(ctx.client, callAction, args);
  const filtered = ctx.flags.has("all") ? rows : rows.filter((t) => t.completed !== true);
  let visible = filtered;
  if (ctx.flags.has("mine")) {
    const me = (await callAction(ctx.client, "whoami")) as { userId?: number };
    visible = filtered.filter((t) => t.assignedTo === me?.userId);
  }
  if (ctx.raw) return ctx.print(json(visible));
  if (visible.length === 0) return ctx.print(dim("No tasks match."));
  ctx.print(
    table(
      visible.map((t) => ({
        key: t.externalKey ?? "",
        id: t.id,
        pri: t.priorityScore ?? 0,
        status: t.status ?? "",
        due: typeof t.dueDate === "string" ? t.dueDate.slice(0, 10) : "",
        title: t.title ?? "",
      })),
      ["key", { key: "id", numeric: true }, { key: "pri", numeric: true }, "status", "due", { key: "title", max: 56 }],
    ),
  );
  ctx.print(dim(`\n${visible.length} task${visible.length === 1 ? "" : "s"}.`));
}

export async function today(ctx: Ctx): Promise<void> {
  const result = (await callAction(ctx.client, "today_summary")) as {
    date?: string;
    minutes?: number;
    breakMinutes?: number;
    bySource?: { human?: { minutes?: number }; agent?: { minutes?: number; tokens?: number; costUsd?: number } };
    byStream?: { streamName?: string | null; minutes?: number; bySource?: { human?: { minutes?: number }; agent?: { minutes?: number; costUsd?: number } } }[];
    open?: { id?: number; taskId?: number | null; isBreak?: boolean; elapsedMinutes?: number; notes?: string | null } | null;
  };
  if (ctx.raw) return ctx.print(json(result));

  ctx.print(bold(`Today — ${result.date ?? ""}`));
  ctx.print(
    keyValue({
      worked: minutes(result.minutes),
      breaks: minutes(result.breakMinutes),
      human: minutes(result.bySource?.human?.minutes),
      agent: `${minutes(result.bySource?.agent?.minutes)} · ${result.bySource?.agent?.tokens ?? 0} tokens · $${(result.bySource?.agent?.costUsd ?? 0).toFixed(2)}`,
    }),
  );
  const streams = result.byStream ?? [];
  if (streams.length) {
    ctx.print("");
    ctx.print(
      table(
        streams.map((s) => ({
          stream: s.streamName ?? "(no stream)",
          total: minutes(s.minutes),
          human: minutes(s.bySource?.human?.minutes),
          agent: minutes(s.bySource?.agent?.minutes),
          cost: `$${(s.bySource?.agent?.costUsd ?? 0).toFixed(2)}`,
        })),
        ["stream", "total", "human", "agent", "cost"],
      ),
    );
  }
  if (result.open) {
    const what = result.open.isBreak ? "break" : "session";
    ctx.print("");
    ctx.print(cyan(`Running: ${what} #${result.open.id} for ${minutes(result.open.elapsedMinutes)}${result.open.notes ? ` — ${result.open.notes}` : ""}`));
  }
}

export async function stats(ctx: Ctx): Promise<void> {
  const result = await callAction(ctx.client, "stats");
  if (ctx.raw) return ctx.print(json(result));
  ctx.print(summarize(result));
}

/* ── the timer ───────────────────────────────────────────────────────── */

export async function start(ctx: Ctx): Promise<void> {
  const ref = ctx.args[0];
  if (!ref) throw new UsageError("Name the task to start — `ptd start SEC-3 [notes…]`.", "start");
  const task = await resolveTask(ctx.client, ref);
  const notes = ctx.args.slice(1).join(" ").trim();
  const result = (await callAction(ctx.client, "time_entry.start", { taskId: task.id, ...(notes ? { notes } : {}) })) as {
    entry?: { id?: number; entrySource?: string; checkIn?: string };
    cut?: { id?: number; isBreak?: boolean; minutes?: number } | null;
  };
  if (ctx.raw) return ctx.print(json(result));
  if (result.cut) ctx.print(dim(`Cut the running ${result.cut.isBreak ? "break" : "session"} #${result.cut.id} after ${minutes(result.cut.minutes)}.`));
  ctx.print(green(`Started entry #${result.entry?.id} on ${label(task)}`));
  ctx.print(keyValue({ source: result.entry?.entrySource, since: result.entry?.checkIn, notes: notes || dim("—") }));
}

export async function stop(ctx: Ctx): Promise<void> {
  const args: Record<string, unknown> = {};
  const tokens = numberFlag(ctx.flags, "tokens");
  const cost = numberFlag(ctx.flags, "cost");
  if (tokens !== undefined) args.tokensUsed = tokens;
  if (cost !== undefined) args.apiCostUsd = cost;
  const notes = ctx.args.join(" ").trim();
  if (notes) args.notes = notes;

  const result = (await callAction(ctx.client, "time_entry.stop", args)) as {
    entry?: { id?: number; entrySource?: string; tokensUsed?: number | null; apiCostUsd?: number | null };
    minutes?: number;
    ignored?: string[];
    ignoredReason?: string;
  };
  if (ctx.raw) return ctx.print(json(result));
  ctx.print(green(`Stopped entry #${result.entry?.id} after ${minutes(result.minutes)}.`));
  if (result.entry?.entrySource === "agent") {
    ctx.print(keyValue({ tokens: result.entry.tokensUsed ?? 0, cost: `$${(result.entry.apiCostUsd ?? 0).toFixed(4)}` }));
  }
  if (result.ignored?.length) {
    ctx.print(yellow(`Ignored ${result.ignored.join(", ")}${result.ignoredReason ? ` — ${result.ignoredReason}` : ""}`));
  }
}

export async function log(ctx: Ctx): Promise<void> {
  const [durationText, ref, ...rest] = ctx.args;
  if (!durationText || !ref) throw new UsageError("`ptd log 45m SEC-3 [notes…]`", "log");
  const mins = parseDuration(durationText);
  if (mins === null || mins <= 0) throw new UsageError(`"${durationText}" is not a duration — try 45m, 1h30m or 90.`, "log");
  if (mins > 24 * 60) throw new CliError("A single entry may not span more than 24 hours.");

  const task = await resolveTask(ctx.client, ref);
  const checkOut = new Date();
  const checkIn = new Date(checkOut.getTime() - mins * 60_000);
  const notes = rest.join(" ").trim();
  const result = (await callAction(ctx.client, "time_entry.log_past", {
    taskId: task.id,
    checkIn: checkIn.toISOString(),
    checkOut: checkOut.toISOString(),
    ...(notes ? { notes } : {}),
  })) as { entry?: { id?: number; entrySource?: string }; minutes?: number; ignored?: string[] };

  if (ctx.raw) return ctx.print(json(result));
  ctx.print(green(`Logged ${minutes(result.minutes)} on ${label(task)} as entry #${result.entry?.id} (${result.entry?.entrySource}).`));
  if (result.ignored?.length) ctx.print(yellow(`Ignored ${result.ignored.join(", ")}.`));
}

export async function done(ctx: Ctx): Promise<void> {
  const ref = ctx.args[0];
  if (!ref) throw new UsageError("Name the task to complete — `ptd done SEC-3 [note…]`.", "done");
  const task = await resolveTask(ctx.client, ref);
  const note = ctx.args.slice(1).join(" ").trim();
  const result = (await callAction(ctx.client, "task.complete", { taskId: task.id, ...(note ? { note } : {}) })) as {
    task?: { status?: string };
    changed?: boolean;
  };
  if (ctx.raw) return ctx.print(json(result));
  ctx.print(result.changed === false ? dim(`${label(task)} was already complete.`) : green(`Completed ${label(task)}.`));
}

/* ── helpers ─────────────────────────────────────────────────────────── */

/** `--stream 4` → 4; `--stream none` → "none"; anything else is a usage error. */
function scope(value: string, flag: string): number | "none" {
  if (value === "none" || value === "null") return "none";
  if (/^\d+$/.test(value)) return Number(value);
  throw new UsageError(`${flag} takes an id or "none", got "${value}".`);
}
