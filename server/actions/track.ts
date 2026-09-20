// track actions — registered by importing this module (see ./index.ts).
//
// The Track surface: one timer per member, one ledger per day, and the
// human-vs-agent accounting that the rest of the product reads.
//
// Two invariants hold across every action here:
//
//  1. Attribution is server-decided. `entry_source` comes from ctx.authType —
//     i.e. from the credential presented to the auth middleware — and
//     `tokensUsed` / `apiCostUsd` are stored only for agent-sourced entries.
//     No action accepts `entrySource` or `agentLabel` as input, and
//     `time_entry.update` cannot touch any of the four columns, so an entry's
//     attribution is immutable once written. See server/track/attribution.ts.
//
//  2. A member has at most one open entry. `time_entry.start` refuses to open a
//     second work session (the original tracker's behaviour); a break "cuts" — it closes the
//     running session and opens the break in the same call.

import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { customers, entryTemplates, streams, timeEntries } from "../../db/schema";
import { ActionError, defineAction, type ActionContext } from "./registry";
import { hasRole } from "../types";
import { getWebSocketManager } from "../websocket";
import { actorFrom, recordEvent } from "../plan/taskEvents";
import { agentMetricsFor, attributionFor, type EntrySource } from "../track/attribution";
import { emptyBySource, entryMinutes, foldGroups, minutesFrom, num, totalMinutes, usd, type BySource } from "../track/aggregate";
import {
  MAX_ENTRY_MS,
  endOfDay,
  entryForWrite,
  groupedTotals,
  openEntryFor,
  parseWhen,
  resolveRefs,
  selectEntries,
  startOfDay,
  templateFor,
  viewEntry,
  windowFilters,
} from "../track/entries";

/* ── Shared input pieces ─────────────────────────────────────────────── */

const idIn = (what: string) => z.number().int().positive().describe(what);
const notesIn = z.string().max(2000).describe("Free-text note shown on the ledger line.");
const whenIn = (what: string) => z.string().min(8).max(40).describe(`${what} as an ISO-8601 datetime (or YYYY-MM-DD for midnight local).`);
const tokensIn = z.number().int().min(0).max(1_000_000_000).describe("Model tokens this session consumed. Stored only when the entry's source is 'agent' — ignored, and reported back in `ignored`, for human sessions.");
const costIn = z.number().min(0).max(1_000_000).describe("API cost of this session in USD. Stored only when the entry's source is 'agent'.");

const refsIn = {
  taskId: idIn("Task to attribute the work to. Its stream (and that stream's customer) are adopted when you do not name them.").optional(),
  streamId: idIn("Stream (swim-lane) to attribute the work to.").optional(),
  customerId: idIn("Customer to bill the work to. Defaults to the stream's customer.").optional(),
};

const manager = (ctx: ActionContext) => hasRole(ctx.role, "manager");

function ws() {
  return getWebSocketManager();
}

function timerPayload(entry: { id: number; checkIn: Date; isBreak: boolean; streamId: number | null; taskId: number | null; entrySource: string }) {
  return {
    entryId: entry.id,
    checkIn: entry.checkIn,
    isBreak: entry.isBreak,
    streamId: entry.streamId,
    taskId: entry.taskId,
    entrySource: entry.entrySource,
  };
}

/** Close one open entry at `at` and report how long it ran. */
async function cutEntry(entryId: number, at: Date) {
  const [closed] = await db
    .update(timeEntries)
    .set({ checkOut: at, updatedAt: new Date() })
    .where(eq(timeEntries.id, entryId))
    .returning();
  return { id: closed.id, isBreak: closed.isBreak, minutes: entryMinutes(closed.checkIn, closed.checkOut) };
}

/** Insert an entry with server-decided attribution. The only place `entry_source` is written. */
async function insertEntry(
  ctx: ActionContext,
  args: {
    checkIn: Date;
    checkOut?: Date | null;
    isBreak: boolean;
    notes?: string | null;
    refs: { taskId: number | null; streamId: number | null; customerId: number | null };
    metrics: { tokensUsed?: number | null; apiCostUsd?: number | null };
  }
) {
  const attribution = attributionFor(ctx);
  const [row] = await db
    .insert(timeEntries)
    .values({
      userId: ctx.userId,
      orgId: ctx.orgId,
      taskId: args.refs.taskId,
      streamId: args.refs.streamId,
      customerId: args.refs.customerId,
      checkIn: args.checkIn,
      checkOut: args.checkOut ?? null,
      isBreak: args.isBreak,
      notes: args.notes ?? null,
      ...attribution,
      ...args.metrics,
    })
    .returning();
  return row;
}

