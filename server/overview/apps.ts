import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { apps, streamApps, streams } from "../../db/schema";
import { ActionError } from "../actions/registry";

/**
 * App and stream rollups. Counters are always computed, never stored (the schema
 * says so), and each rollup uses COUNT(DISTINCT CASE …) so the stream_apps join
 * cannot multiply task rows.
 */

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v) || 0);

export interface AppCounters { openTasks: number; critical: number; maxPriority: number; streamCount: number }
export type AppWithCounters = typeof apps.$inferSelect & AppCounters & { streams: { id: number; name: string; color: string | null }[] };

async function counters(orgId: number, appId?: number) {
  const scope = appId === undefined ? sql`` : sql` and a.id = ${appId}`;
  const rows = (await db.execute(sql`
    select a.id,
      count(distinct case when t.status in ('backlog', 'triaged', 'in-progress') then t.id else null end) as open_tasks,
      count(distinct case when t.status in ('backlog', 'triaged', 'in-progress') and t.priority_score >= 75 then t.id else null end) as critical,
      coalesce(max(case when t.status in ('backlog', 'triaged', 'in-progress') then t.priority_score else 0 end), 0) as max_priority,
      count(distinct sa.stream_id) as stream_count
    from apps a
    left join tasks t on t.app_id = a.id and t.org_id = ${orgId}
    left join stream_apps sa on sa.app_id = a.id
    where a.org_id = ${orgId}${scope}
    group by a.id
  `)) as unknown as Record<string, unknown>[];
  const byId = new Map<number, AppCounters>();
  for (const r of rows) {
    byId.set(num(r.id), {
      openTasks: num(r.open_tasks),
      critical: num(r.critical),
      maxPriority: num(r.max_priority),
      streamCount: num(r.stream_count),
    });
  }
  return byId;
}

/** Stream names per app, so the Apps table can show which streams touch each app. */
async function streamsByApp(orgId: number) {
  const rows = await db
    .select({ appId: streamApps.appId, id: streams.id, name: streams.name, color: streams.color })
    .from(streamApps)
    .innerJoin(streams, eq(streamApps.streamId, streams.id))
    .where(eq(streams.orgId, orgId))
    .orderBy(streams.position, streams.id);
  const byApp = new Map<number, { id: number; name: string; color: string | null }[]>();
  for (const r of rows) {
    const list = byApp.get(r.appId) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    byApp.set(r.appId, list);
  }
  return byApp;
}

const EMPTY: AppCounters = { openTasks: 0, critical: 0, maxPriority: 0, streamCount: 0 };

export async function listApps(orgId: number, includeArchived = false): Promise<AppWithCounters[]> {
  const rows = await db.select().from(apps).where(eq(apps.orgId, orgId)).orderBy(apps.key);
  const [byId, byApp] = await Promise.all([counters(orgId), streamsByApp(orgId)]);
  return rows
    .filter((a) => includeArchived || !a.archived)
    .map((a) => ({ ...a, ...(byId.get(a.id) ?? EMPTY), streams: byApp.get(a.id) ?? [] }))
    .sort((a, b) => b.maxPriority - a.maxPriority || a.key.localeCompare(b.key));
}

export async function getApp(orgId: number, appId: number): Promise<AppWithCounters> {
  const [row] = await db.select().from(apps).where(and(eq(apps.orgId, orgId), eq(apps.id, appId))).limit(1);
  if (!row) throw new ActionError("not_found", `No app ${appId} in this organization`);
  const [byId, byApp] = await Promise.all([counters(orgId, appId), streamsByApp(orgId)]);
  return { ...row, ...(byId.get(appId) ?? EMPTY), streams: byApp.get(appId) ?? [] };
}

export async function appStats(orgId: number, appId: number) {
  const app = await getApp(orgId, appId);
  return {
    appId: app.id,
    key: app.key,
    name: app.name,
    archived: app.archived,
    open: app.openTasks,
    critical: app.critical,
    maxPriority: app.maxPriority,
    streams: app.streams,
  };
}

/** Streams whose work crosses `minApps` or more apps — the original backlog tracker's "systemic themes". */
export async function systemicStreams(orgId: number, minApps = 2) {
  // ORDER BY is by ordinal on purpose: Nano 4.40 resolves either the select
  // aliases or the GROUP BY columns in ORDER BY, never a mix of the two, and it
  // cannot resolve a repeated aggregate expression there at all ("column agg_0
  // does not exist"). Positions always resolve.
  const rows = (await db.execute(sql`
    select s.id, s.name, s.color, s.agent_budget_usd, s.position,
           count(distinct sa.app_id) as app_count
    from streams s
    join stream_apps sa on sa.stream_id = s.id
    where s.org_id = ${orgId} and s.archived = false
    group by s.id, s.name, s.color, s.agent_budget_usd, s.position
    having count(distinct sa.app_id) >= ${minApps}
    order by 6 desc, 5 asc, 1 asc
  `)) as unknown as Record<string, unknown>[];
  if (rows.length === 0) return [];

  const streamIds = rows.map((r) => num(r.id));
  const [appRows, openRows] = await Promise.all([
    db
      .select({ streamId: streamApps.streamId, appId: apps.id, key: apps.key, name: apps.name, archived: apps.archived })
      .from(streamApps)
      .innerJoin(apps, eq(streamApps.appId, apps.id))
      .where(eq(apps.orgId, orgId))
      .orderBy(apps.key),
    db.execute(sql`
      select stream_id,
        sum(case when status in ('backlog', 'triaged', 'in-progress') then 1 else 0 end) as open_tasks,
        sum(case when status in ('backlog', 'triaged', 'in-progress') and priority_score >= 75 then 1 else 0 end) as critical,
        coalesce(max(case when status in ('backlog', 'triaged', 'in-progress') then priority_score else 0 end), 0) as max_priority
      from tasks
      where org_id = ${orgId} and stream_id is not null
      group by stream_id
    `) as unknown as Promise<Record<string, unknown>[]>,
  ]);

  const appsByStream = new Map<number, { appId: number; key: string; name: string; archived: boolean }[]>();
  for (const r of appRows) {
    const list = appsByStream.get(r.streamId) ?? [];
    list.push({ appId: r.appId, key: r.key, name: r.name, archived: r.archived });
    appsByStream.set(r.streamId, list);
  }
  const openByStream = new Map<number, { open: number; critical: number; maxPriority: number }>();
  for (const r of openRows) {
    openByStream.set(num(r.stream_id), { open: num(r.open_tasks), critical: num(r.critical), maxPriority: num(r.max_priority) });
  }

  return streamIds.map((id, i) => {
    const r = rows[i];
    const counts = openByStream.get(id) ?? { open: 0, critical: 0, maxPriority: 0 };
    return {
      streamId: id,
      name: String(r.name),
      color: (r.color as string | null) ?? null,
      agentBudgetUsd: r.agent_budget_usd === null ? null : Number(r.agent_budget_usd),
      appCount: num(r.app_count),
      apps: appsByStream.get(id) ?? [],
      open: counts.open,
      critical: counts.critical,
      maxPriority: counts.maxPriority,
    };
  });
}
