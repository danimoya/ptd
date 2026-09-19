/**
 * Client-side copy of server/cascade.ts — kept deliberately identical so the
 * Cascade view's "slip preview" predicts exactly what the server would write.
 * The only change is the input type: the board holds ISO strings, not Date
 * objects, and `new Date(...)` swallows both. tests/plan/cascade.test.ts runs
 * the two implementations against the same fixtures to keep them honest.
 *
 * Importing the server module from client code is not allowed (it pulls the
 * database in), hence the copy.
 */

export interface CascadeTask {
  id: number;
  startDate: Date | string | null;
  dueDate: Date | string | null;
  estimatedDuration: number | null;
  dependencies?: number[] | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function depsOf(task: CascadeTask): number[] {
  return Array.isArray(task.dependencies) ? task.dependencies : [];
}

function shiftedStart(task: CascadeTask, newStart: Date): { start: Date; end: Date | null } {
  const days = task.estimatedDuration ?? 0;
  const newEnd = days > 0 ? new Date(newStart.getTime() + days * MS_PER_DAY) : null;
  return { start: newStart, end: newEnd };
}

export interface CascadeChange {
  id: number;
  startDate: Date;
  dueDate: Date | null;
}

/** Forward-shifts triggered by a single edit to `rootId`. Never pulls a task earlier. */
export function cascadeFrom<T extends CascadeTask>(rawTasks: T[], rootId: number): CascadeChange[] {
  const tasks = rawTasks as unknown as CascadeTask[];
  const byId = new Map<number, CascadeTask>(tasks.map((t) => [t.id, t]));

  // Reverse adjacency: task id → ids of the tasks that depend on it.
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

      // Latest end across this dependent's dependencies, pending changes
      // included so a multi-hop cascade compounds.
      let latestEnd: Date | null = null;
      for (const depId of depsOf(dependent)) {
        const depTask = byId.get(depId);
        if (!depTask) continue;
        const shifted = changes.get(depId);
        const start = shifted ? shifted.startDate : depTask.startDate ? new Date(depTask.startDate) : null;
        if (!start) continue;
        const days = depTask.estimatedDuration ?? 0;
        const end = days > 0 ? new Date(start.getTime() + days * MS_PER_DAY) : start;
        if (!latestEnd || end > latestEnd) latestEnd = end;
      }
      if (!latestEnd) continue;

      const currentStart = changes.get(dependentId)?.startDate ?? new Date(dependent.startDate);
      if (currentStart >= latestEnd) continue;

      const { start: newStart, end: newEnd } = shiftedStart(dependent, latestEnd);
      // Only carry a dueDate forward if the user set one — we don't invent
      // deadlines for tasks that merely have a duration.
      const nextDueDate = dependent.dueDate ? newEnd : null;
      changes.set(dependentId, { id: dependentId, startDate: newStart, dueDate: nextDueDate });
      byId.set(dependentId, { ...dependent, startDate: newStart, dueDate: nextDueDate });
      queue.push(dependentId);
    }
  }

  return Array.from(changes.values());
}

/** True when adding `newDeps` to `taskId` would close a loop. */
export function wouldCreateCycle<T extends CascadeTask>(rawTasks: T[], taskId: number, newDeps: number[]): boolean {
  if (newDeps.includes(taskId)) return true;
  const tasks = rawTasks as unknown as CascadeTask[];

  const adj = new Map<number, number[]>();
  for (const t of tasks) adj.set(t.id, t.id === taskId ? newDeps.slice() : depsOf(t).slice());

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
