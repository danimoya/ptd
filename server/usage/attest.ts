/**
 * Attestation: a second party's word about what a session actually consumed.
 *
 * `time_entry.stop {tokensUsed, apiCostUsd}` is the agent talking about itself.
 * An attestation is written by something that can show its working — the Claude
 * Code Stop hook that summed the transcript, a CI job that read the runner's
 * usage file, or a reconciliation against the provider's own billing — and it
 * lands in separate columns so the claim and the evidence stay legible side by
 * side. Nothing here overwrites `tokens_used` or `api_cost_usd`: the point is
 * that both numbers survive.
 *
 * Rules:
 *  - Only an **agent-sourced** entry can be attested. Verified usage on a human
 *    session would mean nothing, and the ledger's human/agent split is the one
 *    invariant the product is built on.
 *  - A member may attest its own entries; manager and above may attest anyone's.
 *    That is the same gate `time_entry.update` uses.
 *  - Re-attesting is allowed and replaces the previous attestation — a hook that
 *    runs twice must be idempotent, not an error — and the task history keeps
 *    every attestation, so the overwrite is still visible.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { streams, tasks, timeEntries, users } from "../../db/schema";
import { ActionError, type ActionContext } from "../actions/registry";
import { actorFrom, recordEvent } from "../plan/taskEvents";
import { costForSplit, modelFromEvidence, num, splitFromEvidence, totalTokens, type TokenSplit } from "./cost";

export const ATTEST_SOURCES = ["claude_code_hook", "ci", "provider"] as const;
export type AttestSource = (typeof ATTEST_SOURCES)[number];

export interface AttestInput {
  entryId: number;
  tokens: number;
  costUsd?: number;
  source: AttestSource;
  evidence?: Record<string, unknown>;
}

export interface AttestedView {
  entryId: number;
  userId: number;
  userName: string | null;
  agentLabel: string | null;
  streamId: number | null;
  streamName: string | null;
  taskId: number | null;
  taskTitle: string | null;
  checkIn: Date | string;
  checkOut: Date | string | null;
  entrySource: string;
  tokensUsed: number | null;
  apiCostUsd: number | null;
  verifiedTokens: number | null;
  verifiedCostUsd: number | null;
  verifiedSource: string | null;
  verifiedAt: Date | string | null;
}

/** The entry columns an attestation writer and reader both want. Mirrors `entryView`, plus the verified four. */
const attestedView = {
  entryId: timeEntries.id,
  userId: timeEntries.userId,
  userName: users.displayName,
  agentLabel: timeEntries.agentLabel,
  streamId: timeEntries.streamId,
  streamName: streams.name,
  taskId: timeEntries.taskId,
  taskTitle: tasks.title,
  checkIn: timeEntries.checkIn,
  checkOut: timeEntries.checkOut,
  entrySource: timeEntries.entrySource,
  tokensUsed: timeEntries.tokensUsed,
  apiCostUsd: timeEntries.apiCostUsd,
  verifiedTokens: timeEntries.verifiedTokens,
  verifiedCostUsd: timeEntries.verifiedCostUsd,
  verifiedSource: timeEntries.verifiedSource,
  verifiedAt: timeEntries.verifiedAt,
} as const;

export async function readAttested(orgId: number, entryId: number): Promise<AttestedView | null> {
  const [row] = await db
    .select(attestedView)
    .from(timeEntries)
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .leftJoin(streams, eq(timeEntries.streamId, streams.id))
    .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
    .where(and(eq(timeEntries.orgId, orgId), eq(timeEntries.id, entryId)))
    .limit(1);
  return (row as AttestedView | undefined) ?? null;
}

export interface ResolvedCost {
  costUsd: number | null;
  /** Where the dollar figure came from, so the caller is never guessing. */
  basis: "given" | "priced" | "unpriced";
  model: string | null;
  split: TokenSplit | null;
  note?: string;
}

/**
 * The dollar figure to store.
 *
 * An explicit `costUsd` always wins — the attester may know a negotiated rate
 * PTD does not. Otherwise, if the evidence names a model, the cost is derived
 * from `server/ai/pricing.ts` (plus the cache multipliers in ./cost.ts). With
 * neither, the tokens are verified and the cost is left null rather than zeroed:
 * a stored 0 would read as "this session was free".
 */
export function resolveCost(input: Pick<AttestInput, "tokens" | "costUsd" | "evidence">): ResolvedCost {
  if (input.costUsd !== undefined && input.costUsd !== null) {
    return { costUsd: input.costUsd, basis: "given", model: modelFromEvidence(input.evidence), split: null };
  }
  const model = modelFromEvidence(input.evidence);
  if (!model) {
    return { costUsd: null, basis: "unpriced", model: null, split: null, note: "No costUsd and no model in evidence — tokens verified, cost left unset." };
  }
  const split = splitFromEvidence(input.tokens, input.evidence);
  const cost = costForSplit(model, split);
  if (!cost.priced) {
    return { costUsd: null, basis: "unpriced", model, split, note: `Model "${model}" is not in PTD's price table — tokens verified, cost left unset.` };
  }
  return { costUsd: cost.costUsd, basis: "priced", model, split };
}

