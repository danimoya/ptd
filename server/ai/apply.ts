/**
 * Writing a suggestion onto a card.
 *
 * Kept apart from the prompt and the provider so the only database write in the
 * AI feature is eleven lines long and reads in one go. It goes through the same
 * two invariants every other Plan mutation honours — org-scoped WHERE, one
 * `task_events` row — by reusing the Plan surface's own helpers rather than
 * re-implementing them.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { priorityScore, tasks, type Task } from "../../db/schema";
import { actorFrom, diffTask, recordEvent } from "../plan/taskEvents";
import { requireTask, serializeTask } from "../plan/taskOps";
import type { ActionContext } from "../actions/registry";
import type { PrioritySuggestion } from "./prompt";

/**
 * The history note. A human reading the card's history needs to know a model
 * proposed the number and which person accepted it — the model itself is in the
 * usage ledger, and the rationale lands on the card as `priorityNote`.
 */
export function aiEventNote(displayName: string): string {
  return `AI suggestion applied by ${displayName}`;
}

export interface AppliedPriority {
  task: ReturnType<typeof serializeTask>;
  changed: boolean;
}

/**
 * Write urgency/impact/effort, the derived score, `prioritySource: "ai"` and the
 * rationale as `priorityNote`.
 *
 * Manual-score protection is NOT here — it belongs to the action, which decides
 * whether the caller asked for the override. By the time we are in this function
 * the answer was yes.
 */
export async function applyAiPriority(
  taskId: number,
  suggestion: PrioritySuggestion,
  ctx: ActionContext,
): Promise<AppliedPriority> {
  const existing = await requireTask(ctx.orgId, taskId);
  const score = priorityScore(suggestion.urgency, suggestion.impact, suggestion.effort);

  const [row] = await db
    .update(tasks)
    .set({
      urgency: suggestion.urgency,
      impact: suggestion.impact,
      effort: suggestion.effort,
      priorityScore: score,
      prioritySource: "ai",
      priorityNote: suggestion.rationale,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.orgId, ctx.orgId)))
    .returning();

  const final = row as Task;
  const changes = diffTask(existing, final);
  // A suggestion that lands on the numbers the card already had still flips
  // prioritySource to "ai", so `changes` is non-null in practice — the guard is
  // for the one case where it was already an identical AI score.
  if (changes) {
    await recordEvent({
      taskId,
      orgId: ctx.orgId,
      actor: actorFrom(ctx),
      kind: "priority_changed",
      changes,
      note: aiEventNote(ctx.displayName),
      payload: { task: serializeTask(final), prioritySource: "ai" },
    });
  }
  return { task: serializeTask(final), changed: !!changes };
}
