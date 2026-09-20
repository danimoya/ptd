import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  apps,
  memberships,
  streamApps,
  streams,
  tasks,
  users,
  priorityScore as scoreOf,
  type Role,
  type Task,
} from "../../db/schema";
import { cascadeFrom } from "../cascade";
import { ActionError } from "../actions/registry";
import { hasRole } from "../types";
import { recordEvent, type Actor } from "./taskEvents";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* ───────────────────────── reads ───────────────────────── */

/** Every task in the org. The graph algorithms all work on this in JS, like the original board. */
export async function fetchOrgTasks(orgId: number): Promise<Task[]> {
  return (await db.select().from(tasks).where(eq(tasks.orgId, orgId))) as Task[];
}

/** One task, or null. Org-scoped in the WHERE clause so a foreign id reads as "not found". */
export async function fetchOrgTask(orgId: number, taskId: number): Promise<Task | null> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.orgId, orgId)))
    .limit(1);
  return (row as Task) ?? null;
}

export async function requireTask(orgId: number, taskId: number): Promise<Task> {
  const task = await fetchOrgTask(orgId, taskId);
  if (!task) throw new ActionError("not_found", `Task ${taskId} not found in this organization`);
  return task;
}

/* ───────────────────────── pure helpers ───────────────────────── */

export function depsOf(task: Pick<Task, "dependencies">): number[] {
  return Array.isArray(task.dependencies) ? task.dependencies : [];
}

export function tagsOf(task: Pick<Task, "tags">): string[] {
  return Array.isArray(task.tags) ? task.tags : [];
}

/**
 * When a task finishes: startDate + estimatedDuration days, or the explicit
 * dueDate when that is later. Identical to the rule cascade.ts uses.
 */
export function endOf(task: Pick<Task, "startDate" | "dueDate" | "estimatedDuration">): Date | null {
  if (!task.startDate) return null;
  const start = new Date(task.startDate);
  if (task.dueDate) {
    const due = new Date(task.dueDate);
    return due > start ? due : start;
  }
  return new Date(start.getTime() + (task.estimatedDuration ?? 0) * MS_PER_DAY);
}

/**
 * Slack in days: dueDate − (startDate + estimatedDuration). Null when either
 * end of the subtraction is missing — the Cascade view sorts those last.
 */
export function floatDays(task: Pick<Task, "startDate" | "dueDate" | "estimatedDuration">): number | null {
  if (!task.startDate || !task.dueDate) return null;
  const work = new Date(task.startDate).getTime() + (task.estimatedDuration ?? 0) * MS_PER_DAY;
  return Math.round((new Date(task.dueDate).getTime() - work) / MS_PER_DAY);
}

/** Waiting on at least one dependency that is neither complete nor already finished. */
export function isBlocked(task: Task, all: Task[]): boolean {
  const deps = depsOf(task);
  if (deps.length === 0) return false;
  const now = new Date();
  for (const depId of deps) {
    const dep = all.find((t) => t.id === depId);
    if (!dep || dep.completed) continue;
    const end = endOf(dep);
    if (!end || end > now) return true;
  }
  return false;
}

/**
 * Longest chain through the dependency DAG weighted by estimatedDuration —
 * the original board's critical path. O(V+E) memoised DFS; safe against cycles because
 * every dependency write goes through wouldCreateCycle first, and the `seen`
 * set makes it terminate even if a legacy row slipped one in.
 */
