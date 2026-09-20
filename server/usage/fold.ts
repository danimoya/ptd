/**
 * Reported versus verified — the arithmetic, with no database in sight.
 *
 * An agent's `tokens_used` / `api_cost_usd` are self-reported; the verified
 * columns are what a second party — a Claude Code hook reading the transcript, a
 * CI runner, or a provider's own usage report — swore to afterwards. This module
 * folds the two into one shape per agent and per stream so the launch question
 * ("why would an agent report its own cost honestly?") has an arithmetic answer
 * rather than a promise.
 *
 * Kept pure and db-free, the way `server/track/aggregate.ts` is: the fold is the
 * part worth unit-testing, and `./summary.ts` is the one query that feeds it.
 */

import { num } from "./cost";

/** A window wider than this is an export, not a summary. */
export const MAX_SUMMARY_ROWS = 20_000;

/** Tolerance before a gap between reported and verified is called a discrepancy. */
export const TOLERANCE_PCT = 5;
export const TOLERANCE_TOKENS = 1_000;

export interface UsageEntryRow {
  entryId: number;
  userId: number;
  displayName: string | null;
  agentLabel: string | null;
  streamId: number | null;
  streamName: string | null;
  taskId: number | null;
  checkIn: Date | string;
  tokensUsed: unknown;
  apiCostUsd: unknown;
  verifiedTokens: unknown;
  verifiedCostUsd: unknown;
  verifiedSource: string | null;
  verifiedAt: Date | string | null;
}

export interface Pair {
  tokens: number;
  costUsd: number;
}

export interface UsageBucket {
  entries: number;
  verifiedEntries: number;
  /** Verified entries as a percentage of this bucket's agent entries. */
  coveragePct: number;
  reported: Pair;
  verified: Pair;
  /** verified − reported, over the verified entries only. A positive number means the agent under-reported. */
  delta: Pair;
  /** Reported figures on entries nobody has attested. */
  unverified: Pair;
  discrepancies: number;
  sources: Record<string, number>;
}

export interface AgentUsage extends UsageBucket {
  userId: number;
  name: string;
}

export interface StreamUsage extends UsageBucket {
  streamId: number | null;
  name: string;
}

export interface Discrepancy {
  entryId: number;
  userId: number;
  name: string;
  streamId: number | null;
  streamName: string | null;
  taskId: number | null;
  checkIn: string;
  verifiedSource: string | null;
  reportedTokens: number;
  verifiedTokens: number;
  deltaTokens: number;
  deltaPct: number;
  reportedCostUsd: number;
  verifiedCostUsd: number;
  deltaCostUsd: number;
  direction: "under_reported" | "over_reported";
}

export interface UsageSummary {
  range: { from: string; to: string };
  totals: UsageBucket;
  byAgent: AgentUsage[];
  byStream: StreamUsage[];
  discrepancies: Discrepancy[];
  tolerance: { pct: number; tokens: number };
  narrative: string;
}

const usd = (value: number): number => Math.round(value * 10_000) / 10_000;
const pct = (part: number, whole: number): number => (whole <= 0 ? 0 : Math.round((part / whole) * 1000) / 10);

function emptyBucket(): UsageBucket {
  return {
    entries: 0,
    verifiedEntries: 0,
    coveragePct: 0,
    reported: { tokens: 0, costUsd: 0 },
    verified: { tokens: 0, costUsd: 0 },
    delta: { tokens: 0, costUsd: 0 },
    unverified: { tokens: 0, costUsd: 0 },
    discrepancies: 0,
    sources: {},
  };
}

function iso(value: Date | string | null): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Is the gap between what was claimed and what was proven worth naming? */
export function isDiscrepancy(reportedTokens: number, verifiedTokens: number, tolerancePct = TOLERANCE_PCT, toleranceTokens = TOLERANCE_TOKENS): boolean {
  const delta = Math.abs(verifiedTokens - reportedTokens);
  if (delta === 0) return false;
  const allowance = Math.max(toleranceTokens, (verifiedTokens * tolerancePct) / 100);
  return delta > allowance;
}

function fold(bucket: UsageBucket, row: UsageEntryRow, flagged: boolean): void {
  const reportedTokens = num(row.tokensUsed);
  const reportedCost = num(row.apiCostUsd);
  const attested = row.verifiedSource !== null && row.verifiedSource !== undefined;

  bucket.entries += 1;
  bucket.reported.tokens += reportedTokens;
  bucket.reported.costUsd += reportedCost;

  if (!attested) {
    bucket.unverified.tokens += reportedTokens;
    bucket.unverified.costUsd += reportedCost;
    return;
  }

  const verifiedTokens = num(row.verifiedTokens);
  const verifiedCost = num(row.verifiedCostUsd);
  bucket.verifiedEntries += 1;
  bucket.verified.tokens += verifiedTokens;
  bucket.verified.costUsd += verifiedCost;
  bucket.delta.tokens += verifiedTokens - reportedTokens;
  bucket.delta.costUsd += verifiedCost - reportedCost;
  bucket.sources[row.verifiedSource as string] = (bucket.sources[row.verifiedSource as string] ?? 0) + 1;
  if (flagged) bucket.discrepancies += 1;
}

