import type { OutboundEvent } from "../../webhooks";
import { runAction, type ActionContext } from "../../actions/registry";
import { slackUserIdFor } from "./identity";
import { botTokenOf, getSlackForOrg, type SlackRow } from "./store";
import { postMessage, type SlackApiResult } from "./web";
import { arr, contextLine, escape, int, rec, section, str, stripMrkdwn, taskLabel, taskish } from "./format";

/**
 * Outbound Slack messages.
 *
 * Called from the same fan-out the webhooks use, so a Slack workspace sees the
 * task events its organization already publishes: the assignee gets a DM, the org
 * channel gets completions and cascade shifts, and a stream that has burned through
 * its agent budget gets an alert.
 *
 * Nothing in here throws and nothing is awaited by the caller — a Slack outage must
 * never fail a task mutation. Every failure is a console warning and nothing else.
 */

const CASCADE_WINDOW_MS = 1_500;
const BUDGET_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const BUDGET_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface CascadeBatch {
  timer: NodeJS.Timeout;
  taskIds: Set<number>;
  rootIds: Set<number>;
}

const cascadeBatches = new Map<number, CascadeBatch>();
/**
 * `<orgId>:<streamId>` → when that stream was last alerted, and when it was last
 * swept. Both are per replica, deliberately: they throttle a courtesy message, and
 * the worst a second replica can do is post the same "budget exceeded" line once
 * more within the 12-hour window. Making them durable would mean a write on every
 * event fan-out to spare Slack a duplicate — see docs/self-hosting.md, "Running
 * more than one app replica".
 */
const budgetAlertedAt = new Map<string, number>();
const lastBudgetSweep = new Map<number, number>();

/** Test helper: forget every timer and throttle. */
export function resetSlackNotifyState(): void {
  for (const batch of cascadeBatches.values()) clearTimeout(batch.timer);
  cascadeBatches.clear();
  budgetAlertedAt.clear();
  lastBudgetSweep.clear();
}

function warn(message: string, detail?: unknown): void {
  console.warn(`[slack] ${message}`, detail instanceof Error ? detail.message : detail ?? "");
}

/** The org's Slack row, or null when the org has no (enabled) install. */
async function activeInstall(orgId: number): Promise<SlackRow | null> {
  const row = await getSlackForOrg(orgId);
  if (!row || !row.enabled) return null;
  return row;
}

export interface Outbound {
  text: string;
  blocks?: unknown[];
}

function message(body: string, context?: string): Outbound {
  const blocks: unknown[] = [section(body)];
  if (context) blocks.push(contextLine(context));
  return { text: stripMrkdwn(body), blocks };
}

async function postTo(row: SlackRow, channel: string, outbound: Outbound): Promise<SlackApiResult> {
  const result = await postMessage(botTokenOf(row.config), { channel, text: outbound.text, blocks: outbound.blocks });
  if (!result.ok) warn(`chat.postMessage to ${channel} failed: ${String(result.error)}`);
  return result;
}

/** The channel an admin chose with `slack.set_channel`; nothing is posted without one. */
async function postToOrgChannel(row: SlackRow, outbound: Outbound): Promise<SlackApiResult> {
  const channel = row.config.channelId;
  if (!channel) return { ok: false, error: "no_channel_configured" };
  return postTo(row, channel, outbound);
}

/* ── event fan-out ────────────────────────────────────────────────────── */

/**
 * One event from the Plan surface. Wired into `dispatchWebhooks`, so anything that
 * writes a task event reaches Slack too.
 */
export async function notifySlack(orgId: number, event: OutboundEvent): Promise<void> {
  try {
    if (!RELEVANT.has(event.kind)) {
      void sweepBudgets(orgId);
      return;
    }
    const row = await activeInstall(orgId);
    if (!row) return;

    if (event.kind === "task.assigned") await notifyAssigned(row, event);
    else if (event.kind === "task.completed") await notifyCompleted(row, event);
    else if (event.kind === "task.cascade_shifted") bufferCascade(row.orgId, event);

    void sweepBudgets(orgId);
  } catch (err) {
    warn(`notify for ${event.kind} skipped:`, err);
  }
}

const RELEVANT = new Set(["task.assigned", "task.completed", "task.cascade_shifted"]);

function actorLabel(event: OutboundEvent): string {
  const label = event.actor?.label;
  return label ? escape(label) : "someone";
}

function taskFrom(event: OutboundEvent) {
  const payload = rec(event.payload);
  const task = taskish(payload.task);
  if (task.id === null && event.taskId) task.id = event.taskId;
  return task;
}

/** The assignee after the change: the serialized task is authoritative, the diff is the fallback. */
function assigneeIdFrom(event: OutboundEvent): number | null {
  const payload = rec(event.payload);
  const fromTask = int(rec(payload.task).assignedTo);
  if (fromTask !== null) return fromTask;
  const changes = rec(payload.changes);
  return int(rec(changes.assignedTo).new);
}

async function notifyAssigned(row: SlackRow, event: OutboundEvent): Promise<void> {
  const assigneeId = assigneeIdFrom(event);
  if (assigneeId === null) return;
  // Assigning something to yourself does not need a notification about it.
  if (event.actor?.userId === assigneeId) return;
  const slackUserId = await slackUserIdFor(assigneeId, row.config.teamId);
  if (!slackUserId) return;

  const task = taskFrom(event);
  const key = task.externalKey ?? (task.id !== null ? String(task.id) : "");
  const facts = [task.priorityScore !== null ? `score ${task.priorityScore}` : "", task.dueDate ? `due ${task.dueDate.slice(0, 10)}` : "", task.streamName ? escape(task.streamName) : ""].filter(Boolean);
  await postTo(row, slackUserId, message(
    `*${actorLabel(event)} assigned you* ${taskLabel(task)}${facts.length > 0 ? `\n${facts.join(" · ")}` : ""}`,
    key ? `start it with \`/ptd start ${escape(key)}\`` : undefined,
  ));
}

