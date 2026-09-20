/**
 * Hard budgets.
 *
 * `streams.agent_budget_usd` has always been a number the dashboard drew a bar
 * against. `streams.budget_mode` makes it load-bearing: in `enforce` mode, once
 * a lane's month-to-date agent spend reaches its ceiling, `next_task` stops
 * offering that lane's work to agents. Humans are never blocked — a budget is
 * about what the machines are allowed to spend, not about stopping the team.
 *
 * Two decisions worth stating:
 *
 *  1. **Spend prefers the verified figure.** Where an entry has been attested,
 *     `verified_cost_usd` is what counts against the budget; otherwise the
 *     agent's own `api_cost_usd` does. An agent cannot buy itself more runway
 *     by under-reporting, because the attestation overrides the claim.
 *  2. **Month to date, in the server's local month.** The same window the
 *     Overview budget bar has always used, so the bar and the block agree.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db";
import { streams, timeEntries } from "../../db/schema";
import { dispatchWebhooks } from "../webhooks";
import { num } from "./cost";

export type BudgetMode = "alert" | "enforce";
export const BUDGET_MODES: readonly BudgetMode[] = ["alert", "enforce"] as const;

export interface StreamBudget {
  streamId: number;
  name: string;
  mode: BudgetMode;
  budgetUsd: number | null;
  spentUsd: number;
  spentTokens: number;
  /** null when the lane has no ceiling — you cannot have what was never bounded. */
  remainingUsd: number | null;
  burnPct: number | null;
  overBudget: boolean;
  /** The lane is in enforce mode AND has a ceiling. */
  enforced: boolean;
  /** Enforced and exhausted: agents are refused work here. */
  blocked: boolean;
  periodStart: string;
}

export interface SpendRow {
  streamId: number | null;
  cost: unknown;
  tokens: unknown;
}

const usd = (value: number): number => Math.round(value * 10_000) / 10_000;

export function monthStart(at: Date = new Date()): Date {
  return new Date(at.getFullYear(), at.getMonth(), 1, 0, 0, 0, 0);
}

/** Pure: one stream row plus its month-to-date spend becomes the budget verdict. */
export function evaluateBudget(
  stream: { id: number; name: string; agentBudgetUsd: number | null; budgetMode: string | null },
  spend: { costUsd: number; tokens: number },
  periodStart: Date,
): StreamBudget {
  const mode: BudgetMode = stream.budgetMode === "enforce" ? "enforce" : "alert";
  const budgetUsd = typeof stream.agentBudgetUsd === "number" && stream.agentBudgetUsd > 0 ? stream.agentBudgetUsd : null;
  const spentUsd = usd(Math.max(0, spend.costUsd));
  const exhausted = budgetUsd !== null && spentUsd >= budgetUsd;
  return {
    streamId: stream.id,
    name: stream.name,
    mode,
    budgetUsd,
    spentUsd,
    spentTokens: Math.round(Math.max(0, spend.tokens)),
    remainingUsd: budgetUsd === null ? null : usd(Math.max(0, budgetUsd - spentUsd)),
    burnPct: budgetUsd === null ? null : Math.round((spentUsd / budgetUsd) * 1000) / 10,
    overBudget: exhausted,
    enforced: mode === "enforce" && budgetUsd !== null,
    blocked: mode === "enforce" && exhausted,
    periodStart: periodStart.toISOString(),
  };
}

/**
 * Month-to-date agent spend per stream.
 *
 * Nano 4.40 SQL only: plain aggregates, CASE WHEN, no FILTER, and the GROUP BY
 * is a bare column.
 */
