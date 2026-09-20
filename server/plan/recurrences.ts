import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { taskRecurrences, tasks } from "../../db/schema";
import { ActionError, type ActionContext } from "../actions/registry";
import { actorFrom, recordEvent } from "./taskEvents";
import { requireTask } from "./taskOps";
import { describeRule, nextRunAfter, parseRule } from "./recurrence";

/** db/schema.ts is frozen and exports no row type for this table, so it is inferred here. */
export type TaskRecurrence = typeof taskRecurrences.$inferSelect;

/**
 * A recurrence turns one card into a template: the card itself is never moved
 * or completed by the schedule, it is *cloned* into a new backlog card every
 * time the rule fires (server/plan/scheduler.ts does the firing).
 *
 * One recurrence per template card — setting a rule on a card that already has
 * one replaces it, which is what the dialog's single field implies. Clearing it
 * flips `active` off rather than deleting the row, so `lastRunAt` survives as a
 * record of what the schedule did.
 */

export interface RecurrenceRow {
  id: number;
  templateTaskId: number;
  templateTitle: string | null;
  templateKey: string | null;
  rule: string;
  preview: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  active: boolean;
  createdBy: number | null;
  createdAt: string | null;
}

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function serializeRecurrence(row: TaskRecurrence, template?: { title: string | null; externalKey: string | null }): RecurrenceRow {
  const parsed = parseRule(row.rule);
  return {
    id: row.id,
    templateTaskId: row.templateTaskId,
    templateTitle: template?.title ?? null,
    templateKey: template?.externalKey ?? null,
    rule: row.rule,
    preview: parsed.ok ? describeRule(parsed.rule) : `unreadable rule: ${row.rule}`,
    nextRunAt: iso(row.nextRunAt),
    lastRunAt: iso(row.lastRunAt),
    active: row.active,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  };
}

export async function recurrenceForTask(orgId: number, taskId: number): Promise<TaskRecurrence | null> {
  const [row] = await db
    .select()
    .from(taskRecurrences)
    .where(and(eq(taskRecurrences.orgId, orgId), eq(taskRecurrences.templateTaskId, taskId)))
    .limit(1);
  return (row as TaskRecurrence) ?? null;
}

/** Every recurrence in the org with its template's title, next first. */
export async function listRecurrences(orgId: number, includeInactive = false): Promise<RecurrenceRow[]> {
  const rows = await db
    .select({ r: taskRecurrences, title: tasks.title, externalKey: tasks.externalKey })
    .from(taskRecurrences)
    .innerJoin(tasks, eq(taskRecurrences.templateTaskId, tasks.id))
    .where(eq(taskRecurrences.orgId, orgId))
    .orderBy(asc(taskRecurrences.nextRunAt), asc(taskRecurrences.id));
  return rows
    .filter((row) => includeInactive || row.r.active)
    .map((row) => serializeRecurrence(row.r as TaskRecurrence, { title: row.title, externalKey: row.externalKey }));
}

/**
 * Store or clear the rule on one card. `rule: null` clears it.
 *
 * `nextRunAt` is computed from now, so saving the same rule again pushes the
 * next firing to the next slot rather than firing immediately.
 */
export async function setRecurrence(
  ctx: ActionContext,
  taskId: number,
  rule: string | null,
  now = new Date()
): Promise<{ recurrence: RecurrenceRow | null; cleared: boolean }> {
  const task = await requireTask(ctx.orgId, taskId);
  const existing = await recurrenceForTask(ctx.orgId, taskId);

  if (rule === null) {
    if (!existing || !existing.active) return { recurrence: existing ? serializeRecurrence(existing, task) : null, cleared: false };
    const [row] = await db
      .update(taskRecurrences)
      .set({ active: false })
      .where(and(eq(taskRecurrences.id, existing.id), eq(taskRecurrences.orgId, ctx.orgId)))
      .returning();
    await recordEvent({
      taskId,
      orgId: ctx.orgId,
      actor: actorFrom(ctx),
      kind: "updated",
      note: "recurrence cleared",
      webhookKind: "task.recurrence_cleared",
      payload: { rule: existing.rule },
    });
    return { recurrence: serializeRecurrence(row as TaskRecurrence, task), cleared: true };
  }

  const parsed = parseRule(rule);
  if (!parsed.ok) throw new ActionError("invalid", parsed.error);
  const nextRunAt = nextRunAfter(parsed.rule, now);

  const stored = existing
    ? ((
        await db
          .update(taskRecurrences)
          .set({ rule: parsed.canonical, nextRunAt, active: true, createdBy: existing.createdBy ?? ctx.userId })
          .where(and(eq(taskRecurrences.id, existing.id), eq(taskRecurrences.orgId, ctx.orgId)))
          .returning()
      )[0] as TaskRecurrence)
    : ((
        await db
          .insert(taskRecurrences)
          .values({ orgId: ctx.orgId, templateTaskId: taskId, rule: parsed.canonical, nextRunAt, active: true, createdBy: ctx.userId })
          .returning()
      )[0] as TaskRecurrence);

  await recordEvent({
    taskId,
    orgId: ctx.orgId,
    actor: actorFrom(ctx),
    kind: "updated",
    note: `recurrence set · ${describeRule(parsed.rule)}`,
    webhookKind: "task.recurrence_set",
    payload: { rule: parsed.canonical, nextRunAt: nextRunAt.toISOString() },
  });
  return { recurrence: serializeRecurrence(stored, task), cleared: false };
}