export function computeCriticalPath(all: Task[]): { length: number; path: Task[] } {
  const byId = new Map(all.map((t) => [t.id, t]));
  const memo = new Map<number, { length: number; path: Task[] }>();

  function dp(id: number, seen: Set<number>): { length: number; path: Task[] } {
    const cached = memo.get(id);
    if (cached) return cached;
    const task = byId.get(id);
    if (!task || seen.has(id)) return { length: 0, path: [] };
    seen.add(id);
    let best: { length: number; path: Task[] } = { length: 0, path: [] };
    for (const depId of depsOf(task)) {
      const sub = dp(depId, seen);
      if (sub.length > best.length) best = sub;
    }
    seen.delete(id);
    const result = { length: best.length + (task.estimatedDuration ?? 0), path: [...best.path, task] };
    memo.set(id, result);
    return result;
  }

  let winner: { length: number; path: Task[] } = { length: 0, path: [] };
  for (const task of all) {
    const r = dp(task.id, new Set());
    if (r.length > winner.length) winner = r;
  }
  return winner;
}

/* ───────────────────────── CPM: forward / backward pass ───────────────────────── */

/**
 * One row of the critical-path method's two passes, in real dates.
 *
 * `floatDays` is the slack the card has before it starts dragging the whole
 * plan: latestStart − earliestStart. Zero float is what "on the critical path"
 * means here, and the two are kept in lockstep on purpose — the Plan surface
 * reads `onCriticalPath` for the vermilion outline and `floatDays` for the
 * number at the end of the bar, and they must never disagree.
 */
export interface TaskSchedule {
  taskId: number;
  earliestStart: Date;
  earliestFinish: Date;
  latestStart: Date;
  latestFinish: Date;
  floatDays: number;
  onCriticalPath: boolean;
}

export interface CpmSchedule {
  /** One row per task, ordered by id. */
  perTask: TaskSchedule[];
  /** Earliest start in the whole plan, and the day the last card finishes. */
  projectStart: Date;
  projectFinish: Date;
  spanDays: number;
}

/** A card's working length in days. An unknown or non-positive duration counts as one day. */
export function durationDays(task: Pick<Task, "estimatedDuration">): number {
  const days = task.estimatedDuration;
  return typeof days === "number" && days > 0 ? days : 1;
}

