import { callAction } from "@/lib/api";

/**
 * The client's view of `hybrid.summary`.
 *
 * These interfaces mirror `server/overview/hybrid.ts` field for field. They are
 * restated rather than imported because the server module pulls in drizzle and
 * the db pool; the price of restating them is that a change on the server has to
 * be made here too, which is the same trade every other feature in this client
 * makes.
 */

export type HybridGroupBy = "day" | "week";

export interface HumanBucket {
  minutes: number;
}

export interface AgentBucket {
  minutes: number;
  tokens: number;
  costUsd: number;
}

export interface HybridBucket {
  key: string;
  label: string;
  from: string;
  to: string;
  minutes: number;
  sessions: number;
  human: HumanBucket;
  agent: AgentBucket;
  agentSharePct: number;
}

export interface StreamHybrid {
  streamId: number | null;
  name: string;
  minutes: number;
  sessions: number;
  human: HumanBucket;
  agent: AgentBucket;
  agentSharePct: number;
  agentBudgetUsd: number | null;
  burnPct: number | null;
  overBudget: boolean;
  remainingUsd: number | null;
  archived: boolean;
}

export interface AppHybrid {
  appId: number | null;
  key: string | null;
  name: string;
  minutes: number;
  sessions: number;
  human: HumanBucket;
  agent: AgentBucket;
  agentSharePct: number;
}

export interface AgentHybrid {
  userId: number;
  displayName: string;
  minutes: number;
  tokens: number;
  costUsd: number;
  sessions: number;
  tasksCompleted: number;
}

export interface TaskCostStat {
  agentMinutes: number;
  tokens: number;
  costUsd: number;
}

export interface PerCompletedTask {
  count: number;
  withAgent: number;
  median: TaskCostStat;
  withAgentMedian: TaskCostStat;
  mean: TaskCostStat;
  total: TaskCostStat;
}

export interface HybridTotals {
  minutes: number;
  sessions: number;
  human: HumanBucket;
  agent: AgentBucket;
  agentSharePct: number;
  tasksCompleted: number;
  budgetUsd: number;
  overBudgetStreams: number;
  agentSeats: number;
}

export interface HybridRange {
  from: string;
  to: string;
  groupBy: HybridGroupBy;
  days: number;
  buckets: number;
}

export interface HybridSummary {
  range: HybridRange;
  series: HybridBucket[];
  byStream: StreamHybrid[];
  byApp: AppHybrid[];
  topAgents: AgentHybrid[];
  perCompletedTask: PerCompletedTask;
  totals: HybridTotals;
  narrative: string;
  truncated: boolean;
}

export interface HybridQuery {
  from?: string;
  to?: string;
  groupBy?: HybridGroupBy;
}

/** One call for the whole tab — the action is a single read behind the scenes. */
export const fetchHybrid = (q: HybridQuery) => callAction<HybridSummary>("hybrid.summary", q as Record<string, unknown>);
