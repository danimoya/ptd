/**
 * The hybrid ledger: how much of the organization's work the machines did, what
 * it cost, and whether that cost sits inside the budget each stream was given.
 *
 * Four rules shape this file.
 *
 *  1. **One read, then a pure fold.** `hybridSummary` issues the queries and
 *     hands plain rows to `foldHybrid`, which is db-free. Every figure the
 *     dashboard prints — the per-bucket split, the per-stream burn, the per-app
 *     split, the agent table, the medians and the narrative — is folded out of
 *     that one entry read, so two panels on the same page can never disagree.
 *
 *  2. **Buckets are local-time, computed in JS.** Same reasoning as
 *     `track/reports.ts`: the rest of PTD reasons in the member's local day, and
 *     folding in JS sidesteps HeliosDB-Nano's restrictions on `date_trunc`,
 *     window functions and `ORDER BY` after `GROUP BY`.
 *
 *  3. **The SQL stays inside Nano 4.40.** Plain aggregates, `CASE WHEN`,
 *     `EXTRACT(EPOCH FROM (check_out - check_in))`, `IN (…)`, single-equality
 *     joins. No `FILTER`, no `NULLS LAST`, no aliases in `ORDER BY` after a
 *     `GROUP BY` (positional only), no recursive CTEs, no `DO $$`.
 *
 *  4. **The narrative is arithmetic, not a model.** `narrateHybrid` assembles
 *     its paragraph from the same numbers the charts draw, so the prose can
 *     never claim something the figures above it contradict.
 *
 * Org scope comes from the action context; nothing here reads a tenant id out of
 * an argument.
 */

import { format } from "date-fns";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { minutesFrom, num, usd, type AgentBucket, type HumanBucket } from "../track/aggregate";
import { bucketEnd, bucketKey, bucketLabel, bucketStart, enumerateBuckets } from "../track/reports";
import { sayMinutes, sayTokens, sayUsd } from "../track/insights";

/** Day or week. A month-long bucket hides exactly the trend this dashboard is for. */
export type HybridGroupBy = "day" | "week";

/** One window can only cover so many closed sessions before it is an export. */
export const MAX_HYBRID_ROWS = 20_000;

/* ── Row shapes (what the queries return) ────────────────────────────── */

export interface HybridEntryRow {
  userId: number;
  displayName: string | null;
  streamId: number | null;
  taskId: number | null;
  appId: number | null;
  checkIn: Date | string;
  entrySource: string | null;
  agentLabel: string | null;
  seconds: unknown;
  tokens: unknown;
  cost: unknown;
}

export interface StreamRef {
  id: number;
  name: string;
  agentBudgetUsd: number | null;
  archived: boolean;
}

export interface AppRef {
  id: number;
  key: string;
  name: string;
}

/** One `completed` task event inside the window. */
export interface CompletionRow {
  taskId: number | null;
  actorUserId: number | null;
}

/** Lifetime human/agent cost of one task, from the `IN (…)` aggregate. */
export interface TaskCostRow {
  taskId: number;
  agentSeconds: unknown;
  humanSeconds: unknown;
  tokens: unknown;
  cost: unknown;
}

/* ── Result shapes (what the dashboard reads) ─────────────────────────── */

export interface HybridBucket {
  key: string;
  label: string;
  from: string;
  to: string;
  minutes: number;
  sessions: number;
  human: HumanBucket;
  agent: AgentBucket;
  /** Agent minutes as a percentage of the bucket's worked minutes. */
  agentSharePct: number;
}

export interface StreamHybrid {
  streamId: number | null;
  name: string;
  minutes: number;
  sessions: number;
  human: HumanBucket;
  agent: AgentBucket;
  agentSharePct: number;
  agentBudgetUsd: number | null;
  /** Spend against budget, 0–∞ percent. null when the stream has no budget. */
  burnPct: number | null;
  overBudget: boolean;
  remainingUsd: number | null;
  archived: boolean;
}

export interface AppHybrid {
  appId: number | null;
  key: string | null;
  name: string;
  minutes: number;
  sessions: number;
  human: HumanBucket;
  agent: AgentBucket;
  agentSharePct: number;
}

export interface AgentHybrid {
  userId: number;
  displayName: string;
  minutes: number;
  tokens: number;
  costUsd: number;
  sessions: number;
  tasksCompleted: number;
}

export interface TaskCostStat {
  agentMinutes: number;
  tokens: number;
  costUsd: number;
}