/** Whole UTC days since the epoch — the integer grid both passes work on. */
function dayNumber(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

function dateOfDay(day: number): Date {
  return new Date(day * MS_PER_DAY);
}

/**
 * Dependency order (dependencies first) by Kahn's algorithm, ids ascending so
 * the result is deterministic. Anything left over sits in a dependency cycle —
 * it is appended rather than dropped, so a legacy row that predates
 * `wouldCreateCycle` still gets a schedule instead of vanishing from the graph.
 */
function topoOrder(all: Task[], byId: Map<number, Task>): number[] {
  const indegree = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const task of all) {
    const deps = depsOf(task).filter((id) => byId.has(id) && id !== task.id);
    indegree.set(task.id, new Set(deps).size);
    for (const dep of new Set(deps)) {
      const list = dependents.get(dep) ?? [];
      list.push(task.id);
      dependents.set(dep, list);
    }
  }
  const queue = all
    .filter((t) => (indegree.get(t.id) ?? 0) === 0)
    .map((t) => t.id)
    .sort((a, b) => a - b);
  const order: number[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (order.length < all.length) {
    const placed = new Set(order);
    for (const task of [...all].sort((a, b) => a.id - b.id)) if (!placed.has(task.id)) order.push(task.id);
  }
  return order;
}

/**
 * The critical-path method over the dependency DAG.
 *
 * Forward pass: a card cannot start before its own `startDate` (a card already
 * scheduled keeps the day the board shows), before every dependency has
 * finished, or — when it has no date of its own — before today; it finishes
 * `durationDays` later. Backward pass: a card may finish no later than the
 * earliest of its dependents' latest starts, and a card nothing waits on may
 * run until the plan's own finish. The difference between the two is its float,
 * and a card with none of it is on the critical path.
 *
 * Deliberately date-aware, which is what separates it from
 * `computeCriticalPath` above: that one answers "how long is the longest chain
 * of work", this one answers "which bars on this board have no slack left".
 * Both ship in the `critical_path` response — the old fields unchanged.
 */
export function computeCpmSchedule(all: Task[], now = new Date()): CpmSchedule {
  const byId = new Map(all.map((t) => [t.id, t]));
  const today = dayNumber(now);
  if (all.length === 0) {
    return { perTask: [], projectStart: dateOfDay(today), projectFinish: dateOfDay(today), spanDays: 0 };
  }

  const order = topoOrder(all, byId);
  const dependents = new Map<number, number[]>();
  for (const task of all) {
    for (const dep of depsOf(task)) {
      if (!byId.has(dep) || dep === task.id) continue;
      const list = dependents.get(dep) ?? [];
      if (!list.includes(task.id)) list.push(task.id);
      dependents.set(dep, list);
    }
  }

  const earliestStart = new Map<number, number>();
  const earliestFinish = new Map<number, number>();
  for (const id of order) {
    const task = byId.get(id)!;
    // An anchored card holds its own start, even when that is in the past; an
    // undated one is pulled forward to today and then pushed by its deps.
    let start = task.startDate ? dayNumber(new Date(task.startDate)) : today;
    for (const dep of depsOf(task)) {
      const finish = earliestFinish.get(dep);
      // `undefined` only happens inside a cycle, where there is no honest answer.
      if (finish !== undefined && finish > start) start = finish;
    }
    earliestStart.set(id, start);
    earliestFinish.set(id, start + durationDays(task));
  }

  const projectFinish = Math.max(...all.map((t) => earliestFinish.get(t.id) ?? today));
  const projectStart = Math.min(...all.map((t) => earliestStart.get(t.id) ?? today));

  const latestStart = new Map<number, number>();
  const latestFinish = new Map<number, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const task = byId.get(id)!;
    const successors = dependents.get(id) ?? [];
    let finish = projectFinish;
    for (const successor of successors) {
      const start = latestStart.get(successor);
      if (start !== undefined && start < finish) finish = start;
    }
    // Never earlier than the card's own earliest finish: float stays >= 0 even
    // for a row reached through a cycle.
    const own = earliestFinish.get(id) ?? projectFinish;
    if (finish < own) finish = own;
    latestFinish.set(id, finish);
    latestStart.set(id, finish - durationDays(task));
  }

  const perTask = [...all]
    .sort((a, b) => a.id - b.id)
    .map((task) => {
      const es = earliestStart.get(task.id) ?? today;
      const ef = earliestFinish.get(task.id) ?? today;
      const lf = latestFinish.get(task.id) ?? ef;
      const ls = latestStart.get(task.id) ?? es;
      const slack = ls - es;
      return {
        taskId: task.id,
        earliestStart: dateOfDay(es),
        earliestFinish: dateOfDay(ef),
        latestStart: dateOfDay(ls),
        latestFinish: dateOfDay(lf),
        floatDays: slack,
        onCriticalPath: slack === 0,
      };
    });

  return {
    perTask,
    projectStart: dateOfDay(projectStart),
    projectFinish: dateOfDay(projectFinish),
    spanDays: projectFinish - projectStart,
  };
}

/**
 * the original board's status rule: a card with a startDate belongs on the timeline, a
 * card without one belongs in the backlog. An explicit status from the caller
 * always wins; completed cards are never re-derived.
 */
export function deriveStatus(
  existing: Pick<Task, "status" | "completed">,
  nextStartDate: Date | null,
  explicit?: string
): string | undefined {
  if (explicit) return explicit;
  if (existing.completed) return undefined;
  if (nextStartDate && existing.status === "backlog") return "in-progress";
  if (!nextStartDate && existing.status === "in-progress") return "backlog";
  return undefined;
}

export interface PriorityInputs {
  urgency: number;
  impact: number;
  effort: number;
  priorityScore: number;
  prioritySource: string;
}

export interface PriorityPatch {
  urgency?: number;
  impact?: number;
  effort?: number;
  /** A number pins the score and flips prioritySource to "manual"; null clears the override. */
  manualScore?: number | null;
}

