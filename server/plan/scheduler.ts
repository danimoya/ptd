import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "../../db";
import { taskRecurrences, tasks, type Task } from "../../db/schema";
import { copyCustomValues } from "./customFields";
import { catchUp, instanceKey, parseRule } from "./recurrence";
import { recordEvent, type Actor } from "./taskEvents";
import { serializeTask } from "./taskOps";
import type { TaskRecurrence } from "./recurrences";

/**
 * The recurrence scheduler: one 60-second tick, started by
 * `registerPlanRoutes`, that turns every due `task_recurrences` row into a new
 * backlog card cloned from its template.
 *
 * Two things make it safe to run more than one PTD process against the same
 * database:
 *
 *  1. **The claim is the UPDATE.** A row is only worked on if
 *     `UPDATE … SET next_run_at = <next> WHERE id = ? AND active AND next_run_at <= now`
 *     returns it. The loser of a race updates zero rows and moves on, so two
 *     instances cannot both clone the same firing.
 *  2. **The claim happens before the clone.** A crash between the two loses one
 *     instance of a recurring card, which is recoverable; the alternative order
 *     duplicates cards forever, which is not.
 *
 * `PTD_SCHEDULER=0` disables the tick entirely (tests, one-off CLI processes,
 * and any deployment that would rather drive `runDueRecurrences` itself).
 */

export const SCHEDULER_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function schedulerEnabled(): boolean {
  return process.env.PTD_SCHEDULER !== "0" && process.env.NODE_ENV !== "test";
}

export function startScheduler(): boolean {
  if (!schedulerEnabled()) {
    console.log("[plan] recurrence scheduler disabled (PTD_SCHEDULER=0)");
    return false;
  }
  if (timer) return true;
  timer = setInterval(() => {
    void tick();
  }, SCHEDULER_INTERVAL_MS);
  // Never hold the process open for the sake of the timer.
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[plan] recurrence scheduler started (every ${SCHEDULER_INTERVAL_MS / 1000}s)`);
  return true;
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** One pass, with an in-process guard so a slow tick cannot overlap the next one. */
export async function tick(now = new Date()): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await runDueRecurrences(now);
    if (result.created.length > 0) {
      console.log(`[plan] recurrence: created ${result.created.length} card(s) — ${result.created.map((c) => c.externalKey ?? c.taskId).join(", ")}`);
    }
  } catch (error) {
    console.error("[plan] recurrence tick failed:", error);
  } finally {
    running = false;
  }
}

export interface RecurrenceRun {
  recurrenceId: number;
  templateTaskId: number;
  taskId: number;
  externalKey: string | null;
  scheduledFor: string;
}

/**
 * Fire every recurrence whose `next_run_at` has passed. Exported so a test (or
 * an operator with `PTD_SCHEDULER=0`) can drive it directly.
 */
export async function runDueRecurrences(now = new Date()): Promise<{ due: number; created: RecurrenceRun[] }> {
  const due = (await db
    .select()
    .from(taskRecurrences)
    .where(and(eq(taskRecurrences.active, true), lte(taskRecurrences.nextRunAt, now)))
    .orderBy(asc(taskRecurrences.nextRunAt))) as TaskRecurrence[];

  const created: RecurrenceRun[] = [];
  for (const row of due) {
    const parsed = parseRule(row.rule);
    if (!parsed.ok) {
      console.error(`[plan] recurrence ${row.id} has an unreadable rule ("${row.rule}") — deactivating it`);
      await db.update(taskRecurrences).set({ active: false }).where(eq(taskRecurrences.id, row.id));
      continue;
    }

    const scheduledFor = new Date(row.nextRunAt);
    const next = catchUp(parsed.rule, scheduledFor, now);

    // The claim. Zero rows back means another instance got there first.
    const claimed = await db
      .update(taskRecurrences)
      .set({ nextRunAt: next, lastRunAt: now })
      .where(and(eq(taskRecurrences.id, row.id), eq(taskRecurrences.active, true), lte(taskRecurrences.nextRunAt, now)))
      .returning();
    if (claimed.length === 0) continue;

    try {
      const run = await cloneTemplate(row, scheduledFor);
      if (run) created.push(run);
    } catch (error) {
      console.error(`[plan] recurrence ${row.id} failed to clone task ${row.templateTaskId}:`, error);
    }
  }
  return { due: due.length, created };
}

/**
 * Clone the template into a fresh backlog card.
 *
 * Copied: title, description, stream, app, assignee, estimate, tags, the
 * priority inputs (and a pinned score, so a manually-scored template keeps its
 * score) and every custom value. Not copied: dates, dependencies, status and
 * completion — an instance starts in the backlog with nothing blocking it,
 * which is the whole point of the pattern.
 */
async function cloneTemplate(recurrence: TaskRecurrence, scheduledFor: Date): Promise<RecurrenceRun | null> {
  const [templateRow] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, recurrence.templateTaskId), eq(tasks.orgId, recurrence.orgId)))
    .limit(1);
  const template = templateRow as Task | undefined;
  if (!template) {
    console.error(`[plan] recurrence ${recurrence.id} points at missing task ${recurrence.templateTaskId} — deactivating it`);
    await db.update(taskRecurrences).set({ active: false }).where(eq(taskRecurrences.id, recurrence.id));
    return null;
  }

  const externalKey = await freeKey(recurrence.orgId, instanceKey(template.externalKey ?? `TASK-${template.id}`, scheduledFor));

  const [row] = await db
    .insert(tasks)
    .values({
      orgId: recurrence.orgId,
      title: template.title,
      description: template.description,
      status: "backlog",
      streamId: template.streamId,
      appId: template.appId,
      assignedTo: template.assignedTo,
      startDate: null,
      dueDate: null,
      estimatedDuration: template.estimatedDuration,
      dependencies: [],
      externalKey,
      urgency: template.urgency,
      impact: template.impact,
      effort: template.effort,
      priorityScore: template.priorityScore,
      prioritySource: template.prioritySource,
      priorityNote: template.priorityNote,
      tags: Array.isArray(template.tags) ? template.tags : [],
      completed: false,
      createdBy: recurrence.createdBy,
    })
    .returning();
  const instance = row as Task;

  await copyCustomValues(recurrence.orgId, template.id, instance.id);

  // No human is at the wheel, so the actor is the schedule itself — but it
  // carries the user id of whoever set the rule, so the card is traceable.
  const actor: Actor = { userId: recurrence.createdBy, label: "recurring schedule", isAgent: false, via: "api" };
  await recordEvent({
    taskId: instance.id,
    orgId: recurrence.orgId,
    actor,
    kind: "created",
    note: "recurring",
    payload: {
      task: serializeTask(instance),
      recurrenceId: recurrence.id,
      templateTaskId: template.id,
      rule: recurrence.rule,
      scheduledFor: scheduledFor.toISOString(),
    },
  });

  return {
    recurrenceId: recurrence.id,
    templateTaskId: template.id,
    taskId: instance.id,
    externalKey: instance.externalKey,
    scheduledFor: scheduledFor.toISOString(),
  };
}

/**
 * `externalKey` is unique per org at the application level, and two firings can
 * legitimately land on the same day (a rule edited mid-day, a catch-up run), so
 * a taken key gets a `-2`, `-3`… suffix rather than failing the clone.
 */
async function freeKey(orgId: number, wanted: string): Promise<string | null> {
  const rows = await db.select({ externalKey: tasks.externalKey }).from(tasks).where(eq(tasks.orgId, orgId));
  const taken = new Set(rows.map((r) => r.externalKey).filter((k): k is string => !!k));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; i < 50; i++) {
    const candidate = `${wanted}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}
