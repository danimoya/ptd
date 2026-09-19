/**
 * Dependency cascade for the timeline.
 *
 * When a task's start date or duration changes, every task that (transitively)
 * depends on it may need to be pushed forward so its start date is on or after
 * the latest end of its dependencies.
 *
 * Rules:
 *   - Only tasks with a startDate participate in cascading.
 *   - Each task's "end" is startDate + estimatedDuration days, or dueDate
 *     when explicitly set (whichever is later).
 *   - If a dependent's current start is already past every dependency's end,
 *     it's left alone — we only push forward, never pull backward.
 *   - Cycles must be rejected before this runs (validateNoCycle).
 */

import type { Task as RawTask } from "@db/schema";

// drizzle-zod can't see the $type<number[]>() refinement on the jsonb
// dependencies column, so we tighten it locally for the algorithm.
type Task = Omit<RawTask, "dependencies"> & { dependencies?: number[] | null };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function depsOf(task: Task): number[] {
  return Array.isArray(task.dependencies) ? task.dependencies : [];
}

function endOf(task: Task): Date | null {
  if (!task.startDate) return null;
  const start = new Date(task.startDate);
  if (task.dueDate) {
    const due = new Date(task.dueDate);
    return due > start ? due : start;
  }
  const days = task.estimatedDuration ?? 0;
  return new Date(start.getTime() + days * MS_PER_DAY);
}

function shiftedStart(task: Task, newStart: Date): { start: Date; end: Date | null } {
  const days = task.estimatedDuration ?? 0;
  const newEnd = days > 0 ? new Date(newStart.getTime() + days * MS_PER_DAY) : null;
  return { start: newStart, end: newEnd };
}

export interface CascadeChange {
  id: number;
  startDate: Date;
  dueDate: Date | null;
}

/**
 * Compute the set of forward-shifts triggered by a single edit.
 *
 * `tasks` should be the full set of tasks for the team — not just the ones
 * the user happens to see in the current view. The caller should persist
 * each returned change as a separate UPDATE.
 */
export function cascadeFrom(
  rawTasks: RawTask[],
  rootId: number
): CascadeChange[] {
  const tasks = rawTasks as unknown as Task[];
  const byId = new Map<number, Task>(tasks.map((t) => [t.id, t]));

  // Reverse adjacency: task ID → list of IDs of tasks that depend on it.
  const dependentsOf = new Map<number, number[]>();
  for (const t of tasks) {
    for (const dep of depsOf(t)) {
      const arr = dependentsOf.get(dep) ?? [];
      arr.push(t.id);
      dependentsOf.set(dep, arr);
    }
  }

  const changes = new Map<number, CascadeChange>();
  const queue: number[] = [rootId];
  const seen = new Set<number>();

  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);

    for (const dependentId of dependentsOf.get(cur) ?? []) {
      const dependent = byId.get(dependentId);
      if (!dependent || !dependent.startDate) continue;

      // Latest end across all of this dependent's dependencies, taking pending
      // changes into account so a cascade through multiple hops compounds.
      let latestEnd: Date | null = null;
      for (const depId of depsOf(dependent)) {
        const depTask = byId.get(depId);
        if (!depTask) continue;
        const shifted = changes.get(depId);
        const start = shifted
          ? shifted.startDate
          : depTask.startDate
          ? new Date(depTask.startDate)
          : null;
        if (!start) continue;
        const days = depTask.estimatedDuration ?? 0;
        const end = days > 0 ? new Date(start.getTime() + days * MS_PER_DAY) : start;
        if (!latestEnd || end > latestEnd) latestEnd = end;
      }
      if (!latestEnd) continue;

      const currentStart =
        changes.get(dependentId)?.startDate ?? new Date(dependent.startDate);
      if (currentStart >= latestEnd) continue;

      const { start: newStart, end: newEnd } = shiftedStart(dependent, latestEnd);
      // Only carry the dueDate forward if the user originally set one — we
      // don't want to invent dueDates and pin phantom deadlines on the
      // timeline for tasks that simply have a duration.
      const nextDueDate = dependent.dueDate ? newEnd : null;
      changes.set(dependentId, {
        id: dependentId,
        startDate: newStart,
        dueDate: nextDueDate,
      });
      byId.set(dependentId, {
        ...dependent,
        startDate: newStart,
        dueDate: nextDueDate,
      });
      queue.push(dependentId);
    }
  }

  return Array.from(changes.values());
}

/**
 * Returns true if adding `newDeps` to task `taskId` would create a cycle in
 * the dependency graph defined by `tasks`.
 */
export function wouldCreateCycle(
  rawTasks: RawTask[],
  taskId: number,
  newDeps: number[]
): boolean {
  if (newDeps.includes(taskId)) return true;
  const tasks = rawTasks as unknown as Task[];

  const adj = new Map<number, number[]>();
  for (const t of tasks) {
    adj.set(t.id, t.id === taskId ? newDeps.slice() : depsOf(t).slice());
  }

  for (const start of newDeps) {
    const stack: number[] = [start];
    const seen = new Set<number>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === taskId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of adj.get(cur) ?? []) stack.push(next);
    }
  }
  return false;
}

/** Suppresses unused-export warning for endOf during type checking. */
export const _internal = { endOf };
