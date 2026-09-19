import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { apps, streamApps, streams, tasks, type App, type Stream, type Task } from "../../db/schema";
import { ActionError } from "../actions/registry";
import { dispatchStreamEvent, recordEvent, type Actor } from "./taskEvents";
import { appIsOnStream, assertApp, assertStream, fetchOrgTasks } from "./taskOps";

/**
 * Stream (swim-lane) management.
 *
 * The one real divergence from Kanttban: there a stream was the free-text
 * `tasks.stream` column, so "rename" was a bulk UPDATE over cards and the
 * stream list was a projection. Here `streams` is a table with a colour,
 * position, customer, agent budget and an app attachment list, and
 * `tasks.stream_id` is an FK — so renaming touches exactly one row and the
 * cards follow automatically. What survives is the audit behaviour: a rename
 * or a move still writes one history row per affected card, because that is
 * what makes a board reorganisation legible in a card's own history.
 */

export interface StreamSummary {
  id: number;
  name: string;
  color: string | null;
  customerId: number | null;
  archived: boolean;
  position: number;
  agentBudgetUsd: number | null;
  apps: { id: number; key: string; name: string }[];
  taskCount: number;
  openCount: number;
  completedCount: number;
  scheduledCount: number;
}

export interface StreamListResult {
  streams: StreamSummary[];
  /** Cards with no stream at all — the board shows them in their own lane. */
  unstreamed: { taskCount: number; openCount: number };
  totalTasks: number;
}

export async function listStreams(orgId: number, includeArchived = true): Promise<StreamListResult> {
  const [rows, orgTasks, attachments] = await Promise.all([
    db.select().from(streams).where(eq(streams.orgId, orgId)).orderBy(asc(streams.position), asc(streams.id)),
    fetchOrgTasks(orgId),
    db
      .select({ streamId: streamApps.streamId, appId: apps.id, key: apps.key, name: apps.name })
      .from(streamApps)
      .innerJoin(apps, eq(streamApps.appId, apps.id))
      .where(eq(apps.orgId, orgId)),
  ]);

  const appsByStream = new Map<number, { id: number; key: string; name: string }[]>();
  for (const a of attachments) {
    const list = appsByStream.get(a.streamId) ?? [];
    list.push({ id: a.appId, key: a.key, name: a.name });
    appsByStream.set(a.streamId, list);
  }

  const visible = includeArchived ? rows : rows.filter((s) => !s.archived);
  const summaries: StreamSummary[] = visible.map((s) => {
    const own = orgTasks.filter((t) => t.streamId === s.id);
    return {
      id: s.id,
      name: s.name,
      color: s.color,
      customerId: s.customerId,
      archived: s.archived,
      position: s.position,
      agentBudgetUsd: s.agentBudgetUsd,
      apps: appsByStream.get(s.id) ?? [],
      taskCount: own.length,
      openCount: own.filter((t) => !t.completed).length,
      completedCount: own.filter((t) => t.completed).length,
      scheduledCount: own.filter((t) => !!t.startDate).length,
    };
  });

  const loose = orgTasks.filter((t) => t.streamId === null);
  return {
    streams: summaries,
    unstreamed: { taskCount: loose.length, openCount: loose.filter((t) => !t.completed).length },
    totalTasks: orgTasks.length,
  };
}

export async function listOrgApps(orgId: number): Promise<App[]> {
  return db.select().from(apps).where(eq(apps.orgId, orgId)).orderBy(asc(apps.name));
}

