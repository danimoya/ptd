/**
 * In-memory usage ledger: the last 500 provider calls this process made.
 *
 * Deliberately not a table. Adding one would mean a migration on a schema four
 * other surfaces are writing to, and the question it answers ("did the batch I
 * just ran cost me anything silly?") is a this-process question. It resets on
 * restart and is per-process, which `ai.usage` says out loud.
 */
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

const ring: AiCallRecord[] = [];

export function recordCall(call: AiCallRecord): void {
  ring.push(call);
  if (ring.length > USAGE_RING_SIZE) ring.splice(0, ring.length - USAGE_RING_SIZE);
}

/** Oldest first, newest last. A copy — callers must not mutate the ledger. */
export function recentCalls(): AiCallRecord[] {
  return ring.slice();
}

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
