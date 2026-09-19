import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { apps, streams, tasks, users } from "../../db/schema";
import { band, CLAIMABLE_STATUSES, CLOSED_STATUSES, type Sort, type TaskQueryInput } from "./schema";

export * from "./schema";

/**
 * Build the WHERE clause. Every predicate is parameterised and every list is an
 * `IN (...)` list rather than `= ANY(array)`, which HeliosDB-Nano does not honour.
 */
function buildWhere(input: TaskQueryInput, orgId: number, callerId: number): SQL {
  const parts: (SQL | undefined)[] = [eq(tasks.orgId, orgId)];

  if (input.status && input.status.length > 0) parts.push(inArray(tasks.status, [...input.status]));
  else if (!input.includeCompleted) parts.push(sql`${tasks.status} not in (${CLOSED_STATUSES[0]}, ${CLOSED_STATUSES[1]})`);

  if (input.search) {
    const needle = `%${input.search}%`;
    parts.push(or(ilike(tasks.title, needle), ilike(sql`coalesce(${tasks.description}, '')`, needle)));
  }
  if (input.streamId !== undefined) parts.push(eq(tasks.streamId, input.streamId));
  if (input.appId !== undefined) parts.push(eq(tasks.appId, input.appId));
  if (input.assignedTo === "none") parts.push(isNull(tasks.assignedTo));
  else if (input.assignedTo === "me") parts.push(eq(tasks.assignedTo, callerId));
  else if (typeof input.assignedTo === "number") parts.push(eq(tasks.assignedTo, input.assignedTo));
  if (input.priorityMin !== undefined) parts.push(gte(tasks.priorityScore, input.priorityMin));
  if (input.priorityMax !== undefined) parts.push(lte(tasks.priorityScore, input.priorityMax));
  if (input.effortMax !== undefined) parts.push(lte(tasks.effort, input.effortMax));
  if (input.tags && input.tags.length > 0) {
    // tags is jsonb; Nano has no jsonb containment operators, so match the rendered
    // text of the array against the quoted tag. Cheap, and correct for scalar tags.
    parts.push(or(...input.tags.map((t) => sql`${tasks.tags}::text ilike ${`%"${t}"%`}`)));
  }
  return and(...parts) as SQL;
}

/** ORDER BY. NULLS LAST is parsed but ignored by Nano 4.40, hence the explicit CASE. */
function buildOrder(sort: Sort, order: "asc" | "desc"): SQL[] {
  const dir = order === "asc" ? asc : desc;
  switch (sort) {
    case "due":
      return [sql`case when ${tasks.dueDate} is null then 1 else 0 end asc`, dir(tasks.dueDate), asc(tasks.id)];
    case "updated":
      return [dir(tasks.updatedAt), asc(tasks.id)];
    case "title":
      return [dir(tasks.title), asc(tasks.id)];
    default:
      return [dir(tasks.priorityScore), sql`case when ${tasks.dueDate} is null then 1 else 0 end asc`, asc(tasks.dueDate), asc(tasks.id)];
  }
}

const DEFAULT_ORDER: Record<Sort, "asc" | "desc"> = { priority: "desc", updated: "desc", due: "asc", title: "asc" };

/** Columns every task row carries, joined out to the names the tables and drawers show. */
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

export type TaskRow = Awaited<ReturnType<typeof queryTasks>>["items"][number];

export async function queryTasks(input: TaskQueryInput, orgId: number, callerId: number) {
  const sort = input.sort ?? "priority";
  const order = input.order ?? DEFAULT_ORDER[sort];
  const limit = input.limit ?? 25;
  const offset = input.offset ?? 0;
  const where = buildWhere(input, orgId, callerId);

  const [items, totals] = await Promise.all([
    db
      .select(taskColumns)
      .from(tasks)
      .leftJoin(streams, eq(tasks.streamId, streams.id))
      .leftJoin(apps, eq(tasks.appId, apps.id))
      .leftJoin(users, eq(tasks.assignedTo, users.id))
      .where(where)
      .orderBy(...buildOrder(sort, order))
      .limit(limit)
      .offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(tasks).where(where),
  ]);

  return { items, total: totals[0]?.total ?? 0, limit, offset, sort, order };
}

/** Highest-scoring claimable task, plus the arithmetic that put it on top. */
export async function nextTask(
  opts: { streamId?: number; appId?: number; assignee?: number | "me" | "any" | "none" },
  orgId: number,
  callerId: number,
) {
  const parts: (SQL | undefined)[] = [
    eq(tasks.orgId, orgId),
    inArray(tasks.status, [...CLAIMABLE_STATUSES]),
  ];
  if (opts.streamId !== undefined) parts.push(eq(tasks.streamId, opts.streamId));
  if (opts.appId !== undefined) parts.push(eq(tasks.appId, opts.appId));

  if (opts.assignee === "me") parts.push(eq(tasks.assignedTo, callerId));
  else if (opts.assignee === "none") parts.push(isNull(tasks.assignedTo));
  else if (typeof opts.assignee === "number") parts.push(eq(tasks.assignedTo, opts.assignee));
  else if (opts.assignee !== "any") {
    // Default: work nobody else has claimed, or work already assigned to the caller.
    parts.push(or(isNull(tasks.assignedTo), eq(tasks.assignedTo, callerId)));
  }

  const [row] = await db
    .select(taskColumns)
    .from(tasks)
    .leftJoin(streams, eq(tasks.streamId, streams.id))
    .leftJoin(apps, eq(tasks.appId, apps.id))
    .leftJoin(users, eq(tasks.assignedTo, users.id))
    .where(and(...parts))
    .orderBy(
      desc(tasks.priorityScore),
      sql`case when ${tasks.dueDate} is null then 1 else 0 end asc`,
      asc(tasks.dueDate),
      asc(tasks.id),
    )
    .limit(1);

  if (!row) return { task: null, why: null };
  return {
    task: row,
    why: {
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
    },
  };
}

