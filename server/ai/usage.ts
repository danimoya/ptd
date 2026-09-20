/**
 * The AI usage ledger: one `ai_usage` row per provider call, plus a small
 * in-process mirror of the last 500 calls.
 *
 * The row is what `ai.usage` reports and what survives a restart — and what makes
 * the answer the same on every app replica. The ring buffer stays because it is
 * free, needs no query, and answers the narrower "what did the batch I just ran
 * cost *here*" question; `ai.usage` returns it alongside the durable totals under
 * `thisProcess`.
 *
 * The provider layer does not know which organization is paying — it is handed a
 * prompt, not a context — so the action wraps its work in `withUsageScope` and this
 * module reads the scope back out when the call completes. No scope (a unit test, a
 * script) means no row: the ledger is per organization or it is nothing.
 */
import { AsyncLocalStorage } from "async_hooks";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { aiUsage, users } from "../../db/schema";
import type { AiProviderName } from "./pricing";

export const USAGE_RING_SIZE = 500;

export interface AiCallRecord {
  at: string;
  provider: AiProviderName;
  model: string;
  /** What asked for it: "task.suggest_priority", "task.suggest_priority_batch". */
  label: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** false when the price table has no entry for the model. */
  priced: boolean;
  /** HTTP round-trips spent, including retries for invalid JSON. */
  attempts: number;
  durationMs: number;
  ok: boolean;
}

/* ── who is paying ───────────────────────────────────────────────────────── */

export interface UsageScope {
  orgId: number;
  userId: number | null;
}

const scope = new AsyncLocalStorage<UsageScope>();

/** Run `fn` with the organization every provider call inside it is billed to. */
export function withUsageScope<T>(usage: UsageScope, fn: () => Promise<T>): Promise<T> {
  return scope.run(usage, fn);
}

export function currentUsageScope(): UsageScope | undefined {
  return scope.getStore();
}

/* ── the in-process mirror ───────────────────────────────────────────────── */

const ring: AiCallRecord[] = [];

/** Imported lazily so the provider tests need no DATABASE_URL. */
async function database() {
  return (await import("../../db")).db;
}

async function persist(call: AiCallRecord, usage: UsageScope): Promise<void> {
  const db = await database();
  await db.insert(aiUsage).values({
    orgId: usage.orgId,
    userId: usage.userId,
    provider: call.provider,
    model: call.model.slice(0, 80),
    action: call.label.slice(0, 64),
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    costUsd: call.costUsd,
    createdAt: new Date(call.at),
  });
}

/**
 * Record one provider call.
 *
 * Synchronous on purpose: this is called from the provider's `finish()`, on the path
 * that returns a suggestion to a user, and a ledger write must never make that path
 * slower or fail it. The row is written in the background and a failure is a warning.
 */
export function recordCall(call: AiCallRecord): void {
  ring.push(call);
  if (ring.length > USAGE_RING_SIZE) ring.splice(0, ring.length - USAGE_RING_SIZE);

  const usage = scope.getStore();
  if (!usage) return;
  void persist(call, usage).catch((err) =>
    console.warn("[ai] usage row not written:", err instanceof Error ? err.message : err),
  );
}

/** Oldest first, newest last. A copy — callers must not mutate the ledger. */
export function recentCalls(): AiCallRecord[] {
  return ring.slice();
}

/** Forgets the in-process mirror. The `ai_usage` rows are not touched. */
export function resetUsage(): void {
  ring.length = 0;
}