/* ══════════════════════════════════════════════════════════════════════
   The timer
   ══════════════════════════════════════════════════════════════════════ */


/** History row + webhook for a finished session attached to a task (fire-and-forget). */
function recordTimeLogged(ctx: ActionContext, row: { id: number; taskId: number | null; checkIn: Date; checkOut: Date | null; entrySource: string; tokensUsed: number | null; apiCostUsd: number | null }) {
  if (!row.taskId || !row.checkOut) return;
  const minutes = entryMinutes(row.checkIn, row.checkOut);
  const agentBits = row.entrySource === "agent" ? ` · ${row.tokensUsed ?? 0} tok · $${(row.apiCostUsd ?? 0).toFixed(2)}` : "";
  void recordEvent({
    taskId: row.taskId,
    orgId: ctx.orgId,
    actor: actorFrom(ctx),
    kind: "time_logged",
    note: `${minutes} min logged (${row.entrySource})${agentBits}`,
    payload: { entryId: row.id, entrySource: row.entrySource, minutes, tokensUsed: row.tokensUsed, apiCostUsd: row.apiCostUsd },
  });
}

defineAction({
  name: "time_entry.start",
  title: "Start the timer",
  description:
    "Open a time entry now, attributed to the caller. Refuses to open a second session while one is running — stop it first, or pass isBreak:true, which cuts the running session and opens the break in its place. Whether the entry reads as human or agent work is decided by the credential you called with, not by any argument.",
  input: z.object({
    ...refsIn,
    notes: notesIn.optional(),
    isBreak: z.boolean().describe("Log a break (recess) instead of work. A break also cuts any running work session.").optional(),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const now = new Date();
    const isBreak = args.isBreak ?? false;
    const open = await openEntryFor(ctx.orgId, ctx.userId);
    let cut: Awaited<ReturnType<typeof cutEntry>> | null = null;
    if (open) {
      if (!isBreak) {
        throw new ActionError(
          "conflict",
          `A ${open.isBreak ? "break" : "session"} has been running since ${open.checkIn.toISOString()} (entry ${open.id}). Stop it with time_entry.stop first, or start a break to cut it.`
        );
      }
      cut = await cutEntry(open.id, now);
      ws()?.notifyTimerStop(ctx.userId, timerPayload({ ...open, checkIn: open.checkIn }));
    }
    const refs = await resolveRefs(ctx.orgId, args);
    const row = await insertEntry(ctx, { checkIn: now, isBreak, notes: args.notes, refs, metrics: {} });
    ws()?.notifyTimerStart(ctx.userId, timerPayload(row));
    return { entry: await viewEntry(ctx.orgId, row.id), cut };
  },
});

defineAction({
  name: "time_entry.switch_break",
  title: "Cut to a break",
  description:
    "Close whatever is running and open a break in one step — the behaviour of a break tile in the UI. Name a saved break template with templateId, or pass a free-text label.",
  input: z.object({
    templateId: idIn("One of your own entry templates; its note and attachments are copied onto the break.").optional(),
    label: z.string().min(1).max(200).describe("Free-text note for the break when you have no template. Required when you pass no templateId.").optional(),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    if (args.templateId === undefined && args.label === undefined) {
      throw new ActionError("invalid", "Pass templateId (a saved break tile) or label (free text)");
    }
    const now = new Date();
    let notes = args.label ?? null;
    let refs = { taskId: null as number | null, streamId: null as number | null, customerId: null as number | null };
    if (args.templateId !== undefined) {
      const tpl = await templateFor(ctx.orgId, ctx.userId, args.templateId);
      notes = args.label ?? tpl.notes ?? tpl.name;
      refs = await resolveRefs(ctx.orgId, { streamId: tpl.streamId, customerId: tpl.customerId });
    }
    const open = await openEntryFor(ctx.orgId, ctx.userId);
    let cut: Awaited<ReturnType<typeof cutEntry>> | null = null;
    if (open) {
      cut = await cutEntry(open.id, now);
      ws()?.notifyTimerStop(ctx.userId, timerPayload(open));
    }
    const row = await insertEntry(ctx, { checkIn: now, isBreak: true, notes, refs, metrics: {} });
    ws()?.notifyTimerStart(ctx.userId, timerPayload(row));
    return { entry: await viewEntry(ctx.orgId, row.id), cut };
  },
});

defineAction({
  name: "time_entry.stop",
  title: "Stop the timer",
  description:
    "Close the caller's open entry. An agent may report the tokens and API cost the session consumed; on a human session those two fields are dropped and named in `ignored`, because cost and tokens only mean something for agent work.",
  input: z.object({
    tokensUsed: tokensIn.optional(),
    apiCostUsd: costIn.optional(),
    notes: notesIn.describe("Replaces the entry's note, e.g. what the session actually achieved.").optional(),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const open = await openEntryFor(ctx.orgId, ctx.userId);
    if (!open) throw new ActionError("not_found", "Nothing is running — no open entry to stop.");
    const now = new Date();
    if (now.getTime() - open.checkIn.getTime() > MAX_ENTRY_MS) {
      // A timer left running overnight would otherwise produce a 300-hour line.
      throw new ActionError(
        "conflict",
        `Entry ${open.id} has been open since ${open.checkIn.toISOString()}, longer than 24h. Fix it with time_entry.update (set an explicit checkOut) or delete it.`
      );
    }
    const metrics = agentMetricsFor(open.entrySource as EntrySource, args);
    const [row] = await db
      .update(timeEntries)
      .set({
        checkOut: now,
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        ...metrics.values,
        updatedAt: now,
      })
      .where(eq(timeEntries.id, open.id))
      .returning();
    ws()?.notifyTimerStop(ctx.userId, timerPayload(row));
    ws()?.notifyDashboardUpdate(ctx.userId, { reason: "time_entry.stop", entryId: row.id });
    recordTimeLogged(ctx, row);
    return {
      entry: await viewEntry(ctx.orgId, row.id),
      minutes: entryMinutes(row.checkIn, row.checkOut),
      ignored: metrics.ignored,
      ...(metrics.reason ? { ignoredReason: metrics.reason } : {}),
    };
  },
});

defineAction({
  name: "time_entry.current",
  title: "What is running",
  description: "The caller's open entry with the minutes elapsed so far, or null when the clock is at rest.",
  input: z.object({}),
  requiredRole: "member",
  surface: "track",
  handler: async (_args, ctx) => {
    const open = await openEntryFor(ctx.orgId, ctx.userId);
    if (!open) return null;
    const view = await viewEntry(ctx.orgId, open.id);
    return { ...view, elapsedMinutes: entryMinutes(open.checkIn, null) };
  },
});

defineAction({
  name: "time_entry.log_past",
  title: "Log a finished session",
  description:
    "Insert an already-finished entry with explicit checkIn and checkOut — how an agent records work it did before it got round to reporting. checkOut must be after checkIn and the span at most 24 hours. Tokens and cost are stored only if the calling credential is an agent's.",
  input: z.object({
    checkIn: whenIn("When the session started"),
    checkOut: whenIn("When the session ended"),
    ...refsIn,
    notes: notesIn.optional(),
    tokensUsed: tokensIn.optional(),
    apiCostUsd: costIn.optional(),
    isBreak: z.boolean().describe("Record it as a break rather than work.").optional(),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const checkIn = parseWhen(args.checkIn, "checkIn");
    const checkOut = parseWhen(args.checkOut, "checkOut");
    if (checkOut.getTime() <= checkIn.getTime()) throw new ActionError("invalid", "checkOut must be after checkIn");
    if (checkOut.getTime() - checkIn.getTime() > MAX_ENTRY_MS) throw new ActionError("invalid", "A single entry may not span more than 24 hours");
    if (checkOut.getTime() > Date.now() + 60_000) throw new ActionError("invalid", "checkOut is in the future — a session cannot be logged before it has happened");
    const refs = await resolveRefs(ctx.orgId, args);
    const metrics = agentMetricsFor(ctx.authType, args);
    const row = await insertEntry(ctx, {
      checkIn,
      checkOut,
      isBreak: args.isBreak ?? false,
      notes: args.notes,
      refs,
      metrics: metrics.values,
    });
    ws()?.notifyDashboardUpdate(ctx.userId, { reason: "time_entry.log_past", entryId: row.id });
    recordTimeLogged(ctx, row);
    return {
      entry: await viewEntry(ctx.orgId, row.id),
      minutes: entryMinutes(row.checkIn, row.checkOut),
      ignored: metrics.ignored,
      ...(metrics.reason ? { ignoredReason: metrics.reason } : {}),
    };
  },
});

defineAction({
  name: "time_entry.update",
  title: "Correct an entry",
  description:
    "Fix the times, attachments or note of an entry. Members may correct their own lines; manager and above may correct anyone's in the organization. Attribution is deliberately not editable: entry_source, agentLabel, tokensUsed and apiCostUsd cannot be changed after the fact, so the human-vs-agent record cannot be rewritten.",
  input: z.object({
    entryId: idIn("The entry to correct."),
    checkIn: whenIn("New start").optional(),
    checkOut: whenIn("New end (pass to close a running entry retroactively)").optional(),
    ...refsIn,
    notes: notesIn.optional(),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const row = await entryForWrite(ctx, args.entryId, manager(ctx));
    const checkIn = args.checkIn !== undefined ? parseWhen(args.checkIn, "checkIn") : row.checkIn;
    const checkOut = args.checkOut !== undefined ? parseWhen(args.checkOut, "checkOut") : row.checkOut;
    if (checkOut) {
      if (checkOut.getTime() <= checkIn.getTime()) throw new ActionError("invalid", "checkOut must be after checkIn");
      if (checkOut.getTime() - checkIn.getTime() > MAX_ENTRY_MS) throw new ActionError("invalid", "A single entry may not span more than 24 hours");
    }

    // A newly named task pulls its own stream (and that stream's customer)
    // along, unless the caller named a stream in the same call.
    const next = {
      taskId: args.taskId === undefined ? row.taskId : args.taskId,
      streamId: args.streamId === undefined ? row.streamId : args.streamId,
      customerId: args.customerId === undefined ? row.customerId : args.customerId,
    };
    if (args.taskId !== undefined && args.taskId !== row.taskId && args.streamId === undefined) next.streamId = null;
    const refs = await resolveRefs(ctx.orgId, next);

    const [updated] = await db
      .update(timeEntries)
      .set({
        checkIn,
        checkOut,
        taskId: refs.taskId,
        streamId: refs.streamId,
        customerId: refs.customerId,
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(timeEntries.id, row.id))
      .returning();
    ws()?.notifyDashboardUpdate(row.userId, { reason: "time_entry.update", entryId: row.id });
    return { entry: await viewEntry(ctx.orgId, updated.id) };
  },
});

defineAction({
  name: "time_entry.delete",
  title: "Strike an entry",
  description: "Remove an entry from the ledger for good. Own entries for a member; any entry in the organization for manager and above.",
  input: z.object({ entryId: idIn("The entry to strike.") }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const row = await entryForWrite(ctx, args.entryId, manager(ctx));
    await db.delete(timeEntries).where(eq(timeEntries.id, row.id));
    ws()?.notifyDashboardUpdate(row.userId, { reason: "time_entry.delete", entryId: row.id });
    return { deleted: true, entryId: row.id, minutes: row.checkOut ? entryMinutes(row.checkIn, row.checkOut) : 0 };
  },
});

defineAction({
  name: "time_entry.list",
  title: "List entries",
  description:
    "Ledger lines, newest first, with the stream / task / customer they point at and their source. A member sees their own; manager and above may pass another member's userId, or the string \"all\" for the whole organization.",
  input: z.object({
    from: whenIn("Only entries that started at or after this instant").optional(),
    to: whenIn("Only entries that started at or before this instant").optional(),
    taskId: idIn("Only entries attributed to this task").optional(),
    streamId: idIn("Only entries attributed to this stream").optional(),
    userId: z
      .union([z.number().int().positive(), z.literal("all")])
      .describe("Whose entries to read. Manager and above only; \"all\" reads every member's.")
      .optional(),
    limit: z.number().int().min(1).max(500).describe("Maximum lines to return (default 200).").optional(),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const filters = [eq(timeEntries.orgId, ctx.orgId)];
    if (args.userId !== undefined && args.userId !== ctx.userId && !manager(ctx)) {
      throw new ActionError("forbidden", "Reading another member's ledger requires manager or above");
    }
    if (args.userId !== "all") filters.push(eq(timeEntries.userId, args.userId ?? ctx.userId));
    if (args.taskId !== undefined) filters.push(eq(timeEntries.taskId, args.taskId));
    if (args.streamId !== undefined) filters.push(eq(timeEntries.streamId, args.streamId));
    filters.push(...windowFilters(args.from ? parseWhen(args.from, "from") : undefined, args.to ? parseWhen(args.to, "to") : undefined));
    return selectEntries(and(...filters), args.limit ?? 200);
  },
});

/* ══════════════════════════════════════════════════════════════════════
   Accounting — the numbers the other surfaces read
   ══════════════════════════════════════════════════════════════════════ */

defineAction({
  name: "task.totals",
  title: "Minutes per task, split human vs agent",
  description:
    "Time booked against tasks, split by who did the work: human minutes on one side, agent minutes with their tokens and API cost on the other. Breaks and still-running entries are excluded. Always returns an array — a named taskId returns exactly one row, zeroed when nothing has been logged yet.",
  input: z.object({
    taskId: idIn("One task. Returns a single-element array.").optional(),
    streamId: idIn("Every task in this stream.").optional(),
    from: whenIn("Count only sessions that started at or after this instant").optional(),
    to: whenIn("Count only sessions that started at or before this instant").optional(),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const filters = [eq(timeEntries.orgId, ctx.orgId)];
    if (args.taskId !== undefined) filters.push(eq(timeEntries.taskId, args.taskId));
    if (args.streamId !== undefined) filters.push(eq(timeEntries.streamId, args.streamId));
    filters.push(...windowFilters(args.from ? parseWhen(args.from, "from") : undefined, args.to ? parseWhen(args.to, "to") : undefined));

    const rows = await groupedTotals(timeEntries.taskId, filters);
    const folded = foldGroups(rows.map((r) => ({ key: r.key, entrySource: r.entrySource, seconds: r.seconds, tokens: r.tokens, cost: r.cost })));

    // A caller asking about one task always gets one row: the Plan surface
    // reads result[0] straight onto a card, so an empty array would show up
    // there as `undefined` rather than as "nothing logged yet".
    if (args.taskId !== undefined && !folded.has(args.taskId)) folded.set(args.taskId, emptyBySource());

    return Array.from(folded, ([taskId, bySource]) => ({ taskId, minutes: totalMinutes(bySource), bySource })).sort(
      (a, b) => b.minutes - a.minutes
    );
  },
});

defineAction({
  name: "today_summary",
  title: "Today's page",
  description: "The caller's day so far: worked minutes by stream and by source, break minutes, and whatever is still running.",
  input: z.object({}),
  requiredRole: "member",
  surface: "track",
  handler: async (_args, ctx) => {
    const from = startOfDay();
    const to = endOfDay();
    const mine = [eq(timeEntries.orgId, ctx.orgId), eq(timeEntries.userId, ctx.userId), ...windowFilters(from, to)];

    const [grouped, breakRow, streamRows, open] = await Promise.all([
      groupedTotals(timeEntries.streamId, mine),
      db
        .select({ seconds: sql<string>`coalesce(sum(extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))), 0)` })
        .from(timeEntries)
        .where(and(eq(timeEntries.isBreak, true), sql`${timeEntries.checkOut} is not null`, ...mine)),
      db.select({ id: streams.id, name: streams.name, color: streams.color }).from(streams).where(eq(streams.orgId, ctx.orgId)),
      openEntryFor(ctx.orgId, ctx.userId),
    ]);

    const folded = foldGroups(grouped.map((r) => ({ key: r.key, entrySource: r.entrySource, seconds: r.seconds, tokens: r.tokens, cost: r.cost })));
    const byName = new Map(streamRows.map((s) => [s.id, s]));
    const byStream = Array.from(folded, ([streamId, bySource]) => ({
      streamId,
      streamName: streamId === null ? null : byName.get(streamId)?.name ?? null,
      streamColor: streamId === null ? null : byName.get(streamId)?.color ?? null,
      minutes: totalMinutes(bySource),
      bySource,
    })).sort((a, b) => b.minutes - a.minutes);

    const day = byStream.reduce<BySource>((acc, s) => {
      acc.human.minutes += s.bySource.human.minutes;
      acc.agent.minutes += s.bySource.agent.minutes;
      acc.agent.tokens += s.bySource.agent.tokens;
      acc.agent.costUsd = usd(acc.agent.costUsd + s.bySource.agent.costUsd);
      return acc;
    }, emptyBySource());

    return {
      date: from.toISOString().slice(0, 10),
      minutes: totalMinutes(day),
      breakMinutes: minutesFrom(num(breakRow[0]?.seconds)),
      bySource: day,
      byStream,
      open: open ? { ...(await viewEntry(ctx.orgId, open.id)), elapsedMinutes: entryMinutes(open.checkIn, null) } : null,
    };
  },
});

defineAction({
  name: "stream.totals",
  title: "Minutes and agent spend per stream",
  description:
    "Organization-wide time per stream, split human vs agent, with the agent tokens and dollars each stream consumed in the window. `overBudget` is true when the stream has an agentBudgetUsd and agent cost in the window has passed it.",
  input: z.object({
    from: whenIn("Count only sessions that started at or after this instant").optional(),
    to: whenIn("Count only sessions that started at or before this instant").optional(),
  }),
  requiredRole: "manager",
  surface: "track",
  handler: async (args, ctx) => {
    const filters = [eq(timeEntries.orgId, ctx.orgId)];
    filters.push(...windowFilters(args.from ? parseWhen(args.from, "from") : undefined, args.to ? parseWhen(args.to, "to") : undefined));

    const [grouped, streamRows] = await Promise.all([
      groupedTotals(timeEntries.streamId, filters),
      db
        .select({ id: streams.id, name: streams.name, color: streams.color, archived: streams.archived, agentBudgetUsd: streams.agentBudgetUsd, position: streams.position })
        .from(streams)
        .where(eq(streams.orgId, ctx.orgId))
        .orderBy(streams.position),
    ]);
    const folded = foldGroups(grouped.map((r) => ({ key: r.key, entrySource: r.entrySource, seconds: r.seconds, tokens: r.tokens, cost: r.cost })));

    const out = streamRows.map((s) => {
      const bySource = folded.get(s.id) ?? emptyBySource();
      const budget = s.agentBudgetUsd ?? null;
      return {
        streamId: s.id,
        name: s.name,
        color: s.color,
        archived: s.archived,
        agentBudgetUsd: budget,
        minutes: totalMinutes(bySource),
        bySource,
        overBudget: budget !== null && bySource.agent.costUsd > budget,
      };
    });

    // Time logged without a stream still has to be visible somewhere.
    const loose = folded.get(null);
    if (loose && totalMinutes(loose) > 0) {
      out.push({
        streamId: null as unknown as number,
        name: "(no stream)",
        color: null,
        archived: false,
        agentBudgetUsd: null,
        minutes: totalMinutes(loose),
        bySource: loose,
        overBudget: false,
      });
    }
    return out;
  },
});

/* ══════════════════════════════════════════════════════════════════════
   Templates (the quick-start "stencils" and break tiles)
   ══════════════════════════════════════════════════════════════════════ */

defineAction({
  name: "template.list",
  title: "List entry templates",
  description: "The caller's own saved entry templates — one-tap starts for recurring work and the break tiles.",
  input: z.object({}),
  requiredRole: "member",
  surface: "track",
  handler: async (_args, ctx) =>
    db
      .select()
      .from(entryTemplates)
      .where(and(eq(entryTemplates.orgId, ctx.orgId), eq(entryTemplates.userId, ctx.userId)))
      .orderBy(entryTemplates.createdAt),
});

defineAction({
  name: "template.create",
  title: "Save an entry template",
  description: "Save a recurring entry — a stream, a customer, a note and an icon — so it can be started with one tap.",
  input: z.object({
    name: z.string().min(1).max(100).describe("What it is called on the tile."),
    icon: z
      .string()
      .max(32)
      .regex(/^[a-z0-9-]+$/i, "icon must be a short slug such as 'coffee' or 'gym'")
      .describe("Icon slug (coffee, lunch, gym, commute, walk, call, read, rest, game, errand, outside, smoke, travel, think, partner, kids, other).")
      .optional(),
    notes: notesIn.describe("Note copied onto every entry started from this template.").optional(),
    streamId: idIn("Stream the template attaches to.").optional(),
    customerId: idIn("Customer the template attaches to. Defaults to the stream's customer.").optional(),
    isBreak: z.boolean().describe("Makes it a break tile rather than a work stencil.").optional(),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const refs = await resolveRefs(ctx.orgId, { streamId: args.streamId, customerId: args.customerId });
    const [row] = await db
      .insert(entryTemplates)
      .values({
        userId: ctx.userId,
        orgId: ctx.orgId,
        name: args.name,
        icon: args.icon ?? null,
        notes: args.notes ?? null,
        streamId: refs.streamId,
        customerId: refs.customerId,
        isBreak: args.isBreak ?? false,
      })
      .returning();
    return row;
  },
});

defineAction({
  name: "template.delete",
  title: "Delete an entry template",
  description: "Remove one of the caller's own templates. Entries already started from it are untouched.",
  input: z.object({ templateId: idIn("The template to remove.") }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const tpl = await templateFor(ctx.orgId, ctx.userId, args.templateId);
    await db.delete(entryTemplates).where(eq(entryTemplates.id, tpl.id));
    return { deleted: true, templateId: tpl.id };
  },
});

/* ══════════════════════════════════════════════════════════════════════
   Customers
   ══════════════════════════════════════════════════════════════════════ */

const customerFields = {
  name: z.string().min(1).max(255).describe("Customer name."),
  weeklyGoalHours: z.number().int().min(0).max(168).describe("Hours a week this customer is meant to get.").nullable().optional(),
  billingAddress: z.string().max(2000).describe("Postal address for invoices.").nullable().optional(),
  billingEmail: z.string().email().max(255).describe("Where invoices are sent.").nullable().optional(),
};

async function customerInOrg(orgId: number, customerId: number) {
  const [row] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.orgId, orgId)))
    .limit(1);
  if (!row) throw new ActionError("not_found", `Customer ${customerId} not found`);
  return row;
}

defineAction({
  name: "customer.list",
  title: "List customers",
  description: "Customers in the organization, for attributing and billing time.",
  input: z.object({}),
  requiredRole: "member",
  surface: "track",
  handler: async (_args, ctx) => db.select().from(customers).where(eq(customers.orgId, ctx.orgId)).orderBy(customers.name),
});

defineAction({
  name: "customer.create",
  title: "Add a customer",
  description: "Add a customer to the organization.",
  input: z.object(customerFields),
  requiredRole: "manager",
  surface: "track",
  handler: async (args, ctx) => {
    const [row] = await db
      .insert(customers)
      .values({
        orgId: ctx.orgId,
        name: args.name,
        weeklyGoalHours: args.weeklyGoalHours ?? null,
        billingAddress: args.billingAddress ?? null,
        billingEmail: args.billingEmail ?? null,
      })
      .returning();
    return row;
  },
});

defineAction({
  name: "customer.update",
  title: "Edit a customer",
  description: "Change a customer's name, weekly goal or billing details.",
  input: z.object({
    customerId: idIn("The customer to edit."),
    name: customerFields.name.optional(),
    weeklyGoalHours: customerFields.weeklyGoalHours,
    billingAddress: customerFields.billingAddress,
    billingEmail: customerFields.billingEmail,
  }),
  requiredRole: "manager",
  surface: "track",
  handler: async (args, ctx) => {
    const row = await customerInOrg(ctx.orgId, args.customerId);
    const [updated] = await db
      .update(customers)
      .set({
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.weeklyGoalHours !== undefined ? { weeklyGoalHours: args.weeklyGoalHours } : {}),
        ...(args.billingAddress !== undefined ? { billingAddress: args.billingAddress } : {}),
        ...(args.billingEmail !== undefined ? { billingEmail: args.billingEmail } : {}),
      })
      .where(eq(customers.id, row.id))
      .returning();
    return updated;
  },
});

defineAction({
  name: "customer.delete",
  title: "Delete a customer",
  description: "Remove a customer. Time entries and streams that pointed at it keep their history but lose the reference.",
  input: z.object({ customerId: idIn("The customer to remove.") }),
  requiredRole: "manager",
  surface: "track",
  handler: async (args, ctx) => {
    const row = await customerInOrg(ctx.orgId, args.customerId);
    await db.delete(customers).where(eq(customers.id, row.id));
    return { deleted: true, customerId: row.id };
  },
});