export async function monthToDateSpend(orgId: number, from: Date): Promise<Map<number | null, { costUsd: number; tokens: number }>> {
  const rows = (await db
    .select({
      streamId: timeEntries.streamId,
      cost: sql<string>`sum(case when ${timeEntries.verifiedCostUsd} is not null then ${timeEntries.verifiedCostUsd} when ${timeEntries.apiCostUsd} is not null then ${timeEntries.apiCostUsd} else 0 end)`,
      tokens: sql<string>`sum(case when ${timeEntries.verifiedTokens} is not null then ${timeEntries.verifiedTokens} when ${timeEntries.tokensUsed} is not null then ${timeEntries.tokensUsed} else 0 end)`,
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.orgId, orgId),
        eq(timeEntries.entrySource, "agent"),
        eq(timeEntries.isBreak, false),
        gte(timeEntries.checkIn, from),
      ),
    )
    .groupBy(timeEntries.streamId)) as unknown as SpendRow[];

  const out = new Map<number | null, { costUsd: number; tokens: number }>();
  for (const row of rows) out.set(row.streamId, { costUsd: num(row.cost), tokens: num(row.tokens) });
  return out;
}

/** Every live lane's budget verdict, newest month. */
export async function streamBudgets(orgId: number, at: Date = new Date()): Promise<StreamBudget[]> {
  const from = monthStart(at);
  const [lanes, spend] = await Promise.all([
    db
      .select({ id: streams.id, name: streams.name, agentBudgetUsd: streams.agentBudgetUsd, budgetMode: streams.budgetMode, archived: streams.archived })
      .from(streams)
      .where(eq(streams.orgId, orgId))
      .orderBy(streams.position, streams.id),
    monthToDateSpend(orgId, from),
  ]);
  return lanes
    .filter((lane) => !lane.archived)
    .map((lane) => evaluateBudget(lane, spend.get(lane.id) ?? { costUsd: 0, tokens: 0 }, from));
}

export async function streamBudget(orgId: number, streamId: number, at: Date = new Date()): Promise<StreamBudget | null> {
  const budgets = await streamBudgets(orgId, at);
  return budgets.find((b) => b.streamId === streamId) ?? null;
}

/** Lane ids an agent may not be offered work in right now. */
export async function blockedStreamIds(orgId: number, at: Date = new Date()): Promise<number[]> {
  const budgets = await streamBudgets(orgId, at);
  const blocked = budgets.filter((b) => b.blocked);
  void announceExhausted(orgId, blocked, at);
  return blocked.map((b) => b.streamId);
}

/* ── budget.exhausted, once per stream per day ───────────────────────── */

/**
 * In-memory throttle. A restart re-announces, and two replicas announce twice —
 * both acceptable for a notification, and neither is worth a table: the ledger
 * already records the spend that triggered it.
 */
const announced = new Map<string, string>();

export function exhaustionKey(orgId: number, streamId: number): string {
  return `${orgId}:${streamId}`;
}

/** Test seam — clears the throttle. */
export function resetExhaustionThrottle(): void {
  announced.clear();
}

export function shouldAnnounce(orgId: number, streamId: number, at: Date = new Date()): boolean {
  const day = at.toISOString().slice(0, 10);
  const key = exhaustionKey(orgId, streamId);
  if (announced.get(key) === day) return false;
  announced.set(key, day);
  return true;
}

/** Fire-and-forget `budget.exhausted`, at most once per stream per day. */
export async function announceExhausted(orgId: number, budgets: StreamBudget[], at: Date = new Date()): Promise<void> {
  for (const budget of budgets) {
    if (!budget.blocked) continue;
    if (!shouldAnnounce(orgId, budget.streamId, at)) continue;
    void dispatchWebhooks(orgId, {
      kind: "budget.exhausted",
      actor: { userId: null, label: "system", isAgent: false },
      payload: {
        streamId: budget.streamId,
        streamName: budget.name,
        budgetUsd: budget.budgetUsd,
        spentUsd: budget.spentUsd,
        mode: budget.mode,
        periodStart: budget.periodStart,
        note: "Agent work in this stream is now refused by next_task until the budget is raised or the month rolls over.",
      },
    }).catch(() => {});
  }
}
