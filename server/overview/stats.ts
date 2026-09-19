import { sql } from "drizzle-orm";
import { db } from "../../db";

/**
 * Org-wide KPIs. Every figure is a SQL aggregate — nothing is counted in JS —
 * and the dialect stays inside what HeliosDB-Nano 4.40 implements:
 * COUNT / SUM / MAX over CASE, GROUP BY, HAVING, scalar subqueries, plain joins.
 * Deliberately avoided: FILTER (WHERE …) aggregates, recursive CTEs, DO blocks,
 * `= ANY(array)`, and NULLS FIRST/LAST (parsed but ignored, so ordering uses CASE).
 */

const OPEN = sql`('backlog', 'triaged', 'in-progress')`;

export interface OrgStats {
  tasks: { open: number; triaged: number; inProgress: number; completed: number; wontfix: number; total: number };
  byPriorityBand: { critical: number; high: number; medium: number; low: number };
  overdue: number;
  apps: number;
  streams: number;
  members: { humans: number; agents: number };
  agentCost: AgentCost & { last7d: AgentCost };
  agentActivity: AgentActivity[];
}

export interface AgentCost { minutes: number; tokens: number; costUsd: number; entries: number }

export interface AgentActivity {
  id: number;
  taskId: number | null;
  taskTitle: string | null;
  kind: string;
  note: string | null;
  via: string;
  actorUserId: number | null;
  actorLabel: string | null;
  createdAt: string;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v) || 0);
const round2 = (v: unknown): number => Math.round(num(v) * 100) / 100;
/** Nano returns `timestamp` from a raw query as a naive UTC string; hand the client ISO. */
const iso = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString();
  const s = String(v ?? "").trim();
  if (!s) return new Date(0).toISOString();
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
};

export async function taskCounts(orgId: number) {
  const [row] = (await db.execute(sql`
    select
      sum(case when status in ('backlog', 'triaged', 'in-progress') then 1 else 0 end) as open,
      sum(case when status = 'triaged' then 1 else 0 end) as triaged,
      sum(case when status = 'in-progress' then 1 else 0 end) as in_progress,
      sum(case when status = 'completed' then 1 else 0 end) as completed,
      sum(case when status = 'wontfix' then 1 else 0 end) as wontfix,
      count(*)::int as total
    from tasks
    where org_id = ${orgId}
  `)) as unknown as Record<string, unknown>[];
  return {
    open: num(row?.open),
    triaged: num(row?.triaged),
    inProgress: num(row?.in_progress),
    completed: num(row?.completed),
    wontfix: num(row?.wontfix),
    total: num(row?.total),
  };
}

/** Sprinter's bands: critical 75-100, high 50-74, medium 25-49, low 0-24 — open tasks only. */
async function priorityBands(orgId: number) {
  const [row] = (await db.execute(sql`
    select
      sum(case when priority_score >= 75 then 1 else 0 end) as critical,
      sum(case when priority_score >= 50 and priority_score < 75 then 1 else 0 end) as high,
      sum(case when priority_score >= 25 and priority_score < 50 then 1 else 0 end) as medium,
      sum(case when priority_score < 25 then 1 else 0 end) as low
    from tasks
    where org_id = ${orgId} and status in ${OPEN}
  `)) as unknown as Record<string, unknown>[];
  return { critical: num(row?.critical), high: num(row?.high), medium: num(row?.medium), low: num(row?.low) };
}

async function inventory(orgId: number) {
  const [row] = (await db.execute(sql`
    select
      (select count(*)::int from tasks where org_id = ${orgId} and due_date is not null
         and due_date < now() and status in ('backlog', 'triaged', 'in-progress')) as overdue,
      (select count(*)::int from apps where org_id = ${orgId} and archived = false) as apps,
      (select count(*)::int from streams where org_id = ${orgId} and archived = false) as streams
  `)) as unknown as Record<string, unknown>[];
  return { overdue: num(row?.overdue), apps: num(row?.apps), streams: num(row?.streams) };
}

async function memberMix(orgId: number) {
  const [row] = (await db.execute(sql`
    select
      sum(case when u.is_agent then 0 else 1 end) as humans,
      sum(case when u.is_agent then 1 else 0 end) as agents
    from memberships m
    join users u on u.id = m.user_id
    where m.org_id = ${orgId}
  `)) as unknown as Record<string, unknown>[];
  return { humans: num(row?.humans), agents: num(row?.agents) };
}

/**
 * Agent minutes / tokens / dollars. Duration comes from the closed interval only —
 * a running entry contributes tokens and cost but no minutes, so the figure never
 * inflates while a timer is open.
 */
export async function agentCost(orgId: number, since?: Date): Promise<AgentCost> {
  const window = since ? sql` and check_in >= ${since.toISOString()}` : sql``;
  const [row] = (await db.execute(sql`
    select
      coalesce(sum(case when check_out is not null then extract(epoch from (check_out - check_in)) else 0 end), 0) as seconds,
      coalesce(sum(tokens_used), 0) as tokens,
      coalesce(sum(api_cost_usd), 0) as cost_usd,
      count(*)::int as entries
    from time_entries
    where org_id = ${orgId} and entry_source = 'agent' and is_break = false${window}
  `)) as unknown as Record<string, unknown>[];
  return {
    minutes: Math.round(num(row?.seconds) / 60),
    tokens: num(row?.tokens),
    costUsd: round2(row?.cost_usd),
    entries: num(row?.entries),
  };
}

/** The last N task events whose actor is an agent seat — the Overview "Agents" feed. */
export async function agentActivity(orgId: number, limit = 20): Promise<AgentActivity[]> {
  const rows = (await db.execute(sql`
    select e.id, e.task_id, e.kind, e.note, e.via, e.actor_user_id, e.actor_label,
           e.created_at, t.title as task_title
    from task_events e
    join users u on u.id = e.actor_user_id
    left join tasks t on t.id = e.task_id
    where e.org_id = ${orgId} and u.is_agent = true
    order by e.created_at desc, e.id desc
    limit ${limit}
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: num(r.id),
    taskId: r.task_id === null ? null : num(r.task_id),
    taskTitle: (r.task_title as string | null) ?? null,
    kind: String(r.kind),
    note: (r.note as string | null) ?? null,
    via: String(r.via ?? "web"),
    actorUserId: r.actor_user_id === null ? null : num(r.actor_user_id),
    actorLabel: (r.actor_label as string | null) ?? null,
    createdAt: iso(r.created_at),
  }));
}

export async function orgStats(orgId: number): Promise<OrgStats> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const [taskRow, bands, inv, members, cost, last7d, activity] = await Promise.all([
    taskCounts(orgId),
    priorityBands(orgId),
    inventory(orgId),
    memberMix(orgId),
    agentCost(orgId),
    agentCost(orgId, sevenDaysAgo),
    agentActivity(orgId, 20),
  ]);
  return {
    tasks: taskRow,
    byPriorityBand: bands,
    overdue: inv.overdue,
    apps: inv.apps,
    streams: inv.streams,
    members,
    agentCost: { ...cost, last7d },
    agentActivity: activity,
  };
}