export interface UsageBucket {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageTotals extends UsageBucket {
  /** How many records the ring can hold before it starts dropping the oldest. */
  windowSize: number;
  /** True once the ring is full, i.e. the totals are a floor, not the whole story. */
  truncated: boolean;
  failures: number;
  /** Any call whose model the price table did not know — costUsd under-reports. */
  unpriced: number;
  firstAt: string | null;
  lastAt: string | null;
  byModel: (UsageBucket & { provider: AiProviderName; model: string })[];
  byLabel: (UsageBucket & { label: string })[];
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function emptyBucket(): UsageBucket {
  return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function add(bucket: UsageBucket, call: AiCallRecord): void {
  bucket.calls += 1;
  bucket.inputTokens += call.inputTokens;
  bucket.outputTokens += call.outputTokens;
  bucket.costUsd = round(bucket.costUsd + call.costUsd);
}

export function usageTotals(): UsageTotals {
  const byModel = new Map<string, UsageBucket & { provider: AiProviderName; model: string }>();
  const byLabel = new Map<string, UsageBucket & { label: string }>();
  const all = emptyBucket();
  let failures = 0;
  let unpriced = 0;

  for (const call of ring) {
    add(all, call);
    if (!call.ok) failures += 1;
    if (!call.priced) unpriced += 1;

    const modelKey = `${call.provider}:${call.model}`;
    let m = byModel.get(modelKey);
    if (!m) {
      m = { ...emptyBucket(), provider: call.provider, model: call.model };
      byModel.set(modelKey, m);
    }
    add(m, call);

    let l = byLabel.get(call.label);
    if (!l) {
      l = { ...emptyBucket(), label: call.label };
      byLabel.set(call.label, l);
    }
    add(l, call);
  }

  return {
    ...all,
    windowSize: USAGE_RING_SIZE,
    truncated: ring.length >= USAGE_RING_SIZE,
    failures,
    unpriced,
    firstAt: ring[0]?.at ?? null,
    lastAt: ring[ring.length - 1]?.at ?? null,
    byModel: Array.from(byModel.values()).sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
    byLabel: Array.from(byLabel.values()).sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
  };
}

/* ── the durable ledger ──────────────────────────────────────────────────── */

export const USAGE_DEFAULT_DAYS = 30;
export const USAGE_MAX_DAYS = 365;

export interface LedgerBucket extends UsageBucket {}

export interface OrgUsage extends UsageBucket {
  days: number;
  since: string;
  firstAt: string | null;
  lastAt: string | null;
  byDay: (LedgerBucket & { day: string })[];
  byUser: (LedgerBucket & { userId: number | null; displayName: string })[];
  byModel: (LedgerBucket & { provider: string; model: string })[];
  byAction: (LedgerBucket & { action: string })[];
}

/** SUM over integers comes back as a bigint string; SUM over `real` as a number. */
function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function dayOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

/**
 * Everything `ai.usage` reports, straight out of `ai_usage`: one grouped query per
 * breakdown, all of them bounded by the same window, so the four answers add up.
 */
export async function usageForOrg(orgId: number, opts: { days?: number; now?: Date } = {}): Promise<OrgUsage> {
  const db = await database();
  const days = Math.min(Math.max(Math.round(opts.days ?? USAGE_DEFAULT_DAYS), 1), USAGE_MAX_DAYS);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const window = and(eq(aiUsage.orgId, orgId), gte(aiUsage.createdAt, since));

  const totalFields = {
    calls: sql<string>`count(*)`,
    inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
    outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
    costUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)`,
  };
  const bucketOf = (row: { calls: unknown; inputTokens: unknown; outputTokens: unknown; costUsd: unknown }): LedgerBucket => ({
    calls: num(row.calls),
    inputTokens: num(row.inputTokens),
    outputTokens: num(row.outputTokens),
    costUsd: round(num(row.costUsd)),
  });

  const [[total], span, byDay, byUser, byModel, byAction] = await Promise.all([
    db.select(totalFields).from(aiUsage).where(window),
    db
      .select({ at: aiUsage.createdAt })
      .from(aiUsage)
      .where(window)
      .orderBy(desc(aiUsage.createdAt))
      .limit(1),
    db
      .select({ day: sql<Date>`date_trunc('day', ${aiUsage.createdAt})`, ...totalFields })
      .from(aiUsage)
      .where(window)
      .groupBy(sql`1`)
      .orderBy(sql`1 desc`),
    db
      .select({ userId: aiUsage.userId, displayName: users.displayName, ...totalFields })
      .from(aiUsage)
      .leftJoin(users, eq(users.id, aiUsage.userId))
      .where(window)
      .groupBy(aiUsage.userId, users.displayName),
    db
      .select({ provider: aiUsage.provider, model: aiUsage.model, ...totalFields })
      .from(aiUsage)
      .where(window)
      .groupBy(aiUsage.provider, aiUsage.model),
    db.select({ action: aiUsage.action, ...totalFields }).from(aiUsage).where(window).groupBy(aiUsage.action),
  ]);

  const firstRow = byDay.length > 0 ? byDay[byDay.length - 1] : null;
  const sortBucket = <T extends LedgerBucket>(rows: T[]): T[] =>
    rows.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  return {
    ...bucketOf(total ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    days,
    since: since.toISOString(),
    firstAt: firstRow ? dayOf(firstRow.day) : null,
    lastAt: span[0]?.at ? new Date(span[0].at).toISOString() : null,
    byDay: byDay.map((row) => ({ day: dayOf(row.day), ...bucketOf(row) })),
    byUser: sortBucket(
      byUser.map((row) => ({
        userId: row.userId ?? null,
        displayName: row.displayName ?? (row.userId ? `user ${row.userId}` : "(deleted user)"),
        ...bucketOf(row),
      })),
    ),
    byModel: sortBucket(byModel.map((row) => ({ provider: row.provider, model: row.model, ...bucketOf(row) }))),
    byAction: sortBucket(byAction.map((row) => ({ action: row.action, ...bucketOf(row) }))),
  };
}