function seal(bucket: UsageBucket): UsageBucket {
  bucket.coveragePct = pct(bucket.verifiedEntries, bucket.entries);
  bucket.reported.costUsd = usd(bucket.reported.costUsd);
  bucket.verified.costUsd = usd(bucket.verified.costUsd);
  bucket.delta.costUsd = usd(bucket.delta.costUsd);
  bucket.unverified.costUsd = usd(bucket.unverified.costUsd);
  return bucket;
}

/**
 * The whole summary, folded out of one row set. Pure: no database, no clock.
 */
export function foldUsage(
  rows: UsageEntryRow[],
  range: { from: Date; to: Date },
  tolerance: { pct: number; tokens: number } = { pct: TOLERANCE_PCT, tokens: TOLERANCE_TOKENS },
): UsageSummary {
  const totals = emptyBucket();
  const agents = new Map<number, AgentUsage>();
  const lanes = new Map<number | null, StreamUsage>();
  const discrepancies: Discrepancy[] = [];

  for (const row of rows) {
    const reportedTokens = num(row.tokensUsed);
    const verifiedTokens = num(row.verifiedTokens);
    const attested = row.verifiedSource !== null && row.verifiedSource !== undefined;
    const flagged = attested && isDiscrepancy(reportedTokens, verifiedTokens, tolerance.pct, tolerance.tokens);

    const name = row.agentLabel ?? row.displayName ?? `user ${row.userId}`;
    let agent = agents.get(row.userId);
    if (!agent) {
      agent = { userId: row.userId, name, ...emptyBucket() };
      agents.set(row.userId, agent);
    }
    let lane = lanes.get(row.streamId);
    if (!lane) {
      lane = { streamId: row.streamId, name: row.streamName ?? "(no stream)", ...emptyBucket() };
      lanes.set(row.streamId, lane);
    }

    fold(totals, row, flagged);
    fold(agent, row, flagged);
    fold(lane, row, flagged);

    if (flagged) {
      const reportedCost = num(row.apiCostUsd);
      const verifiedCost = num(row.verifiedCostUsd);
      discrepancies.push({
        entryId: row.entryId,
        userId: row.userId,
        name,
        streamId: row.streamId,
        streamName: row.streamName,
        taskId: row.taskId,
        checkIn: iso(row.checkIn),
        verifiedSource: row.verifiedSource,
        reportedTokens,
        verifiedTokens,
        deltaTokens: verifiedTokens - reportedTokens,
        deltaPct: pct(verifiedTokens - reportedTokens, Math.max(verifiedTokens, 1)),
        reportedCostUsd: usd(reportedCost),
        verifiedCostUsd: usd(verifiedCost),
        deltaCostUsd: usd(verifiedCost - reportedCost),
        direction: verifiedTokens > reportedTokens ? "under_reported" : "over_reported",
      });
    }
  }

  const byAgent = Array.from(agents.values()).map((a) => seal(a) as AgentUsage).sort((a, b) => b.verified.costUsd + b.unverified.costUsd - (a.verified.costUsd + a.unverified.costUsd));
  const byStream = Array.from(lanes.values()).map((s) => seal(s) as StreamUsage).sort((a, b) => b.verified.costUsd + b.unverified.costUsd - (a.verified.costUsd + a.unverified.costUsd));
  seal(totals);
  discrepancies.sort((a, b) => Math.abs(b.deltaTokens) - Math.abs(a.deltaTokens));

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    totals,
    byAgent,
    byStream,
    discrepancies: discrepancies.slice(0, 100),
    tolerance,
    narrative: narrate(totals, discrepancies.length),
  };
}

/** One computed sentence. Arithmetic, not a model — it cannot contradict the figures above it. */
export function narrate(totals: UsageBucket, discrepancyCount: number): string {
  if (totals.entries === 0) return "No agent sessions in this window, so there is nothing to verify.";
  const head = `${totals.verifiedEntries} of ${totals.entries} agent session${totals.entries === 1 ? "" : "s"} carry independent usage evidence (${totals.coveragePct}% coverage).`;
  if (totals.verifiedEntries === 0) {
    return `${head} Every token figure on this page is the agents' own word — install the Claude Code hook pack or run \`ptd agent-run\` to change that.`;
  }
  const dir = totals.delta.tokens === 0 ? "matches" : totals.delta.tokens > 0 ? "is above" : "is below";
  const gap = `Across the attested sessions the verified total ${dir} what was reported by ${Math.abs(totals.delta.tokens).toLocaleString("en-GB")} tokens ($${Math.abs(totals.delta.costUsd).toFixed(2)}).`;
  const flags = discrepancyCount === 0
    ? "No session is outside tolerance."
    : `${discrepancyCount} session${discrepancyCount === 1 ? " is" : "s are"} outside tolerance and listed below.`;
  const rest = totals.entries - totals.verifiedEntries;
  const tail = rest === 0 ? "" : ` ${rest} session${rest === 1 ? "" : "s"} remain unverified, worth $${totals.unverified.costUsd.toFixed(2)} of self-reported spend.`;
  return `${head} ${gap} ${flags}${tail}`;
}

