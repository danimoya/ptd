import type { TaskStatus } from "../../../../db/schema";

export interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  streamId: number | null;
  streamName: string | null;
  streamColor: string | null;
  appId: number | null;
  appKey: string | null;
  appName: string | null;
  assignedTo: number | null;
  assigneeName: string | null;
  assigneeIsAgent: boolean | null;
  startDate: string | null;
  dueDate: string | null;
  estimatedDuration: number | null;
  dependencies: number[];
  externalKey: string | null;
  urgency: number;
  impact: number;
  effort: number;
  priorityScore: number;
  prioritySource: string;
  priorityNote: string | null;
  tags: string[];
  completed: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPage {
  items: TaskRow[];
  total: number;
  limit: number;
  offset: number;
  sort: TaskSort;
  order: "asc" | "desc";
}

export type TaskSort = "priority" | "due" | "updated" | "title";

export interface TaskFilters {
  search?: string;
  streamId?: number | "none";
  appId?: number | "none";
  status?: TaskStatus[];
  assignedTo?: number | "me" | "none";
  priorityMin?: number;
  priorityMax?: number;
  effortMax?: number;
  tags?: string[];
  includeCompleted?: boolean;
  sort?: TaskSort;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface AppRow {
  id: number;
  orgId: number;
  key: string;
  name: string;
  urls: string[];
  repo: string | null;
  stack: string[];
  archived: boolean;
  createdAt: string;
  openTasks: number;
  critical: number;
  maxPriority: number;
  streamCount: number;
  streams: { id: number; name: string; color: string | null }[];
}

export interface AgentCost { minutes: number; tokens: number; costUsd: number; entries: number }

export interface AgentActivityRow {
  id: number;
  taskId: number | null;
  taskTitle: string | null;
  kind: string;
  note: string | null;
  via: string;
  actorUserId: number | null;
  actorLabel: string | null;
  createdAt: string;
}

export interface OrgStats {
  tasks: { open: number; triaged: number; inProgress: number; completed: number; wontfix: number; total: number };
  byPriorityBand: { critical: number; high: number; medium: number; low: number };
  overdue: number;
  apps: number;
  streams: number;
  members: { humans: number; agents: number };
  agentCost: AgentCost & { last7d: AgentCost };
  agentActivity: AgentActivityRow[];
}

export interface SystemicStream {
  streamId: number;
  name: string;
  color: string | null;
  agentBudgetUsd: number | null;
  appCount: number;
  apps: { appId: number; key: string; name: string; archived: boolean }[];
  open: number;
  critical: number;
  maxPriority: number;
}

export interface NextTaskResult {
  task: TaskRow | null;
  why: {
    priorityScore: number;
    urgency: number;
    impact: number;
    effort: number;
    source: string;
    note: string | null;
    formula: string;
    band: Band;
    explanation: string;
  } | null;
}

/** Shape of the Track surface's `stream.totals`; buckets live under `bySource`. */
export interface StreamTotals {
  streamId: number | null;
  name: string;
  color?: string | null;
  archived?: boolean;
  agentBudgetUsd: number | null;
  minutes: number;
  bySource: { human: { minutes: number }; agent: { minutes: number; tokens: number; costUsd: number } };
  overBudget: boolean;
}

export interface StreamOption { id: number; name: string; color?: string | null; archived?: boolean }

export type Band = "critical" | "high" | "medium" | "low";

/* ───────────────────────── AI-assisted priority ───────────────────────── */

/** `ai.status` — the whole feature hangs off `configured`. */
export interface AiStatus {
  configured: boolean;
  provider: "anthropic" | "openai" | null;
  model: string | null;
}

export interface AiUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** false when the server's price table did not know the model — costUsd is 0, not an estimate. */
  priced: boolean;
  attempts: number;
  durationMs: number;
}

export interface PriorityCalibration {
  openTasks: number;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  top: { id: number; title: string; priorityScore: number }[];
}

/** One card's proposal, as `task.suggest_priority` returns it. */
export interface PrioritySuggestionResult {
  taskId: number;
  title: string;
  current: { urgency: number; impact: number; effort: number; priorityScore: number; prioritySource: string; band: Band };
  suggestion: {
    urgency: number;
    impact: number;
    effort: number;
    priorityScore: number;
    band: Band;
    rationale: string;
    confidence: number;
  };
  delta: { urgency: number; impact: number; effort: number; priorityScore: number };
  applied: boolean;
  /** "manual" = the card's score was set by hand and was left alone. */
  skipped: "manual" | null;
  usage: AiUsage;
  /** The card as it now stands, only when `applied`. */
  task: (Omit<TaskRow, "streamName" | "streamColor" | "appKey" | "appName" | "assigneeName" | "assigneeIsAgent"> & { end: string | null }) | null;
  calibration: PriorityCalibration;
}

export interface AiBatchResult {
  considered: number;
  scored: number;
  applied: number;
  failed: number;
  skipped: { taskId: number; title: string; reason: "manual" }[];
  results: PrioritySuggestionResult[];
  failures: { taskId: number; title: string; error: string }[];
  totals: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  apply: boolean;
  concurrency: number;
}
