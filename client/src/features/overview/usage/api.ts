import { callAction } from "@/lib/api";

/**
 * The verified-usage reads for Overview → Agents.
 *
 * Both actions are the same ones an agent or an MCP client would call, so what
 * this page shows is what the API says — there is no dashboard-only figure here.
 */

export interface Pair {
  tokens: number;
  costUsd: number;
}

export interface UsageBucket {
  entries: number;
  verifiedEntries: number;
  coveragePct: number;
  reported: Pair;
  verified: Pair;
  /** verified − reported over the attested entries. Positive means under-reporting. */
  delta: Pair;
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

export type BudgetMode = "alert" | "enforce";

export interface StreamBudget {
  streamId: number;
  name: string;
  mode: BudgetMode;
  budgetUsd: number | null;
  spentUsd: number;
  spentTokens: number;
  remainingUsd: number | null;
  burnPct: number | null;
  overBudget: boolean;
  enforced: boolean;
  blocked: boolean;
  periodStart: string;
}

export interface BudgetReport {
  streams: StreamBudget[];
  blocked: number[];
  totals: { streams: number; budgeted: number; enforced: number; spentUsd: number; budgetUsd: number };
}

export const fetchUsageSummary = (range: { from?: string; to?: string } = {}) => callAction<UsageSummary>("usage.summary", range);

export const fetchBudgets = () => callAction<BudgetReport>("budget.check", {});

export const setStreamBudget = (input: { streamId: number; agentBudgetUsd?: number | null; budgetMode?: BudgetMode }) =>
  callAction<{ stream: StreamBudget | null }>("stream.set_budget", input);

/** Human-readable attester names — the enum is an API value, not a label. */
export const SOURCE_LABEL: Record<string, string> = {
  claude_code_hook: "Claude Code hook",
  ci: "CI",
  provider: "provider",
};

export const sourceLabel = (source: string | null | undefined): string => (source ? SOURCE_LABEL[source] ?? source : "—");

/** "+141,700" / "−800" / "0" — a delta reads wrong without its sign. */
export function formatTokenDelta(value: number): string {
  if (value === 0) return "0";
  const body = Math.abs(value).toLocaleString("en-GB");
  return value > 0 ? `+${body}` : `−${body}`;
}
