import { desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { taskEvents, type Task, type TaskEvent } from "../../db/schema";
import { dispatchWebhooks } from "../webhooks";
import type { ActionContext, Via } from "../actions/registry";

/**
 * Append-only history for the Plan surface.
 *
 * Every task mutation lands here as one `task_events` row AND one outbound
 * webhook, so the Edit-card History panel, `task.history` (MCP) and any
 * org integration all read the same story. the original board's kinds are carried
 * over; PTD adds `assigned`, `priority_changed` and `deleted` because the
 * schema has fields the original board did not (assignee events used to be
 * `assignee_changed`, urgency/impact/effort did not exist at all).
 */
export type EventKind =
  | "created"
  | "updated"
  | "completed"
  | "scheduled"
  | "unscheduled"
  | "cascade_shifted"
  | "assigned"
  | "priority_changed"
  | "deleted"
  | "stream_moved"
  | "stream_renamed"
  | "time_logged";

export type Changes = Record<string, { old: unknown; new: unknown }>;

/** Who did it, in the shape both the event row and the webhook envelope want. */
export interface Actor {
  userId: number | null;
  label: string | null;
  isAgent: boolean;
  via: Via;
}

/**
 * Agents are ordinary members, so the only way a human reading history can
 * tell one apart is the label — hence the " (agent)" suffix, exactly as the
 * Plan work package specifies.
 */
export function actorFrom(ctx: ActionContext): Actor {
  return {
    userId: ctx.userId,
    label: ctx.authType === "agent" ? `${ctx.displayName} (agent)` : ctx.displayName,
    isAgent: ctx.authType === "agent",
    via: ctx.via,
  };
}

/** The system actor used for indirect writes (cascade shifts with no human at the wheel). */
export const SYSTEM_ACTOR: Actor = { userId: null, label: "system", isAgent: false, via: "api" };

export interface RecordEventArgs {
  taskId: number;
  orgId: number;
  actor: Actor;
  kind: EventKind;
  changes?: Changes | null;
  note?: string | null;
  /** Extra context for webhook consumers only — never persisted on the row. */
  payload?: Record<string, unknown>;
}

/**
 * Write one history row and fan the event out to the org's webhooks.
 *
 * Fire-and-forget by design: an audit-log or webhook outage must never fail
 * the mutation that triggered it, so both halves are caught and logged.
 */
export async function recordEvent(args: RecordEventArgs): Promise<void> {
  try {
    await db.insert(taskEvents).values({
      taskId: args.taskId,
      orgId: args.orgId,
      actorUserId: args.actor.userId,
      actorLabel: args.actor.label,
      kind: args.kind,
      changes: args.changes ?? null,
      note: args.note ?? null,
      via: args.actor.via,
    });
  } catch (error) {
    console.error("[plan] recordEvent failed:", error, { taskId: args.taskId, kind: args.kind });
  }
  try {
    await dispatchWebhooks(args.orgId, {
      kind: `task.${args.kind}`,
      taskId: args.taskId,
      actor: { userId: args.actor.userId, label: args.actor.label, isAgent: args.actor.isAgent },
      payload: { changes: args.changes ?? null, note: args.note ?? null, via: args.actor.via, ...(args.payload ?? {}) },
    });
  } catch (error) {
    console.error("[plan] dispatchWebhooks failed:", error, { taskId: args.taskId, kind: args.kind });
  }
}

/**
 * Stream-level notifications. `task_events.task_id` is NOT NULL, so a stream
 * create/update/attach has nowhere to be recorded as history — it only goes
 * out as a webhook. Stream renames and moves DO touch cards, so those write
 * one `stream_renamed` / `stream_moved` row per affected card via recordEvent.
 */
export async function dispatchStreamEvent(
  orgId: number,
  kind: string,
  actor: Actor,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await dispatchWebhooks(orgId, {
      kind: `stream.${kind}`,
      actor: { userId: actor.userId, label: actor.label, isAgent: actor.isAgent },
      payload: { ...payload, via: actor.via },
    });
  } catch (error) {
    console.error("[plan] dispatchWebhooks failed:", error, { kind });
  }
}

export async function listEventsForTask(taskId: number, orgId: number, limit = 50): Promise<TaskEvent[]> {
  const rows = await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    // id DESC tie-breaks events sharing a created_at: a chain of writes inside
    // one request can collide at millisecond precision.
    .orderBy(desc(taskEvents.createdAt), desc(taskEvents.id))
    .limit(limit);
  // Belt and braces: events are task-scoped via FK, but never hand a row from
  // another org to a caller even if a task somehow moved between orgs.
  return rows.filter((r) => r.orgId === orgId) as TaskEvent[];
}

/** Fields whose changes are worth a history row. Ported from the original board's diffTask + PTD's new columns. */
const DIFF_FIELDS = [
  "title",
  "description",
  "status",
  "streamId",
  "appId",
  "externalKey",
  "estimatedDuration",
  "startDate",
  "dueDate",
  "assignedTo",
  "completed",
  "dependencies",
  "urgency",
  "impact",
  "effort",
  "priorityScore",
  "prioritySource",
  "priorityNote",
  "tags",
] as const;

/** Per-field {old,new} diff between two task snapshots. Null when nothing moved. */
export function diffTask(before: Partial<Task>, after: Partial<Task>): Changes | null {
  const out: Changes = {};
  for (const field of DIFF_FIELDS) {
    const a = normalize((before as Record<string, unknown>)[field]);
    const b = normalize((after as Record<string, unknown>)[field]);
    if (!equal(a, b)) out[field] = { old: a, new: b };
  }
  return Object.keys(out).length === 0 ? null : out;
}

function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.slice().sort();
  return v ?? null;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  return false;
}

export function summariseChanges(changes: Changes | null): string {
  if (!changes) return "no field changes";
  const keys = Object.keys(changes);
  if (keys.length === 1) return `${keys[0]} changed`;
  if (keys.length <= 3) return `${keys.join(", ")} changed`;
  return `${keys.length} fields changed`;
}
