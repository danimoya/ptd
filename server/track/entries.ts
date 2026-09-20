/**
 * Database helpers shared by the track actions and the track REST routes.
 *
 * Everything here is org-scoped: every query takes `orgId` from the action
 * context, never from an argument, so a caller cannot reach into another
 * tenant's ledger by passing an id that happens to exist.
 */

import { and, asc, desc, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { customers, entryTemplates, streams, tasks, timeEntries, users } from "../../db/schema";
import { ActionError } from "../actions/registry";
import type { ActionContext } from "../actions/registry";

/** A single session may not span more than a day — a runaway timer is a bug, not a 300-hour entry. */
export const MAX_ENTRY_MS = 24 * 60 * 60 * 1000;

export type EntryRow = typeof timeEntries.$inferSelect;

/* ── Reading ─────────────────────────────────────────────────────────── */

/** The columns the client and MCP callers see, with the names of what an entry points at. */
export const entryView = {
  id: timeEntries.id,
  userId: timeEntries.userId,
  userName: users.displayName,
  userIsAgentSeat: users.isAgent,
  customerId: timeEntries.customerId,
  customerName: customers.name,
  streamId: timeEntries.streamId,
  streamName: streams.name,
  streamColor: streams.color,
  taskId: timeEntries.taskId,
  taskTitle: tasks.title,
  checkIn: timeEntries.checkIn,
  checkOut: timeEntries.checkOut,
  isBreak: timeEntries.isBreak,
  notes: timeEntries.notes,
  entrySource: timeEntries.entrySource,
  agentLabel: timeEntries.agentLabel,
  tokensUsed: timeEntries.tokensUsed,
  apiCostUsd: timeEntries.apiCostUsd,
} as const;

export function selectEntries(where: SQL | undefined, limit: number) {
  return db
    .select(entryView)
    .from(timeEntries)
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .leftJoin(streams, eq(timeEntries.streamId, streams.id))
    .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
    .leftJoin(customers, eq(timeEntries.customerId, customers.id))
    .where(where)
    .orderBy(desc(timeEntries.checkIn))
    .limit(limit);
}

/** Re-read one entry through `entryView` so every action returns the same shape. */
export async function viewEntry(orgId: number, entryId: number) {
  const [row] = await selectEntries(and(eq(timeEntries.orgId, orgId), eq(timeEntries.id, entryId)), 1);
  return row ?? null;
}

/** The caller's still-open entry (work or break), if any. */
export async function openEntryFor(orgId: number, userId: number): Promise<EntryRow | null> {
  const rows = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.orgId, orgId), eq(timeEntries.userId, userId), isNull(timeEntries.checkOut)))
    .orderBy(desc(timeEntries.checkIn))
    .limit(1);
  return rows[0] ?? null;
}

/* ── Reference resolution ────────────────────────────────────────────── */

export interface Refs {
  taskId?: number | null;
  streamId?: number | null;
  customerId?: number | null;
}

/**
 * Validate that every id belongs to this org and fill in what can be derived:
 * a task implies its stream, a stream implies its customer. Mirrors the original tracker, which
 * let an agent name only a task and still get a correctly attributed row.
 */
export async function resolveRefs(orgId: number, refs: Refs): Promise<Required<Refs>> {
  let taskId = refs.taskId ?? null;
  let streamId = refs.streamId ?? null;
  let customerId = refs.customerId ?? null;

  if (taskId !== null) {
    const [task] = await db
      .select({ id: tasks.id, streamId: tasks.streamId })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.orgId, orgId)))
      .limit(1);
    if (!task) throw new ActionError("not_found", `Task ${taskId} is not in this organization`);
    if (streamId !== null && task.streamId !== null && task.streamId !== streamId) {
      throw new ActionError("invalid", `Task ${taskId} belongs to stream ${task.streamId}, not ${streamId}`);
    }
    if (streamId === null) streamId = task.streamId;
  }

  if (streamId !== null) {
    const [stream] = await db
      .select({ id: streams.id, customerId: streams.customerId })
      .from(streams)
      .where(and(eq(streams.id, streamId), eq(streams.orgId, orgId)))
      .limit(1);
    if (!stream) throw new ActionError("not_found", `Stream ${streamId} is not in this organization`);
    if (customerId === null) customerId = stream.customerId;
  }

  if (customerId !== null) {
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.orgId, orgId)))
      .limit(1);
    if (!customer) throw new ActionError("not_found", `Customer ${customerId} is not in this organization`);
  }

  return { taskId, streamId, customerId };
}

/** One of the caller's own templates (used by `time_entry.switch_break`). */
export async function templateFor(orgId: number, userId: number, templateId: number) {
  const [row] = await db
    .select()
    .from(entryTemplates)
    .where(and(eq(entryTemplates.id, templateId), eq(entryTemplates.orgId, orgId), eq(entryTemplates.userId, userId)))
    .limit(1);
  if (!row) throw new ActionError("not_found", `Template ${templateId} not found`);
  return row;
}

/* ── Windows ─────────────────────────────────────────────────────────── */

/**
 * An entry counts as inside a window by where it started, which is how the original tracker's
 * day pages and every report here read: a session belongs to the day it opened.
 */
export function windowFilters(from?: Date, to?: Date): SQL[] {
  const f: SQL[] = [];
  if (from) f.push(gte(timeEntries.checkIn, from));
  if (to) f.push(lte(timeEntries.checkIn, to));
  return f;
}

/** Parse an ISO datetime, or a bare `YYYY-MM-DD` treated as local midnight. */
export function parseWhen(value: string, field: string): Date {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) throw new ActionError("invalid", `${field} is not a valid date/datetime`);
  return d;
}

export function startOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/* ── Permissions ─────────────────────────────────────────────────────── */

/** member+ acts on its own ledger; manager+ may act on anyone's in the org. */
export async function entryForWrite(ctx: ActionContext, entryId: number, canReachOthers: boolean): Promise<EntryRow> {
  const [row] = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.id, entryId), eq(timeEntries.orgId, ctx.orgId)))
    .limit(1);
  if (!row) throw new ActionError("not_found", `Time entry ${entryId} not found`);
  if (row.userId !== ctx.userId && !canReachOthers) {
    throw new ActionError("forbidden", "That entry belongs to another member; manager or above is required to change it");
  }
  return row;
}

/* ── Aggregation queries ─────────────────────────────────────────────── */

/**
 * Seconds / tokens / cost grouped by a column and by entry_source, computed in
 * the engine. Breaks and still-open sessions are excluded: an unfinished entry
 * has no duration to report, and a break is not work.
 */
export function groupedTotals(column: typeof timeEntries.taskId | typeof timeEntries.streamId, filters: SQL[]) {
  return db
    .select({
      key: column,
      entrySource: timeEntries.entrySource,
      seconds: sql<string>`coalesce(sum(extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))), 0)`,
      tokens: sql<string>`coalesce(sum(${timeEntries.tokensUsed}), 0)`,
      cost: sql<string>`coalesce(sum(${timeEntries.apiCostUsd}), 0)`,
    })
    .from(timeEntries)
    .where(and(eq(timeEntries.isBreak, false), sql`${timeEntries.checkOut} is not null`, ...filters))
    .groupBy(column, timeEntries.entrySource);
}

export { and, asc, desc, eq, gte, isNull, lte, or, sql };
