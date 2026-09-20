import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../db";
import { tasks } from "../../../db/schema";
import type { OutboundEvent } from "../../webhooks";
import { escape, int, rec, taskLabel, taskish } from "../shared/format";
import { replyToTelegramHtml } from "../shared/markup";
import { ephemeral } from "../shared/format";
import { sendMessage } from "./api";
import { isTelegramConfigured } from "./config";
import { telegramChatFor } from "./identity";
import { getTelegramForOrg } from "./store";

/**
 * Outbound Telegram DMs.
 *
 * Called from the same fan-out the webhooks and the Slack adapter use. Telegram has no
 * channels PTD could pick, only conversations with people, so the two events worth a
 * DM are the two that are *about* one person: being given a card, and having your
 * dates moved by someone else's edit.
 *
 * Nothing in here throws and nothing is awaited by the caller — a Telegram outage must
 * never fail a task mutation. Every failure is a console warning and nothing else.
 */

const RELEVANT = new Set(["task.assigned", "task.cascade_shifted"]);
/** A cascade fires one event per shifted card; coalesce the burst into one DM each. */
const CASCADE_WINDOW_MS = 1_500;

interface CascadeBatch {
  timer: NodeJS.Timeout;
  taskIds: Set<number>;
  rootIds: Set<number>;
}

const cascadeBatches = new Map<number, CascadeBatch>();

/** Test helper: forget every pending cascade batch. */
export function resetTelegramNotifyState(): void {
  for (const batch of cascadeBatches.values()) clearTimeout(batch.timer);
  cascadeBatches.clear();
}

function warn(message: string, detail?: unknown): void {
  console.warn(`[telegram] ${message}`, detail instanceof Error ? detail.message : detail ?? "");
}

/** The org's Telegram row, or null when this organization has not turned the bot on. */
async function activeOrg(orgId: number): Promise<boolean> {
  if (!isTelegramConfigured()) return false;
  const row = await getTelegramForOrg(orgId);
  return !!row && row.enabled;
}

async function dm(userId: number, lines: string[], context?: string[]): Promise<boolean> {
  const chatId = await telegramChatFor(userId);
  if (!chatId) return false;
  const html = replyToTelegramHtml(ephemeral(lines, context));
  const result = await sendMessage({ chatId, html });
  if (!result.ok) warn(`sendMessage to ${chatId} failed: ${String(result.error)}`);
  return result.ok;
}

/** The assignee after the change: the serialized task is authoritative, the diff is the fallback. */
function assigneeIdFrom(event: OutboundEvent): number | null {
  const payload = rec(event.payload);
  const fromTask = int(rec(payload.task).assignedTo);
  if (fromTask !== null) return fromTask;
  const changes = rec(payload.changes);
  return int(rec(changes.assignedTo).new);
}

function actorLabel(event: OutboundEvent): string {
  const label = event.actor?.label;
  return label ? escape(label) : "someone";
}

export async function notifyTelegram(orgId: number, event: OutboundEvent): Promise<void> {
  try {
    if (!RELEVANT.has(event.kind)) return;
    if (!(await activeOrg(orgId))) return;
    if (event.kind === "task.assigned") await notifyAssigned(orgId, event);
    else bufferCascade(orgId, event);
  } catch (err) {
    warn(`notify for ${event.kind} skipped:`, err);
  }
}

async function notifyAssigned(orgId: number, event: OutboundEvent): Promise<void> {
  const assigneeId = assigneeIdFrom(event);
  if (assigneeId === null) return;
  // Assigning something to yourself does not need a notification about it.
  if (event.actor?.userId === assigneeId) return;

  const payload = rec(event.payload);
  const task = taskish(payload.task);
  if (task.id === null && event.taskId) task.id = event.taskId;
  const key = task.externalKey ?? (task.id !== null ? String(task.id) : "");
  const facts = [
    task.priorityScore !== null ? `score ${task.priorityScore}` : "",
    task.dueDate ? `due ${task.dueDate.slice(0, 10)}` : "",
    task.streamName ? escape(task.streamName) : "",
  ].filter(Boolean);

  await dm(
    assigneeId,
    [`*${actorLabel(event)} assigned you* ${taskLabel(task)}${facts.length > 0 ? `\n${facts.join(" · ")}` : ""}`],
    key ? [`start it with \`/start ${escape(key)}\``] : [],
  );
}

function bufferCascade(orgId: number, event: OutboundEvent): void {
  const existing = cascadeBatches.get(orgId);
  const batch: CascadeBatch = existing ?? {
    taskIds: new Set<number>(),
    rootIds: new Set<number>(),
    timer: setTimeout(() => void flushCascade(orgId), CASCADE_WINDOW_MS),
  };
  if (event.taskId) batch.taskIds.add(event.taskId);
  const rootId = int(rec(event.payload).rootId);
  if (rootId !== null) batch.rootIds.add(rootId);
  batch.timer.refresh?.();
  cascadeBatches.set(orgId, batch);
}

/**
 * One DM per affected assignee, listing only their own cards.
 *
 * A `cascade_shifted` event carries the root and the ids, not the cards, so the dates
 * and the owners are read back here — org-scoped, and only for the ids the cascade
 * actually touched.
 */
export async function flushCascade(orgId: number): Promise<void> {
  const batch = cascadeBatches.get(orgId);
  cascadeBatches.delete(orgId);
  if (!batch || batch.taskIds.size === 0) return;
  try {
    if (!(await activeOrg(orgId))) return;
    const ids = Array.from(batch.taskIds);
    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        externalKey: tasks.externalKey,
        assignedTo: tasks.assignedTo,
        startDate: tasks.startDate,
        dueDate: tasks.dueDate,
      })
      .from(tasks)
      .where(and(eq(tasks.orgId, orgId), inArray(tasks.id, ids)));

    const byAssignee = new Map<number, typeof rows>();
    for (const row of rows) {
      if (row.assignedTo === null) continue;
      const list = byAssignee.get(row.assignedTo) ?? [];
      list.push(row);
      byAssignee.set(row.assignedTo, list);
    }

    const roots = Array.from(batch.rootIds)
      .map((id) => `#${id}`)
      .join(", ");
    for (const [userId, own] of byAssignee) {
      const lines = [`:calendar: *${own.length} of your task${own.length === 1 ? "" : "s"} shifted*${roots ? ` after an edit on ${roots}` : ""}`];
      for (const row of own.slice(0, 8)) {
        const key = row.externalKey ?? `#${row.id}`;
        const start = row.startDate ? row.startDate.toISOString().slice(0, 10) : "—";
        lines.push(`• \`${escape(key)}\` ${escape(row.title)} → ${start}`);
      }
      await dm(userId, lines, own.length > 8 ? [`${own.length - 8} more in PTD`] : ["`/today` for the rest of your day"]);
    }
  } catch (err) {
    warn("cascade notification skipped:", err);
  }
}