export interface AttestResult {
  entry: AttestedView | null;
  verified: { tokens: number; costUsd: number | null; source: AttestSource; at: string };
  reported: { tokens: number; costUsd: number };
  delta: { tokens: number; costUsd: number | null };
  costBasis: ResolvedCost["basis"];
  model: string | null;
  reattested: boolean;
  note?: string;
}

/**
 * Write one attestation.
 *
 * `canReachOthers` is the manager check, passed in rather than re-derived so the
 * action stays the only place role arithmetic happens.
 */
export async function attest(ctx: ActionContext, input: AttestInput, canReachOthers: boolean): Promise<AttestResult> {
  const [row] = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.id, input.entryId), eq(timeEntries.orgId, ctx.orgId)))
    .limit(1);
  if (!row) throw new ActionError("not_found", `Time entry ${input.entryId} not found`);
  if (row.userId !== ctx.userId && !canReachOthers) {
    throw new ActionError("forbidden", "That entry belongs to another member; manager or above is required to attest it");
  }
  if (row.entrySource !== "agent") {
    throw new ActionError(
      "invalid",
      `Entry ${row.id} is human-sourced. Verified usage is recorded only for agent work — tokens and cost mean nothing on a human session.`,
    );
  }
  if (row.checkOut === null) {
    throw new ActionError("invalid", `Entry ${row.id} is still running. Stop it first — an open session has no final usage figure.`);
  }

  const resolved = resolveCost(input);
  const at = new Date();
  const reattested = row.verifiedSource !== null;

  await db
    .update(timeEntries)
    .set({
      verifiedTokens: Math.round(input.tokens),
      verifiedCostUsd: resolved.costUsd,
      verifiedSource: input.source,
      verifiedAt: at,
      updatedAt: at,
    })
    .where(eq(timeEntries.id, row.id));

  const reportedTokens = num(row.tokensUsed);
  const reportedCost = num(row.apiCostUsd);
  const verifiedTokens = Math.round(input.tokens);

  recordAttestation(ctx, {
    taskId: row.taskId,
    entryId: row.id,
    source: input.source,
    verifiedTokens,
    verifiedCostUsd: resolved.costUsd,
    reportedTokens,
    reportedCostUsd: reportedCost,
    model: resolved.model,
    evidence: input.evidence,
    reattested,
  });

  return {
    entry: await readAttested(ctx.orgId, row.id),
    verified: { tokens: verifiedTokens, costUsd: resolved.costUsd, source: input.source, at: at.toISOString() },
    reported: { tokens: reportedTokens, costUsd: Math.round(reportedCost * 10_000) / 10_000 },
    delta: {
      tokens: verifiedTokens - reportedTokens,
      costUsd: resolved.costUsd === null ? null : Math.round((resolved.costUsd - reportedCost) * 10_000) / 10_000,
    },
    costBasis: resolved.basis,
    model: resolved.model,
    reattested,
    ...(resolved.note ? { note: resolved.note } : {}),
  };
}

/**
 * History row + webhook, shaped like the `time_logged` line `time_entry.stop`
 * writes so the Edit-card History panel reads one continuous story: the session
 * was logged, then the session was attested.
 */
function recordAttestation(
  ctx: ActionContext,
  args: {
    taskId: number | null;
    entryId: number;
    source: AttestSource;
    verifiedTokens: number;
    verifiedCostUsd: number | null;
    reportedTokens: number;
    reportedCostUsd: number;
    model: string | null;
    evidence: Record<string, unknown> | undefined;
    reattested: boolean;
  },
): void {
  if (!args.taskId) return;
  const money = args.verifiedCostUsd === null ? "cost unpriced" : `$${args.verifiedCostUsd.toFixed(2)}`;
  const gap = args.verifiedTokens - args.reportedTokens;
  const against = args.reportedTokens === 0 && gap === 0 ? "" : ` · reported ${args.reportedTokens} tok (${gap >= 0 ? "+" : ""}${gap})`;
  void recordEvent({
    taskId: args.taskId,
    orgId: ctx.orgId,
    actor: actorFrom(ctx),
    kind: "time_logged",
    note: `usage attested (${args.source}): ${args.verifiedTokens} tok · ${money}${against}`,
    payload: {
      attestation: true,
      entryId: args.entryId,
      source: args.source,
      verifiedTokens: args.verifiedTokens,
      verifiedCostUsd: args.verifiedCostUsd,
      reportedTokens: args.reportedTokens,
      reportedCostUsd: args.reportedCostUsd,
      deltaTokens: gap,
      model: args.model,
      reattested: args.reattested,
      evidence: args.evidence ?? null,
    },
  });
}