/**
 * Resolve the four priority columns.
 *
 * `force` distinguishes the two contracts in the work package:
 *   - task.update (force = false) recomputes the formula only when the card is
 *     still on 'formula' — a 'manual' or 'ai' score survives an edit to
 *     urgency/impact/effort;
 *   - task.set_priority (force = true) is the explicit re-scoring call, so
 *     passing no manualScore deliberately drops back to the formula.
 */
export function resolvePriority(
  existing: PriorityInputs,
  patch: PriorityPatch,
  opts: { force?: boolean } = {}
): { urgency: number; impact: number; effort: number; priorityScore: number; prioritySource: "formula" | "manual" | "ai" } {
  const urgency = patch.urgency ?? existing.urgency;
  const impact = patch.impact ?? existing.impact;
  const effort = patch.effort ?? existing.effort;

  if (typeof patch.manualScore === "number") {
    return {
      urgency,
      impact,
      effort,
      priorityScore: Math.max(0, Math.min(100, Math.round(patch.manualScore))),
      prioritySource: "manual",
    };
  }
  const keepOverride =
    patch.manualScore !== null &&
    !opts.force &&
    (existing.prioritySource === "manual" || existing.prioritySource === "ai");
  if (keepOverride) {
    return {
      urgency,
      impact,
      effort,
      priorityScore: existing.priorityScore,
      prioritySource: existing.prioritySource as "manual" | "ai",
    };
  }
  return { urgency, impact, effort, priorityScore: scoreOf(urgency, impact, effort), prioritySource: "formula" };
}

/**
 * A member may only strike their own card off the board; manager and above may
 * complete anything in the org.
 */
export function canComplete(role: Role, task: Pick<Task, "assignedTo">, userId: number): boolean {
  if (hasRole(role, "manager")) return true;
  return task.assignedTo === userId;
}

/** ISO-8601 in, Date out. Anything unparseable is a caller error, not a 500. */
export function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ActionError("invalid", `${field} is not a valid ISO 8601 date: ${value}`);
  return date;
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Wire shape for a task. Dates go out as ISO strings and the jsonb columns are
 * always arrays, so MCP clients never have to guess; `end` and `slackDays` are
 * derived so an agent can reason about schedule risk without re-deriving them.
 */
export function serializeTask(task: Task) {
  return {
    id: task.id,
    orgId: task.orgId,
    title: task.title,
    description: task.description,
    status: task.status,
    streamId: task.streamId,
    appId: task.appId,
    assignedTo: task.assignedTo,
    startDate: isoOrNull(task.startDate),
    dueDate: isoOrNull(task.dueDate),
    estimatedDuration: task.estimatedDuration,
    dependencies: depsOf(task),
    externalKey: task.externalKey,
    urgency: task.urgency,
    impact: task.impact,
    effort: task.effort,
    priorityScore: task.priorityScore,
    prioritySource: task.prioritySource,
    priorityNote: task.priorityNote,
    tags: tagsOf(task),
    completed: task.completed,
    createdBy: task.createdBy,
    createdAt: isoOrNull(task.createdAt),
    updatedAt: isoOrNull(task.updatedAt),
    end: isoOrNull(endOf(task)),
    slackDays: floatDays(task),
  };
}

/* ───────────────────────── validators ───────────────────────── */

/**
 * Application-level FK + tenancy check for `tasks.assigned_to`. The assignee
 * must hold a membership in THIS org; a real user id from another org is
 * rejected with the same message as a nonexistent one so the endpoint cannot
 * be used to probe the global users table.
 */
export async function assertAssignee(orgId: number, userId: number) {
  const [row] = await db
    .select({ userId: memberships.userId, displayName: users.displayName, isAgent: users.isAgent, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ActionError("invalid", `User ${userId} is not a member of this organization — call org.members for valid assignee ids`);
  }
  return row;
}

export async function assertStream(orgId: number, streamId: number) {
  const [row] = await db
    .select()
    .from(streams)
    .where(and(eq(streams.id, streamId), eq(streams.orgId, orgId)))
    .limit(1);
  if (!row) throw new ActionError("not_found", `Stream ${streamId} not found in this organization`);
  return row;
}

export async function assertApp(orgId: number, appId: number) {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.orgId, orgId)))
    .limit(1);
  if (!row) throw new ActionError("not_found", `App ${appId} not found in this organization`);
  return row;
}

