/**
 * `next_task` with a hard budget honoured.
 *
 * `server/overview/query.ts` owns the real `nextTask` and stays untouched: it
 * has no notion of an excluded stream, and adding one would change a contract
 * four other surfaces read. So this file carries one variant — the same filters,
 * the same ordering, the same `why` block — that additionally refuses to offer
 * work in lanes whose agent budget is spent under `budget_mode = 'enforce'`.
 *
 * It only runs when there *is* something to exclude. With no enforced-and-spent
 * lane (the overwhelmingly common case) the action calls the original function,
 * so the two can never drift for anyone who has not switched enforcement on.
 *
 * `stream_id NOT IN (…)` is false for a NULL stream in SQL, which would silently
 * hide every unfiled card — hence the explicit `is null OR not in (…)`.
 */

import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { apps, streams, tasks, users } from "../../db/schema";
import { band, CLAIMABLE_STATUSES, normaliseScope } from "../overview/schema";

/** Same projection `server/overview/query.ts` hands back, so callers see one shape. */
const taskColumns = {
  id: tasks.id,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  streamId: tasks.streamId,
  streamName: streams.name,
  streamColor: streams.color,
  appId: tasks.appId,
  appKey: apps.key,
  appName: apps.name,
  assignedTo: tasks.assignedTo,
  assigneeName: users.displayName,
  assigneeIsAgent: users.isAgent,
  startDate: tasks.startDate,
  dueDate: tasks.dueDate,
  estimatedDuration: tasks.estimatedDuration,
  dependencies: tasks.dependencies,
  externalKey: tasks.externalKey,
  urgency: tasks.urgency,
  impact: tasks.impact,
  effort: tasks.effort,
  priorityScore: tasks.priorityScore,
  prioritySource: tasks.prioritySource,
  priorityNote: tasks.priorityNote,
  tags: tasks.tags,
  completed: tasks.completed,
  createdBy: tasks.createdBy,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
} as const;

export interface NextTaskOpts {
  streamId?: number | "none" | null;
  appId?: number | "none" | null;
  assignee?: number | "me" | "any" | "none" | null;
}

/** The `why` block, byte-identical to the one `server/overview/query.ts` builds. */
export function whyFor(row: {
  priorityScore: number;
  urgency: number;
  impact: number;
  effort: number;
  prioritySource: string;
  priorityNote: string | null;
}) {
  return {
    priorityScore: row.priorityScore,
    urgency: row.urgency,
    impact: row.impact,
    effort: row.effort,
    source: row.prioritySource,
    note: row.priorityNote,
    formula: `urgency ${row.urgency} × impact ${row.impact} ÷ effort ${Math.max(row.effort, 1)} = ${row.priorityScore}`,
    band: band(row.priorityScore),
    explanation:
      row.prioritySource === "manual"
        ? `Score ${row.priorityScore} was set by hand${row.priorityNote ? `: ${row.priorityNote}` : "."}`
        : `Highest remaining score in scope: urgency ${row.urgency} × impact ${row.impact} ÷ effort ${Math.max(row.effort, 1)}.`,
  };
}

export async function nextTaskExcludingStreams(opts: NextTaskOpts, orgId: number, callerId: number, excluded: number[]) {
  const parts: (SQL | undefined)[] = [eq(tasks.orgId, orgId), inArray(tasks.status, [...CLAIMABLE_STATUSES])];
  const streamId = normaliseScope(opts.streamId);
  const appId = normaliseScope(opts.appId);
  const assignee = opts.assignee === null ? "none" : opts.assignee;

  if (streamId === "none") parts.push(isNull(tasks.streamId));
  else if (streamId !== undefined) parts.push(eq(tasks.streamId, streamId));
  if (appId === "none") parts.push(isNull(tasks.appId));
  else if (appId !== undefined) parts.push(eq(tasks.appId, appId));

  if (assignee === "me") parts.push(eq(tasks.assignedTo, callerId));
  else if (assignee === "none") parts.push(isNull(tasks.assignedTo));
  else if (typeof assignee === "number") parts.push(eq(tasks.assignedTo, assignee));
  else if (assignee !== "any") parts.push(or(isNull(tasks.assignedTo), eq(tasks.assignedTo, callerId)));

  if (excluded.length > 0) parts.push(or(isNull(tasks.streamId), notInArray(tasks.streamId, excluded)));

  const [row] = await db
    .select(taskColumns)
    .from(tasks)
    .leftJoin(streams, eq(tasks.streamId, streams.id))
    .leftJoin(apps, eq(tasks.appId, apps.id))
    .leftJoin(users, eq(tasks.assignedTo, users.id))
    .where(and(...parts))
    .orderBy(desc(tasks.priorityScore), sql`case when ${tasks.dueDate} is null then 1 else 0 end asc`, asc(tasks.dueDate), asc(tasks.id))
    .limit(1);

  if (!row) return { task: null, why: null };
  return { task: row, why: whyFor(row) };
}