export async function createStream(
  orgId: number,
  input: { name: string; color?: string | null; appIds?: number[] },
  actor: Actor
): Promise<{ stream: Stream; apps: number[] }> {
  const name = input.name.trim();
  if (!name) throw new ActionError("invalid", "name must be a non-empty stream name");

  const existing = await db.select().from(streams).where(eq(streams.orgId, orgId));
  if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    throw new ActionError("conflict", `A stream named "${name}" already exists in this organization`);
  }
  const position = existing.reduce((max, s) => Math.max(max, s.position), 0) + 1;

  const appIds = Array.from(new Set(input.appIds ?? []));
  for (const appId of appIds) await assertApp(orgId, appId);

  const [created] = await db
    .insert(streams)
    .values({ orgId, name, color: input.color ?? null, position })
    .returning();

  for (const appId of appIds) {
    await db.insert(streamApps).values({ streamId: created.id, appId });
  }
  await dispatchStreamEvent(orgId, "created", actor, { streamId: created.id, name, appIds });
  return { stream: created as Stream, apps: appIds };
}

export async function renameStream(orgId: number, streamId: number, nameRaw: string, actor: Actor) {
  const stream = await assertStream(orgId, streamId);
  const name = nameRaw.trim();
  if (!name) throw new ActionError("invalid", "name must be a non-empty stream name");
  if (name === stream.name) throw new ActionError("invalid", `Stream ${streamId} is already named "${name}"`);

  const siblings = await db.select().from(streams).where(eq(streams.orgId, orgId));
  if (siblings.some((s) => s.id !== streamId && s.name.toLowerCase() === name.toLowerCase())) {
    throw new ActionError("conflict", `A stream named "${name}" already exists — use stream.move_tasks to merge instead`);
  }

  const [updated] = await db
    .update(streams)
    .set({ name })
    .where(and(eq(streams.id, streamId), eq(streams.orgId, orgId)))
    .returning();

  // The cards did not change rows, but their lane label did — record it on each
  // so a card's history explains why it reads differently than it did before.
  const affected = (await fetchOrgTasks(orgId)).filter((t) => t.streamId === streamId);
  for (const task of affected) {
    await recordEvent({
      taskId: task.id,
      orgId,
      actor,
      kind: "stream_renamed",
      changes: { stream: { old: stream.name, new: name } },
      note: `Stream renamed "${stream.name}" → "${name}"`,
      payload: { streamId },
    });
  }
  await dispatchStreamEvent(orgId, "renamed", actor, { streamId, from: stream.name, to: name, taskIds: affected.map((t) => t.id) });
  return { stream: updated as Stream, updatedTasks: affected.length };
}

export async function updateStream(
  orgId: number,
  streamId: number,
  patch: { color?: string | null; archived?: boolean; position?: number; agentBudgetUsd?: number | null },
  actor: Actor
) {
  const stream = await assertStream(orgId, streamId);
  const update: Record<string, unknown> = {};
  if ("color" in patch) update.color = patch.color ?? null;
  if ("archived" in patch) update.archived = patch.archived;
  if ("position" in patch) update.position = patch.position;
  if ("agentBudgetUsd" in patch) update.agentBudgetUsd = patch.agentBudgetUsd ?? null;
  if (Object.keys(update).length === 0) throw new ActionError("invalid", "Nothing to update — pass color, archived, position or agentBudgetUsd");

  const [updated] = await db
    .update(streams)
    .set(update)
    .where(and(eq(streams.id, streamId), eq(streams.orgId, orgId)))
    .returning();
  await dispatchStreamEvent(orgId, "updated", actor, { streamId, before: { color: stream.color, archived: stream.archived, position: stream.position, agentBudgetUsd: stream.agentBudgetUsd }, after: update });
  return updated as Stream;
}

export interface MoveTasksResult {
  fromStreamId: number | null;
  toStreamId: number | null;
  moved: number[];
  /** Cards whose appId was cleared because the target stream does not own that app. */
  appsCleared: number[];
}

/**
 * Move every card out of one stream into another (null on either side means
 * "the cards with no stream"). Merging two streams is exactly this call.
 *
 * A card carrying an appId the target stream does not own would break the
 * stream/app invariant task.update enforces, so those appIds are cleared and
 * reported rather than silently left inconsistent.
 */
