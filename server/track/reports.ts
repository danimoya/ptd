/**
 * Date-range reporting over the ledger: bucketed roll-ups, period comparison
 * and full-text search.
 *
 * Two rules shape this file.
 *
 *  1. **The fold is pure.** Every number a report shows is computed by a
 *     db-free function over plain rows (`foldRange`, `metricsOf`,
 *     `compareMetrics`), exactly as `aggregate.ts` does for task totals, so the
 *     shapes the client and MCP callers depend on are unit-testable without a
 *     database. Only `fetchReportRows` and `searchEntries` touch the db.
 *
 *  2. **Buckets are local-time.** The rest of the Track surface reasons in the
 *     member's local day (`startOfDay()` in entries.ts, `dayKey()` on the
 *     client), so a report groups by local day / ISO week / calendar month in
 *     JS rather than by `date_trunc` in the engine. Folding in JS also keeps the
 *     bucket totals, the per-stream split and the range totals derived from one
 *     single read, so they can never disagree with each other — and it sidesteps
 *     HeliosDB-Nano's restrictions on `ORDER BY` after `GROUP BY`.
 *
 * Every query is org-scoped by the caller, which passes `orgId` from the action
 * context; nothing here reads a tenant id out of an argument.
 */

import { eachDayOfInterval, eachMonthOfInterval, eachWeekOfInterval, endOfMonth, endOfWeek, format, startOfMonth, startOfWeek } from "date-fns";
import { and, asc, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { customers, streams, tasks, timeEntries, users } from "../../db/schema";
import { emptyBySource, minutesFrom, num, usd, type AgentBucket, type BySource, type HumanBucket } from "./aggregate";

/** Monday-first weeks: the ledger's calendar and every European timesheet. */
const WEEK_STARTS_ON = 1 as const;

/** A single read can only be so large before a "report" is really an export. */
export const MAX_REPORT_ROWS = 20_000;

/** Enough buckets for a day-by-day year; past that only non-empty ones are emitted. */
export const MAX_BUCKETS = 400;

export type GroupBy = "day" | "week" | "month";

/* ── Row shape ───────────────────────────────────────────────────────── */

/** The columns every report in this file folds over. */
export interface ReportRow {
  id: number;
  userId: number;
  userName: string | null;
  streamId: number | null;
  streamName: string | null;
  streamColor: string | null;
  streamCustomerId: number | null;
  taskId: number | null;
  taskTitle: string | null;
  customerId: number | null;
  checkIn: Date | string;
  checkOut: Date | string | null;
  isBreak: boolean;
  notes: string | null;
  entrySource: string | null;
  tokensUsed: number | null;
  apiCostUsd: number | null;
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** Seconds a row contributes. A still-open session has no duration to report. */
export function rowSeconds(row: ReportRow): number {
  if (!row.checkOut) return 0;
  return Math.max(0, (asDate(row.checkOut).getTime() - asDate(row.checkIn).getTime()) / 1000);
}

export const isAgentRow = (row: ReportRow): boolean => row.entrySource === "agent";

/* ── Bucket keys ─────────────────────────────────────────────────────── */

/** Local `YYYY-MM-DD` — the same key the ledger's calendar uses. */
export const dayKey = (d: Date): string => format(d, "yyyy-MM-dd");

/** The bucket a moment falls in: its day, its Monday, or its month. */
export function bucketStart(d: Date, groupBy: GroupBy): Date {
  if (groupBy === "week") return startOfWeek(d, { weekStartsOn: WEEK_STARTS_ON });
  if (groupBy === "month") return startOfMonth(d);
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function bucketEnd(d: Date, groupBy: GroupBy): Date {
  if (groupBy === "week") return endOfWeek(d, { weekStartsOn: WEEK_STARTS_ON });
  if (groupBy === "month") return endOfMonth(d);
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function bucketKey(d: Date, groupBy: GroupBy): string {
  const start = bucketStart(d, groupBy);
  return groupBy === "month" ? format(start, "yyyy-MM") : dayKey(start);
}

/** "Mon 15 Sep" / "w/c 15 Sep" / "Sep 2026" — what the chart's axis prints. */
export function bucketLabel(d: Date, groupBy: GroupBy): string {
  const start = bucketStart(d, groupBy);
  if (groupBy === "month") return format(start, "MMM yyyy");
  if (groupBy === "week") return `w/c ${format(start, "d MMM")}`;
  return format(start, "EEE d MMM");
}

/** Every bucket in the window, so an idle day still draws a gap in the chart. */
export function enumerateBuckets(from: Date, to: Date, groupBy: GroupBy): Date[] {
  const start = bucketStart(from, groupBy);
  const end = bucketStart(to, groupBy);
  if (end < start) return [];
  const starts =
    groupBy === "month"
      ? eachMonthOfInterval({ start, end })
      : groupBy === "week"
        ? eachWeekOfInterval({ start, end }, { weekStartsOn: WEEK_STARTS_ON })
        : eachDayOfInterval({ start, end });
  return starts.length > MAX_BUCKETS ? [] : starts;
}

/* ── Report shapes ───────────────────────────────────────────────────── */

export interface StreamSplit {
  streamId: number | null;
  streamName: string | null;
  streamColor: string | null;
  sessions: number;
  minutes: number;
  human: HumanBucket;
  agent: AgentBucket;
}

export interface Bucket {
  key: string;
  label: string;
  from: string;
  to: string;
  minutes: number;
  breakMinutes: number;
  sessions: number;
  human: HumanBucket;
  agent: AgentBucket;
  byStream: StreamSplit[];
}

export interface RangeReport {
  from: string;
  to: string;
  groupBy: GroupBy;
  includeBreaks: boolean;
  minutes: number;
  breakMinutes: number;
  sessions: number;
  activeDays: number;
  human: HumanBucket;
  agent: AgentBucket;
  buckets: Bucket[];
  byStream: StreamSplit[];
  /** True when the read hit MAX_REPORT_ROWS — narrow the window. */
  truncated: boolean;
}

interface Acc {
  workSeconds: number;
  breakSeconds: number;
  humanSeconds: number;
  agentSeconds: number;
  tokens: number;
  cost: number;
  sessions: number;
}

const newAcc = (): Acc => ({ workSeconds: 0, breakSeconds: 0, humanSeconds: 0, agentSeconds: 0, tokens: 0, cost: 0, sessions: 0 });

function add(acc: Acc, row: ReportRow, seconds: number) {
  if (row.isBreak) {
    acc.breakSeconds += seconds;
    return;
  }
  acc.workSeconds += seconds;
  acc.sessions += 1;
  if (isAgentRow(row)) {
    acc.agentSeconds += seconds;
    acc.tokens += num(row.tokensUsed);
    acc.cost += num(row.apiCostUsd);
  } else {
    acc.humanSeconds += seconds;
  }
}

/** Rounding happens once, at the end, so many short sessions do not each lose up to 30s. */
function sourceOf(acc: Acc): BySource {
  return {
    human: { minutes: minutesFrom(acc.humanSeconds) },
    agent: { minutes: minutesFrom(acc.agentSeconds), tokens: Math.round(acc.tokens), costUsd: usd(acc.cost) },
  };
}

interface StreamAcc extends Acc {
  streamId: number | null;
  streamName: string | null;
  streamColor: string | null;
}

function streamAccFor(map: Map<number | null, StreamAcc>, row: ReportRow): StreamAcc {
  const existing = map.get(row.streamId);
  if (existing) {
    // A stream renamed mid-window keeps whichever name the join handed back.
    if (existing.streamName === null && row.streamName !== null) existing.streamName = row.streamName;
    return existing;
  }
  const fresh: StreamAcc = { ...newAcc(), streamId: row.streamId, streamName: row.streamName, streamColor: row.streamColor };
  map.set(row.streamId, fresh);
  return fresh;
}

function splitsFrom(map: Map<number | null, StreamAcc>): StreamSplit[] {
  return Array.from(map.values())
    .map((a) => {
      const src = sourceOf(a);
      return {
        streamId: a.streamId,
        streamName: a.streamName,
        streamColor: a.streamColor,
        sessions: a.sessions,
        minutes: src.human.minutes + src.agent.minutes,
        human: src.human,
        agent: src.agent,
      };
    })
    .filter((s) => s.minutes > 0 || s.sessions > 0)
    .sort((a, b) => b.minutes - a.minutes || (a.streamName ?? "").localeCompare(b.streamName ?? ""));
}

export interface FoldRangeOptions {
  from: Date;
  to: Date;
  groupBy: GroupBy;
  includeBreaks?: boolean;
  truncated?: boolean;
}

/**
 * Fold raw ledger rows into one bucket per day / week / month, each split human
 * vs agent and further split per stream, plus the totals for the whole window.
 */
export function foldRange(rows: ReportRow[], opts: FoldRangeOptions): RangeReport {
  const includeBreaks = opts.includeBreaks ?? false;
  const buckets = new Map<string, { at: Date; acc: Acc; streams: Map<number | null, StreamAcc> }>();
  for (const at of enumerateBuckets(opts.from, opts.to, opts.groupBy)) {
    buckets.set(bucketKey(at, opts.groupBy), { at, acc: newAcc(), streams: new Map() });
  }

  const total = newAcc();
  const totalStreams = new Map<number | null, StreamAcc>();
  const activeDays = new Set<string>();

  for (const row of rows) {
    const seconds = rowSeconds(row);
    if (seconds <= 0) continue;
    if (row.isBreak && !includeBreaks) continue;
    const at = asDate(row.checkIn);
    const key = bucketKey(at, opts.groupBy);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { at: bucketStart(at, opts.groupBy), acc: newAcc(), streams: new Map() };
      buckets.set(key, bucket);
    }
    add(bucket.acc, row, seconds);
    add(total, row, seconds);
    if (!row.isBreak) {
      add(streamAccFor(bucket.streams, row), row, seconds);
      add(streamAccFor(totalStreams, row), row, seconds);
      activeDays.add(dayKey(at));
    }
  }

  const ordered = Array.from(buckets.entries()).sort((a, b) => +a[1].at - +b[1].at);
  const src = sourceOf(total);

  return {
    from: opts.from.toISOString(),
    to: opts.to.toISOString(),
    groupBy: opts.groupBy,
    includeBreaks,
    minutes: src.human.minutes + src.agent.minutes,
    breakMinutes: minutesFrom(total.breakSeconds),
    sessions: total.sessions,
    activeDays: activeDays.size,
    human: src.human,
    agent: src.agent,
    buckets: ordered.map(([key, b]) => {
      const bs = sourceOf(b.acc);
      return {
        key,
        label: bucketLabel(b.at, opts.groupBy),
        from: bucketStart(b.at, opts.groupBy).toISOString(),
        to: bucketEnd(b.at, opts.groupBy).toISOString(),
        minutes: bs.human.minutes + bs.agent.minutes,
        breakMinutes: minutesFrom(b.acc.breakSeconds),
        sessions: b.acc.sessions,
        human: bs.human,
        agent: bs.agent,
        byStream: splitsFrom(b.streams),
      };
    }),
    byStream: splitsFrom(totalStreams),
    truncated: opts.truncated ?? false,
  };
}

/* ── Period comparison ───────────────────────────────────────────────── */

export const COMPARED_METRICS = [
  "minutes",
  "humanMinutes",
  "agentMinutes",
  "agentTokens",
  "agentCostUsd",
  "sessions",
  "activeDays",
  "breakMinutes",
] as const;

export type MetricName = (typeof COMPARED_METRICS)[number];
export type Metrics = Record<MetricName, number>;

/** Metrics where a fall is the good news: money, tokens and time not worked. */
const LOWER_IS_BETTER = new Set<MetricName>(["agentCostUsd", "agentTokens", "breakMinutes"]);

export function metricsOf(r: Pick<RangeReport, "minutes" | "human" | "agent" | "sessions" | "activeDays" | "breakMinutes">): Metrics {
  return {
    minutes: r.minutes,
    humanMinutes: r.human.minutes,
    agentMinutes: r.agent.minutes,
    agentTokens: r.agent.tokens,
    agentCostUsd: r.agent.costUsd,
    sessions: r.sessions,
    activeDays: r.activeDays,
    breakMinutes: r.breakMinutes,
  };
}

export interface Trend {
  direction: "up" | "down" | "flat";
  /** A glyph the client can print as-is; the UI may still draw its own icon. */
  arrow: "↑" | "↓" | "→";
  delta: number;
  /** Percent change against the previous period; 100 when there was nothing to grow from. */
  pct: number;
  /** Whether the movement is the one you want for this metric. */
  better: boolean;
}

/** Percent change, with the "from zero" case pinned rather than infinite. */
export function pctChange(current: number, previous: number): number {
  if (previous > 0) return Math.round(((current - previous) / previous) * 1000) / 10;
  return current > 0 ? 100 : 0;
}

export function trendFor(name: MetricName, current: number, previous: number): Trend {
  const delta = Math.round((current - previous) * 10_000) / 10_000;
  const direction = delta === 0 ? "flat" : delta > 0 ? "up" : "down";
  const wantsLess = LOWER_IS_BETTER.has(name);
  return {
    direction,
    arrow: direction === "flat" ? "→" : direction === "up" ? "↑" : "↓",
    delta,
    pct: pctChange(current, previous),
    better: direction === "flat" ? true : wantsLess ? direction === "down" : direction === "up",
  };
}

export interface Comparison {
  current: RangeReport;
  previous: RangeReport;
  delta: Metrics;
  deltaPct: Metrics;
  trend: Record<MetricName, Trend>;
}

export function compareRanges(current: RangeReport, previous: RangeReport): Comparison {
  const cur = metricsOf(current);
  const prev = metricsOf(previous);
  const delta = {} as Metrics;
  const deltaPct = {} as Metrics;
  const trend = {} as Record<MetricName, Trend>;
  for (const name of COMPARED_METRICS) {
    const t = trendFor(name, cur[name], prev[name]);
    delta[name] = t.delta;
    deltaPct[name] = t.pct;
    trend[name] = t;
  }
  return { current, previous, delta, deltaPct, trend };
}

/* ── Reads ───────────────────────────────────────────────────────────── */

const reportRowView = {
  id: timeEntries.id,
  userId: timeEntries.userId,
  userName: users.displayName,
  streamId: timeEntries.streamId,
  streamName: streams.name,
  streamColor: streams.color,
  streamCustomerId: streams.customerId,
  taskId: timeEntries.taskId,
  taskTitle: tasks.title,
  customerId: timeEntries.customerId,
  checkIn: timeEntries.checkIn,
  checkOut: timeEntries.checkOut,
  isBreak: timeEntries.isBreak,
  notes: timeEntries.notes,
  entrySource: timeEntries.entrySource,
  tokensUsed: timeEntries.tokensUsed,
  apiCostUsd: timeEntries.apiCostUsd,
} as const;

/**
 * One read per report. Closed sessions only — an entry still running has no
 * duration, and including it would make every refresh return a different total.
 */
export async function fetchReportRows(filters: SQL[], limit = MAX_REPORT_ROWS): Promise<ReportRow[]> {
  const rows = await db
    .select(reportRowView)
    .from(timeEntries)
    .leftJoin(streams, eq(timeEntries.streamId, streams.id))
    .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(and(sql`${timeEntries.checkOut} is not null`, ...filters))
    .orderBy(asc(timeEntries.checkIn))
    .limit(limit);
  return rows as ReportRow[];
}

/* ── Search ──────────────────────────────────────────────────────────── */

/**
 * `%` and `_` are ILIKE wildcards, so a member searching for "50%" must not get
 * every line back. Backslash is Postgres's (and Nano's) default LIKE escape.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface SearchHit {
  id: number;
  userId: number;
  userName: string | null;
  streamId: number | null;
  streamName: string | null;
  streamColor: string | null;
  taskId: number | null;
  taskTitle: string | null;
  customerId: number | null;
  customerName: string | null;
  checkIn: string;
  checkOut: string | null;
  isBreak: boolean;
  notes: string | null;
  entrySource: string;
  agentLabel: string | null;
  tokensUsed: number | null;
  apiCostUsd: number | null;
  minutes: number;
}

export interface SearchResult {
  query: string;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  totalMinutes: number;
  results: SearchHit[];
}

export interface SearchArgs {
  query: string;
  from?: Date;
  to?: Date;
  streamId?: number;
  taskId?: number;
  minMinutes?: number;
  limit: number;
  offset: number;
}

/**
 * ILIKE across an entry's own note and the title of the task it points at —
 * the two places a member actually writes what the session was about.
 *
 * The `count(*)` runs as a second statement rather than a window function so
 * the shape stays inside what HeliosDB-Nano supports.
 */
export async function searchEntries(scopeFilters: SQL[], a: SearchArgs): Promise<SearchResult> {
  const needle = `%${escapeLike(a.query)}%`;
  const filters: SQL[] = [...scopeFilters];
  if (a.from) filters.push(gte(timeEntries.checkIn, a.from));
  if (a.to) filters.push(lte(timeEntries.checkIn, a.to));
  if (a.streamId !== undefined) filters.push(eq(timeEntries.streamId, a.streamId));
  if (a.taskId !== undefined) filters.push(eq(timeEntries.taskId, a.taskId));
  filters.push(or(ilike(timeEntries.notes, needle), ilike(tasks.title, needle)) as SQL);
  if (a.minMinutes !== undefined && a.minMinutes > 0) {
    filters.push(sql`coalesce(extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn})), 0) >= ${a.minMinutes * 60}`);
  }
  const where = and(...filters);

  const minutesExpr = sql<string>`coalesce(extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn})), 0)`;

  const [rows, counted] = await Promise.all([
    db
      .select({
        id: timeEntries.id,
        userId: timeEntries.userId,
        userName: users.displayName,
        streamId: timeEntries.streamId,
        streamName: streams.name,
        streamColor: streams.color,
        taskId: timeEntries.taskId,
        taskTitle: tasks.title,
        customerId: timeEntries.customerId,
        customerName: customers.name,
        checkIn: timeEntries.checkIn,
        checkOut: timeEntries.checkOut,
        isBreak: timeEntries.isBreak,
        notes: timeEntries.notes,
        entrySource: timeEntries.entrySource,
        agentLabel: timeEntries.agentLabel,
        tokensUsed: timeEntries.tokensUsed,
        apiCostUsd: timeEntries.apiCostUsd,
        seconds: minutesExpr,
      })
      .from(timeEntries)
      .leftJoin(streams, eq(timeEntries.streamId, streams.id))
      .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
      .leftJoin(users, eq(timeEntries.userId, users.id))
      .leftJoin(customers, eq(timeEntries.customerId, customers.id))
      .where(where)
      .orderBy(desc(timeEntries.checkIn))
      .limit(a.limit)
      .offset(a.offset),
    db
      .select({ total: sql<string>`count(*)`, seconds: sql<string>`coalesce(sum(coalesce(extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn})), 0)), 0)` })
      .from(timeEntries)
      .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
      .where(where),
  ]);

  const total = Math.round(num(counted[0]?.total));
  return {
    query: a.query,
    total,
    limit: a.limit,
    offset: a.offset,
    hasMore: a.offset + rows.length < total,
    totalMinutes: minutesFrom(num(counted[0]?.seconds)),
    results: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: r.userName,
      streamId: r.streamId,
      streamName: r.streamName,
      streamColor: r.streamColor,
      taskId: r.taskId,
      taskTitle: r.taskTitle,
      customerId: r.customerId,
      customerName: r.customerName,
      checkIn: asDate(r.checkIn).toISOString(),
      checkOut: r.checkOut ? asDate(r.checkOut).toISOString() : null,
      isBreak: r.isBreak,
      notes: r.notes,
      entrySource: r.entrySource,
      agentLabel: r.agentLabel,
      tokensUsed: r.tokensUsed,
      apiCostUsd: r.apiCostUsd === null ? null : usd(r.apiCostUsd),
      minutes: minutesFrom(num(r.seconds)),
    })),
  };
}