async function notifyCompleted(row: SlackRow, event: OutboundEvent): Promise<void> {
  const task = taskFrom(event);
  const note = str(rec(event.payload).note);
  await postToOrgChannel(row, message(
    `:white_check_mark: *${actorLabel(event)} completed* ${taskLabel(task)}`,
    note ? escape(note) : undefined,
  ));
}

/**
 * A cascade shifts every dependent of the card that moved, one event each. Posting
 * one message per shifted card would be noise, so they are coalesced into a single
 * line per burst.
 */
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

async function flushCascade(orgId: number): Promise<void> {
  const batch = cascadeBatches.get(orgId);
  cascadeBatches.delete(orgId);
  if (!batch || batch.taskIds.size === 0) return;
  try {
    const row = await activeInstall(orgId);
    if (!row) return;
    const roots = Array.from(batch.rootIds).map((id) => `#${id}`).join(", ");
    const count = batch.taskIds.size;
    await postToOrgChannel(row, message(
      `:calendar: *${count} task${count === 1 ? "" : "s"} shifted* by the cascade${roots ? ` after an edit on ${roots}` : ""}`,
      Array.from(batch.taskIds).slice(0, 12).map((id) => `#${id}`).join(" "),
    ));
  } catch (err) {
    warn("cascade notification skipped:", err);
  }
}

/* ── budget alerts ────────────────────────────────────────────────────── */

/**
 * A server-side read on the organization's own aggregates. `stream.totals` is the
 * action that defines `overBudget`, so the alert asks it rather than re-deriving the
 * arithmetic; this context is never built from a request and only ever reads.
 */
function systemContext(orgId: number): ActionContext {
  return {
    userId: 0,
    email: "system@ptd.local",
    displayName: "PTD",
    orgId,
    role: "admin",
    authType: "human",
    via: "slack",
  };
}

export interface BudgetSweep {
  checked: number;
  overBudget: number;
  posted: number;
  skipped: string[];
}

/** Throttled sweep, triggered opportunistically by any task event. */
async function sweepBudgets(orgId: number): Promise<void> {
  const now = Date.now();
  const previous = lastBudgetSweep.get(orgId) ?? 0;
  if (now - previous < BUDGET_SWEEP_INTERVAL_MS) return;
  lastBudgetSweep.set(orgId, now);
  try {
    await checkStreamBudgets(orgId);
  } catch (err) {
    warn("budget sweep skipped:", err);
  }
}

/**
 * Post one alert per stream whose agent spend has passed its budget. Each stream is
 * alerted at most once every 12 hours unless `force` is set (what `slack.check_budgets`
 * and the Org UI's test button use) — per app replica, see the cooldown map above.
 */
export async function checkStreamBudgets(orgId: number, opts: { force?: boolean; now?: number } = {}): Promise<BudgetSweep> {
  const now = opts.now ?? Date.now();
  const sweep: BudgetSweep = { checked: 0, overBudget: 0, posted: 0, skipped: [] };
  const row = await activeInstall(orgId);
  if (!row) {
    sweep.skipped.push("not_connected");
    return sweep;
  }
  if (!row.config.channelId) {
    sweep.skipped.push("no_channel_configured");
    return sweep;
  }

  const totals = arr(await runAction("stream.totals", {}, systemContext(orgId)));
  sweep.checked = totals.length;
  for (const raw of totals) {
    const stream = rec(raw);
    if (stream.overBudget !== true) continue;
    sweep.overBudget += 1;
    const streamId = int(stream.streamId);
    const key = `${orgId}:${streamId ?? "none"}`;
    const alertedAt = budgetAlertedAt.get(key) ?? 0;
    if (!opts.force && now - alertedAt < BUDGET_COOLDOWN_MS) {
      sweep.skipped.push(`cooldown:${key}`);
      continue;
    }
    const spent = int(rec(rec(stream.bySource).agent).costUsd) ?? 0;
    const budget = int(stream.agentBudgetUsd) ?? 0;
    const result = await postToOrgChannel(row, message(
      `:rotating_light: *Agent budget exceeded* — stream *${escape(str(stream.name) ?? "(unnamed)")}*`,
      `$${spent.toFixed(2)} spent against a $${budget.toFixed(2)} budget`,
    ));
    if (result.ok) {
      budgetAlertedAt.set(key, now);
      sweep.posted += 1;
    } else {
      sweep.skipped.push(`post_failed:${key}`);
    }
  }
  return sweep;
}

/* ── admin-facing helpers ─────────────────────────────────────────────── */

export interface ConnectionTest {
  posted: boolean;
  channel: string | null;
  error: string | null;
}

/** `slack.test` — the round trip an admin needs to believe the channel works. */
export async function testSlackConnection(orgId: number, actorName: string): Promise<ConnectionTest> {
  const row = await activeInstall(orgId);
  if (!row) return { posted: false, channel: null, error: "not_connected" };
  const channel = row.config.channelId;
  if (!channel) return { posted: false, channel: null, error: "no_channel_configured" };
  const result = await postTo(row, channel, message(
    "*PTD connected* :handshake:",
    `test message sent by ${escape(actorName)} — task assignments, completions, cascade shifts and agent-budget alerts will land here`,
  ));
  return { posted: result.ok === true, channel, error: result.ok ? null : String(result.error ?? "unknown_error") };
}