export async function moveTasksBetweenStreams(
  orgId: number,
  fromStreamId: number | null,
  toStreamId: number | null,
  actor: Actor
): Promise<MoveTasksResult> {
  if (fromStreamId === toStreamId) throw new ActionError("invalid", "fromStreamId and toStreamId are the same stream");
  const from = fromStreamId === null ? null : await assertStream(orgId, fromStreamId);
  const to = toStreamId === null ? null : await assertStream(orgId, toStreamId);

  const affected = (await fetchOrgTasks(orgId)).filter((t) => (t.streamId ?? null) === fromStreamId);
  const moved: number[] = [];
  const appsCleared: number[] = [];

  for (const task of affected) {
    let clearApp = false;
    if (task.appId !== null) {
      clearApp = toStreamId === null ? false : !(await appIsOnStream(toStreamId, task.appId));
    }
    const update: Record<string, unknown> = { streamId: toStreamId, updatedAt: new Date() };
    if (clearApp) update.appId = null;
    await db.update(tasks).set(update).where(and(eq(tasks.id, task.id), eq(tasks.orgId, orgId)));
    moved.push(task.id);
    if (clearApp) appsCleared.push(task.id);

    const changes: Record<string, { old: unknown; new: unknown }> = {
      streamId: { old: fromStreamId, new: toStreamId },
    };
    if (clearApp) changes.appId = { old: task.appId, new: null };
    await recordEvent({
      taskId: task.id,
      orgId,
      actor,
      kind: "stream_moved",
      changes,
      note: to ? `Moved to stream "${to.name}"${clearApp ? " · app detached" : ""}` : "Removed from its stream",
      payload: { fromStreamId, toStreamId },
    });
  }

  await dispatchStreamEvent(orgId, "tasks_moved", actor, {
    fromStreamId,
    toStreamId,
    fromName: from?.name ?? null,
    toName: to?.name ?? null,
    taskIds: moved,
  });
  return { fromStreamId, toStreamId, moved, appsCleared };
}

export async function attachApp(orgId: number, streamId: number, appId: number, actor: Actor) {
  await assertStream(orgId, streamId);
  const app = await assertApp(orgId, appId);
  if (await appIsOnStream(streamId, appId)) {
    return { streamId, appId, key: app.key, attached: false };
  }
  await db.insert(streamApps).values({ streamId, appId });
  await dispatchStreamEvent(orgId, "app_attached", actor, { streamId, appId, key: app.key });
  return { streamId, appId, key: app.key, attached: true };
}

/**
 * Detach an app from a stream. Any card in that stream still pointing at the
 * app loses its appId — leaving it would violate the same invariant
 * task.update enforces on the way in.
 */
export async function detachApp(orgId: number, streamId: number, appId: number, actor: Actor) {
  await assertStream(orgId, streamId);
  const app = await assertApp(orgId, appId);
  const removed = await db
    .delete(streamApps)
    .where(and(eq(streamApps.streamId, streamId), eq(streamApps.appId, appId)))
    .returning({ id: streamApps.id });

  const orphaned = (await fetchOrgTasks(orgId)).filter((t) => t.streamId === streamId && t.appId === appId);
  for (const task of orphaned) {
    await db.update(tasks).set({ appId: null, updatedAt: new Date() }).where(and(eq(tasks.id, task.id), eq(tasks.orgId, orgId)));
    await recordEvent({
      taskId: task.id,
      orgId,
      actor,
      kind: "updated",
      changes: { appId: { old: appId, new: null } },
      note: `App "${app.key}" detached from the stream`,
      payload: { streamId, appId },
    });
  }
  await dispatchStreamEvent(orgId, "app_detached", actor, { streamId, appId, key: app.key, clearedTaskIds: orphaned.map((t) => t.id) });
  return { streamId, appId, key: app.key, detached: removed.length > 0, clearedTasks: orphaned.length };
}

/** Tasks with no stream — used by the board's "no stream" lane and by stream.move_tasks. */
export async function unstreamedTasks(orgId: number): Promise<Task[]> {
  return (await db.select().from(tasks).where(and(eq(tasks.orgId, orgId), isNull(tasks.streamId)))) as Task[];
}