export interface PerCompletedTask {
  /** Tasks whose `completed` event lands in the window. */
  count: number;
  /** Of those, how many carry any agent time at all. */
  withAgent: number;
  /** Median across every task completed in the window, agent-less ones included at zero. */
  median: TaskCostStat;
  /** Median across only the tasks an agent actually touched — the price of agent help. */
  withAgentMedian: TaskCostStat;
  mean: TaskCostStat;
  total: TaskCostStat;
}

export interface HybridTotals {
  minutes: number;
  sessions: number;
  human: HumanBucket;
  agent: AgentBucket;
  agentSharePct: number;
  tasksCompleted: number;
  /** Sum of the budgets of the streams that have one — what the org has authorised. */
  budgetUsd: number;
  overBudgetStreams: number;
  /** Agent seats that logged anything in the window. */
  agentSeats: number;
}

export interface HybridRange {
  from: string;
  to: string;
  groupBy: HybridGroupBy;
  days: number;
  buckets: number;
}

export interface HybridSummary {
  range: HybridRange;
  series: HybridBucket[];
  byStream: StreamHybrid[];
  byApp: AppHybrid[];
  topAgents: AgentHybrid[];
  perCompletedTask: PerCompletedTask;
  totals: HybridTotals;
  /** One computed paragraph. Assembled from the figures above, never a model. */
  narrative: string;
  /** True when the read hit MAX_HYBRID_ROWS — narrow the window. */
  truncated: boolean;
}

/* ── Accumulator ─────────────────────────────────────────────────────── */

interface Acc {
  humanSeconds: number;
  agentSeconds: number;
  tokens: number;
  cost: number;
  sessions: number;
}

const newAcc = (): Acc => ({ humanSeconds: 0, agentSeconds: 0, tokens: 0, cost: 0, sessions: 0 });

const isAgent = (row: HybridEntryRow): boolean => row.entrySource === "agent";

function add(acc: Acc, row: HybridEntryRow, seconds: number) {
  acc.sessions += 1;
  if (isAgent(row)) {
    acc.agentSeconds += seconds;
    acc.tokens += num(row.tokens);
    acc.cost += num(row.cost);
  } else {
    acc.humanSeconds += seconds;
  }
}

/** Rounding happens once, at the end, so many short sessions do not each lose up to 30s. */
function humanOf(acc: Acc): HumanBucket {
  return { minutes: minutesFrom(acc.humanSeconds) };
}

function agentOf(acc: Acc): AgentBucket {
  return { minutes: minutesFrom(acc.agentSeconds), tokens: Math.round(acc.tokens), costUsd: usd(acc.cost) };
}

/** One decimal place: "31%" reads as a claim, "30.8%" as a measurement. */
export function sharePct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** Even counts average the two middle values — the usual definition, stated once. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length);

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/* ── The fold ────────────────────────────────────────────────────────── */

export interface HybridInputs {
  from: Date;
  to: Date;
  groupBy: HybridGroupBy;
  entries: HybridEntryRow[];
  streams: StreamRef[];
  apps: AppRef[];
  /** `completed` task events inside the window, one row per event. */
  completions: CompletionRow[];
  /** Lifetime cost of each task completed in the window. */
  taskCosts: TaskCostRow[];
  truncated?: boolean;
}