/** True when `appId` is attached to `streamId` through stream_apps. */
export async function appIsOnStream(streamId: number, appId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: streamApps.id })
    .from(streamApps)
    .where(and(eq(streamApps.streamId, streamId), eq(streamApps.appId, appId)))
    .limit(1);
  return !!row;
}

/**
 * A task may only point at an app the stream actually owns — otherwise the
 * Plan board would offer an app picker whose value contradicts the swim-lane.
 */
export async function assertAppOnStream(orgId: number, streamId: number, appId: number) {
  await assertStream(orgId, streamId);
  const app = await assertApp(orgId, appId);
  if (!(await appIsOnStream(streamId, appId))) {
    throw new ActionError(
      "invalid",
      `App ${appId} (${app.key}) is not attached to stream ${streamId} — call stream.attach_app first, or leave streamId unset`
    );
  }
  return app;
}

/**
 * Dependencies must be integers, in this org, and never the task itself.
 * Returns the de-duplicated list in the order given.
 */
export function assertDependencies(taskId: number | null, raw: number[], all: Task[]): number[] {
  const owned = new Set(all.map((t) => t.id));
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of raw) {
    if (!Number.isInteger(id)) throw new ActionError("invalid", "dependencies must be integer task ids");
    if (taskId !== null && id === taskId) throw new ActionError("invalid", "A task cannot depend on itself");
    if (!owned.has(id)) throw new ActionError("invalid", `Dependency ${id} is not a task in this organization`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/* ───────────────────────── cascade ───────────────────────── */

/**
 * Persist the forward-shift triggered by one edit.
 *
 * Shared by every action that can move a card in time so the REST face, the
 * MCP face and the board all cascade identically. Side effects, both ported
 * from the original board: a shifted row that picks up a startDate while still flagged
 * "backlog" is promoted to "in-progress", and every dependent that actually
 * moved gets its own `cascade_shifted` history row so the card's history
 * explains a date it did not choose itself.
 */
export async function applyCascade(
  orgId: number,
  rootId: number,
  actor: Actor
): Promise<{ shifted: number; ids: number[] }> {
  const orgTasks = await fetchOrgTasks(orgId);
  const byId = new Map(orgTasks.map((t) => [t.id, t]));
  const changes = cascadeFrom(orgTasks, rootId);
  const ids: number[] = [];

  for (const change of changes) {
    const existing = byId.get(change.id);
    const update: Record<string, unknown> = {
      startDate: change.startDate,
      dueDate: change.dueDate,
      updatedAt: new Date(),
    };
    if (existing && !existing.completed) {
      if (change.startDate && existing.status === "backlog") update.status = "in-progress";
      else if (!change.startDate && existing.status === "in-progress") update.status = "backlog";
    }
    await db.update(tasks).set(update).where(and(eq(tasks.id, change.id), eq(tasks.orgId, orgId)));

    // The caller writes its own created/updated event for the root.
    if (change.id === rootId || !existing) continue;
    const oldStart = isoOrNull(existing.startDate);
    const newStart = isoOrNull(change.startDate);
    if (oldStart === newStart) continue;
    ids.push(change.id);
    await recordEvent({
      taskId: change.id,
      orgId,
      actor,
      kind: "cascade_shifted",
      changes: {
        startDate: { old: oldStart, new: newStart },
        dueDate: { old: isoOrNull(existing.dueDate), new: isoOrNull(change.dueDate) },
      },
      note: `Shifted by upstream edit on task #${rootId}`,
      payload: { rootId },
    });
  }
  return { shifted: ids.length, ids };
}