/* ── Customer goals ──────────────────────────────────────────────────── */

export interface CustomerGoal {
  customerId: number;
  name: string;
  weeklyGoalHours: number | null;
  goalMinutes: number;
  minutes: number;
  human: HumanBucket;
  agent: AgentBucket;
  sessions: number;
  pct: number;
  remainingMinutes: number;
  met: boolean;
  streams: { streamId: number; name: string; minutes: number }[];
}

export interface CustomerRef {
  id: number;
  name: string;
  weeklyGoalHours: number | null;
}

/**
 * Which customer a session bills to: the customer of the stream it sits in,
 * falling back to the entry's own denormalised customerId when the session was
 * logged without a stream. A stream is the billing unit, so it wins.
 */
export function customerOf(row: ReportRow): number | null {
  return row.streamId !== null ? row.streamCustomerId : row.customerId;
}

/** Weekly goal vs what was actually logged, per customer, over one window. */
export function foldCustomerGoals(
  rows: ReportRow[],
  customerList: CustomerRef[],
  streamList: { id: number; name: string; customerId: number | null }[]
): CustomerGoal[] {
  const byCustomer = new Map<number, Acc>();
  const perStream = new Map<number, Map<number, number>>();
  for (const row of rows) {
    if (row.isBreak) continue;
    const seconds = rowSeconds(row);
    if (seconds <= 0) continue;
    const customerId = customerOf(row);
    if (customerId === null) continue;
    const acc = byCustomer.get(customerId) ?? newAcc();
    add(acc, row, seconds);
    byCustomer.set(customerId, acc);
    if (row.streamId !== null) {
      const streamMap = perStream.get(customerId) ?? new Map<number, number>();
      streamMap.set(row.streamId, (streamMap.get(row.streamId) ?? 0) + seconds);
      perStream.set(customerId, streamMap);
    }
  }

  return customerList
    .map((c) => {
      const acc = byCustomer.get(c.id) ?? newAcc();
      const src = sourceOf(acc);
      const minutes = src.human.minutes + src.agent.minutes;
      const goalMinutes = (c.weeklyGoalHours ?? 0) * 60;
      const streamMap = perStream.get(c.id) ?? new Map<number, number>();
      return {
        customerId: c.id,
        name: c.name,
        weeklyGoalHours: c.weeklyGoalHours,
        goalMinutes,
        minutes,
        human: src.human,
        agent: src.agent,
        sessions: acc.sessions,
        pct: goalMinutes > 0 ? Math.round((minutes / goalMinutes) * 1000) / 10 : 0,
        remainingMinutes: Math.max(0, goalMinutes - minutes),
        met: goalMinutes > 0 && minutes >= goalMinutes,
        streams: streamList
          .filter((s) => s.customerId === c.id || streamMap.has(s.id))
          .map((s) => ({ streamId: s.id, name: s.name, minutes: minutesFrom(streamMap.get(s.id) ?? 0) }))
          .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => b.pct - a.pct || b.minutes - a.minutes || a.name.localeCompare(b.name));
}

export { emptyBySource };