export function foldHybrid(input: HybridInputs): HybridSummary {
  const { from, to, groupBy } = input;

  /* series — every bucket in the window, so an idle day still draws a gap. */
  const buckets = new Map<string, { at: Date; acc: Acc }>();
  for (const at of enumerateBuckets(from, to, groupBy)) {
    buckets.set(bucketKey(at, groupBy), { at, acc: newAcc() });
  }

  const total = newAcc();
  const perStream = new Map<number | null, Acc>();
  const perApp = new Map<number | null, Acc>();
  const perAgent = new Map<number, Acc & { displayName: string }>();
  const perTaskAgentSeconds = new Map<number, number>();

  for (const row of input.entries) {
    const seconds = Math.max(0, num(row.seconds));
    if (seconds <= 0) continue;
    const at = asDate(row.checkIn);

    const key = bucketKey(at, groupBy);
    let bucket = buckets.get(key);
    if (!bucket) {
      // A row just outside the enumerated span (clock skew, a 400-bucket window
      // that enumerate declined) still has to be counted somewhere.
      bucket = { at: bucketStart(at, groupBy), acc: newAcc() };
      buckets.set(key, bucket);
    }
    add(bucket.acc, row, seconds);
    add(total, row, seconds);

    const streamAcc = perStream.get(row.streamId) ?? newAcc();
    add(streamAcc, row, seconds);
    perStream.set(row.streamId, streamAcc);

    const appAcc = perApp.get(row.appId) ?? newAcc();
    add(appAcc, row, seconds);
    perApp.set(row.appId, appAcc);

    if (isAgent(row)) {
      const name = row.displayName ?? row.agentLabel ?? `seat ${row.userId}`;
      const agentAcc = perAgent.get(row.userId) ?? { ...newAcc(), displayName: name };
      if (!agentAcc.displayName) agentAcc.displayName = name;
      add(agentAcc, row, seconds);
      perAgent.set(row.userId, agentAcc);
      if (row.taskId !== null) {
        perTaskAgentSeconds.set(row.taskId, (perTaskAgentSeconds.get(row.taskId) ?? 0) + seconds);
      }
    }
  }

  const series: HybridBucket[] = Array.from(buckets.entries())
    .sort((a, b) => +a[1].at - +b[1].at)
    .map(([key, b]) => {
      const human = humanOf(b.acc);
      const agent = agentOf(b.acc);
      const minutes = human.minutes + agent.minutes;
      return {
        key,
        label: bucketLabel(b.at, groupBy),
        from: bucketStart(b.at, groupBy).toISOString(),
        to: bucketEnd(b.at, groupBy).toISOString(),
        minutes,
        sessions: b.acc.sessions,
        human,
        agent,
        agentSharePct: sharePct(agent.minutes, minutes),
      };
    });

  /* byStream — every stream with activity, plus every stream carrying a budget
     (a budget with no spend against it is exactly what a manager wants to see). */
  const streamById = new Map(input.streams.map((s) => [s.id, s]));
  const streamKeys = new Set<number | null>(perStream.keys());
  for (const s of input.streams) {
    if (!s.archived && s.agentBudgetUsd !== null && s.agentBudgetUsd > 0) streamKeys.add(s.id);
  }

  const byStream: StreamHybrid[] = Array.from(streamKeys)
    .map((id) => {
      const acc = perStream.get(id) ?? newAcc();
      const ref = id === null ? undefined : streamById.get(id);
      const human = humanOf(acc);
      const agent = agentOf(acc);
      const minutes = human.minutes + agent.minutes;
      const budget = ref?.agentBudgetUsd ?? null;
      const hasBudget = budget !== null && budget > 0;
      return {
        streamId: id,
        name: ref?.name ?? (id === null ? "(no stream)" : `stream ${id}`),
        minutes,
        sessions: acc.sessions,
        human,
        agent,
        agentSharePct: sharePct(agent.minutes, minutes),
        agentBudgetUsd: budget,
        burnPct: hasBudget ? Math.round((agent.costUsd / budget!) * 1000) / 10 : null,
        overBudget: hasBudget ? agent.costUsd > budget! : false,
        remainingUsd: hasBudget ? usd(budget! - agent.costUsd) : null,
        archived: ref?.archived ?? false,
      };
    })
    .sort((a, b) => b.agent.costUsd - a.agent.costUsd || b.minutes - a.minutes || a.name.localeCompare(b.name));

  /* byApp — a session's app is the app of the task it points at. */
  const appById = new Map(input.apps.map((a) => [a.id, a]));
  const byApp: AppHybrid[] = Array.from(perApp.entries())
    .map(([id, acc]) => {
      const ref = id === null ? undefined : appById.get(id);
      const human = humanOf(acc);
      const agent = agentOf(acc);
      const minutes = human.minutes + agent.minutes;
      return {
        appId: id,
        key: ref?.key ?? null,
        name: ref?.name ?? (id === null ? "(no app)" : `app ${id}`),
        minutes,
        sessions: acc.sessions,
        human,
        agent,
        agentSharePct: sharePct(agent.minutes, minutes),
      };
    })
    .filter((a) => a.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));

  /* topAgents — completions counted per actor, deduplicated by task so a task
     completed twice does not count twice. */
  const completedTasks = new Set<number>();
  const completedByActor = new Map<number, Set<number>>();
  for (const c of input.completions) {
    if (c.taskId === null) continue;
    completedTasks.add(c.taskId);
    if (c.actorUserId === null) continue;
    const set = completedByActor.get(c.actorUserId) ?? new Set<number>();
    set.add(c.taskId);
    completedByActor.set(c.actorUserId, set);
  }

  const topAgents: AgentHybrid[] = Array.from(perAgent.entries())
    .map(([userId, acc]) => {
      const agent = agentOf(acc);
      return {
        userId,
        displayName: acc.displayName,
        minutes: agent.minutes,
        tokens: agent.tokens,
        costUsd: agent.costUsd,
        sessions: acc.sessions,
        tasksCompleted: completedByActor.get(userId)?.size ?? 0,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.minutes - a.minutes || a.displayName.localeCompare(b.displayName));

  /* perCompletedTask — the lifetime agent cost of each task completed in the
     window, so a task finished today still carries the agent time it cost last
     week. Tasks completed with no agent help are counted at zero: leaving them
     out would turn "cost per completed task" into "cost per agent task". */
  const costByTask = new Map<number, TaskCostRow>();
  for (const row of input.taskCosts) costByTask.set(row.taskId, row);

  const taskMinutes: number[] = [];
  const taskTokens: number[] = [];
  const taskCosts: number[] = [];
  const touchedMinutes: number[] = [];
  const touchedTokens: number[] = [];
  const touchedCosts: number[] = [];
  for (const taskId of completedTasks) {
    const row = costByTask.get(taskId);
    const minutes = row ? minutesFrom(Math.max(0, num(row.agentSeconds))) : minutesFrom(perTaskAgentSeconds.get(taskId) ?? 0);
    const tokens = row ? Math.round(num(row.tokens)) : 0;
    const cost = row ? usd(num(row.cost)) : 0;
    taskMinutes.push(minutes);
    taskTokens.push(tokens);
    taskCosts.push(cost);
    if (minutes > 0 || tokens > 0 || cost > 0) {
      touchedMinutes.push(minutes);
      touchedTokens.push(tokens);
      touchedCosts.push(cost);
    }
  }

  const perCompletedTask: PerCompletedTask = {
    count: completedTasks.size,
    withAgent: touchedCosts.length,
    median: {
      agentMinutes: Math.round(median(taskMinutes)),
      tokens: Math.round(median(taskTokens)),
      costUsd: usd(median(taskCosts)),
    },
    withAgentMedian: {
      agentMinutes: Math.round(median(touchedMinutes)),
      tokens: Math.round(median(touchedTokens)),
      costUsd: usd(median(touchedCosts)),
    },
    mean: {
      agentMinutes: Math.round(mean(taskMinutes)),
      tokens: Math.round(mean(taskTokens)),
      costUsd: usd(mean(taskCosts)),
    },
    total: {
      agentMinutes: taskMinutes.reduce((s, v) => s + v, 0),
      tokens: taskTokens.reduce((s, v) => s + v, 0),
      costUsd: usd(taskCosts.reduce((s, v) => s + v, 0)),
    },
  };

  const human = humanOf(total);
  const agent = agentOf(total);
  const minutes = human.minutes + agent.minutes;
  const totals: HybridTotals = {
    minutes,
    sessions: total.sessions,
    human,
    agent,
    agentSharePct: sharePct(agent.minutes, minutes),
    tasksCompleted: completedTasks.size,
    budgetUsd: usd(input.streams.filter((s) => !s.archived && (s.agentBudgetUsd ?? 0) > 0).reduce((s, x) => s + (x.agentBudgetUsd ?? 0), 0)),
    overBudgetStreams: byStream.filter((s) => s.overBudget).length,
    agentSeats: perAgent.size,
  };

  const days = Math.max(1, Math.round((bucketEnd(to, "day").getTime() - bucketStart(from, "day").getTime()) / 86_400_000));
  const summary: Omit<HybridSummary, "narrative"> = {
    range: { from: from.toISOString(), to: to.toISOString(), groupBy, days, buckets: series.length },
    series,
    byStream,
    byApp,
    topAgents,
    perCompletedTask,
    totals,
    truncated: input.truncated ?? false,
  };

  return { ...summary, narrative: narrateHybrid(summary) };
}

/* ── The narrative ───────────────────────────────────────────────────── */

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * One paragraph, assembled from the folded figures: how much work landed and how
 * much of it was the machines, where their money went and whether the budget
 * held, what a completed task costs, and who spent the most.
 */
export function narrateHybrid(s: Omit<HybridSummary, "narrative">): string {
  const window = `${format(new Date(s.range.from), "d MMM")} and ${format(new Date(s.range.to), "d MMM yyyy")}`;

  if (s.totals.minutes === 0) {
    return `Nothing closed between ${window}, so there is no human/agent split to read yet — start a timer, or let an agent log its work over MCP. Agent spend for the window is ${sayUsd(0)}.`;
  }

  const parts: string[] = [];
  const t = s.totals;

  if (t.agent.minutes === 0) {
    parts.push(
      `Between ${window} the organization logged ${sayMinutes(t.minutes)} across ${plural(t.sessions, "session")}, all of it human — no agent booked time, so agent spend for the window is ${sayUsd(0)}.`
    );
  } else {
    parts.push(
      `Between ${window} the organization logged ${sayMinutes(t.minutes)} across ${plural(t.sessions, "session")}: agents did ${t.agentSharePct}% of the hours for ${sayUsd(t.agent.costUsd)} over ${sayTokens(t.agent.tokens)} tokens, against ${sayMinutes(t.human.minutes)} of human work.`
    );

    // The stream the money actually went to — the sentence a manager reads first.
    const lead = s.byStream.find((x) => x.agent.costUsd > 0) ?? s.byStream[0];
    if (lead) {
      const budget =
        lead.agentBudgetUsd === null
          ? "which carries no agent budget"
          : lead.overBudget
            ? `past its ${sayUsd(lead.agentBudgetUsd)} budget at ${lead.burnPct}%`
            : `under the ${sayUsd(lead.agentBudgetUsd)} budget at ${lead.burnPct}% of it`;
      parts.push(`Agents did ${lead.agentSharePct}% of the hours on ${lead.name} for ${sayUsd(lead.agent.costUsd)} — ${budget}.`);
    }

    const over = s.byStream.filter((x) => x.overBudget);
    if (over.length > 1) {
      parts.push(`${plural(over.length, "stream")} are over budget: ${over.map((x) => x.name).join(", ")}.`);
    }
  }

  if (s.perCompletedTask.count > 0) {
    const m = s.perCompletedTask.median;
    parts.push(
      s.perCompletedTask.withAgent === 0
        ? `${plural(s.perCompletedTask.count, "task")} finished in the window, none of them with agent help.`
        : `${plural(s.perCompletedTask.count, "task")} finished in the window, ${s.perCompletedTask.withAgent} with agent help; the median of those carried ${sayUsd(s.perCompletedTask.withAgentMedian.costUsd)} and ${sayMinutes(s.perCompletedTask.withAgentMedian.agentMinutes)} of agent time, against ${sayUsd(m.costUsd)} across all ${s.perCompletedTask.count}.`
    );
  }

  const top = s.topAgents[0];
  if (top && top.costUsd > 0) {
    parts.push(
      `${top.displayName} is the heaviest seat at ${sayUsd(top.costUsd)} over ${plural(top.sessions, "session")}${top.tasksCompleted > 0 ? `, closing ${plural(top.tasksCompleted, "task")}` : ""}.`
    );
  }

  return parts.join(" ");
}

/* ── Reads ───────────────────────────────────────────────────────────── */

/**
 * Closed, non-break sessions inside the window, with the stream they sit in, the
 * app of the task they point at and who logged them.
 *
 * `extract(epoch from (check_out - check_in))` is the one duration expression
 * Nano computes for us; everything else about the row is folded in JS.
 */
async function readEntries(orgId: number, from: Date, to: Date): Promise<{ rows: HybridEntryRow[]; truncated: boolean }> {
  const raw = (await db.execute(sql`
    select te.user_id, u.display_name, te.stream_id, te.task_id, t.app_id, te.check_in,
           te.entry_source, te.agent_label,
           extract(epoch from (te.check_out - te.check_in)) as seconds,
           te.tokens_used as tokens, te.api_cost_usd as cost
    from time_entries te
    left join users u on u.id = te.user_id
    left join tasks t on t.id = te.task_id
    where te.org_id = ${orgId} and te.is_break = false and te.check_out is not null
      and te.check_in >= ${from.toISOString()} and te.check_in <= ${to.toISOString()}
    order by te.check_in
    limit ${MAX_HYBRID_ROWS}
  `)) as unknown as Record<string, unknown>[];

  return {
    truncated: raw.length >= MAX_HYBRID_ROWS,
    rows: raw.map((r) => ({
      userId: num(r.user_id),
      displayName: (r.display_name as string | null) ?? null,
      streamId: r.stream_id === null || r.stream_id === undefined ? null : num(r.stream_id),
      taskId: r.task_id === null || r.task_id === undefined ? null : num(r.task_id),
      appId: r.app_id === null || r.app_id === undefined ? null : num(r.app_id),
      checkIn: r.check_in as Date | string,
      entrySource: (r.entry_source as string | null) ?? null,
      agentLabel: (r.agent_label as string | null) ?? null,
      seconds: r.seconds,
      tokens: r.tokens,
      cost: r.cost,
    })),
  };
}

async function readStreams(orgId: number): Promise<StreamRef[]> {
  const rows = (await db.execute(sql`
    select id, name, agent_budget_usd, archived from streams where org_id = ${orgId}
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: num(r.id),
    name: String(r.name ?? ""),
    agentBudgetUsd: r.agent_budget_usd === null || r.agent_budget_usd === undefined ? null : usd(num(r.agent_budget_usd)),
    archived: r.archived === true,
  }));
}

async function readApps(orgId: number): Promise<AppRef[]> {
  const rows = (await db.execute(sql`
    select id, key, name from apps where org_id = ${orgId}
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({ id: num(r.id), key: String(r.key ?? ""), name: String(r.name ?? "") }));
}

/** `completed` task events inside the window — when a task was finished, and by whom. */
async function readCompletions(orgId: number, from: Date, to: Date): Promise<CompletionRow[]> {
  const rows = (await db.execute(sql`
    select task_id, actor_user_id
    from task_events
    where org_id = ${orgId} and kind = 'completed'
      and created_at >= ${from.toISOString()} and created_at <= ${to.toISOString()}
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    taskId: r.task_id === null || r.task_id === undefined ? null : num(r.task_id),
    actorUserId: r.actor_user_id === null || r.actor_user_id === undefined ? null : num(r.actor_user_id),
  }));
}

/**
 * Lifetime human/agent totals for the tasks completed in this window.
 *
 * Deliberately *not* window-filtered: a task finished on Monday was often worked
 * on a fortnight earlier, and "cost per completed task" that ignored that cost
 * would flatter every short window. One row per task via `CASE WHEN` inside the
 * aggregates, which is the split Nano supports (no `FILTER`).
 */
async function readTaskCosts(orgId: number, taskIds: number[]): Promise<TaskCostRow[]> {
  if (taskIds.length === 0) return [];
  const idList = sql.join(
    taskIds.map((id) => sql`${id}`),
    sql`, `
  );
  const rows = (await db.execute(sql`
    select task_id,
      coalesce(sum(case when entry_source = 'agent' then extract(epoch from (check_out - check_in)) else 0 end), 0) as agent_seconds,
      coalesce(sum(case when entry_source = 'agent' then 0 else extract(epoch from (check_out - check_in)) end), 0) as human_seconds,
      coalesce(sum(case when entry_source = 'agent' then tokens_used else 0 end), 0) as tokens,
      coalesce(sum(case when entry_source = 'agent' then api_cost_usd else 0 end), 0) as cost_usd
    from time_entries
    where org_id = ${orgId} and is_break = false and check_out is not null
      and task_id in (${idList})
    group by task_id
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    taskId: num(r.task_id),
    agentSeconds: r.agent_seconds,
    humanSeconds: r.human_seconds,
    tokens: r.tokens,
    cost: r.cost_usd,
  }));
}

/* ── Entry point ─────────────────────────────────────────────────────── */

export interface HybridWindow {
  from: Date;
  to: Date;
  groupBy: HybridGroupBy;
}

/** The whole dashboard in one call: four small reads, then the pure fold. */
export async function hybridSummary(orgId: number, window: HybridWindow): Promise<HybridSummary> {
  const [entries, streams, apps, completions] = await Promise.all([
    readEntries(orgId, window.from, window.to),
    readStreams(orgId),
    readApps(orgId),
    readCompletions(orgId, window.from, window.to),
  ]);

  const completedIds = Array.from(new Set(completions.map((c) => c.taskId).filter((id): id is number => id !== null)));
  const taskCosts = await readTaskCosts(orgId, completedIds);

  return foldHybrid({
    from: window.from,
    to: window.to,
    groupBy: window.groupBy,
    entries: entries.rows,
    streams,
    apps,
    completions,
    taskCosts,
    truncated: entries.truncated,
  });
}
