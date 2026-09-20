import type { TaskStatus } from "../../../../db/schema";

/** Wire shape of a task as `serializeTask` on the server emits it. */
export interface PlanTask {
  id: number;
  orgId: number;
  title: string;
  description: string | null;
  status: TaskStatus | string;
  streamId: number | null;
  appId: number | null;
  assignedTo: number | null;
  startDate: string | null;
  dueDate: string | null;
  estimatedDuration: number | null;
  dependencies: number[];
  externalKey: string | null;
  urgency: number;
  impact: number;
  effort: number;
  priorityScore: number;
  prioritySource: "formula" | "manual" | "ai" | string;
  priorityNote: string | null;
  tags: string[];
  completed: boolean;
  createdBy: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** startDate + duration, or dueDate when that is later. */
  end: string | null;
  /** dueDate − (startDate + duration) in days; null when either is missing. */
  slackDays: number | null;
}

export interface PlanStream {
  id: number;
  name: string;
  color: string | null;
  customerId: number | null;
  archived: boolean;
  position: number;
  agentBudgetUsd: number | null;
  apps: { id: number; key: string; name: string }[];
  taskCount: number;
  openCount: number;
  completedCount: number;
  scheduledCount: number;
}

export interface StreamListResponse {
  streams: PlanStream[];
  unstreamed: { taskCount: number; openCount: number };
  totalTasks: number;
}

/**
 * An app as the Overview surface's `app.list` action returns it, plus
 * `streamIds` flattened out of `streams` — the card editor only ever asks
 * "is this app on that stream?", and the answer has to be cheap.
 */
export interface PlanApp {
  id: number;
  key: string;
  name: string;
  repo: string | null;
  archived: boolean;
  streams: { id: number; name: string; color: string | null }[];
  streamIds: number[];
  openTasks?: number;
  critical?: number;
  maxPriority?: number;
}

export interface TaskHistoryEvent {
  id: number;
  taskId: number;
  orgId: number;
  actorUserId: number | null;
  actorLabel: string | null;
  kind: string;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  note: string | null;
  via: string;
  createdAt: string;
}

/** Shape returned by the Track surface's `task.totals` action. */
export interface TaskTotals {
  taskId: number;
  minutes: number;
  bySource: {
    human: { minutes: number };
    agent: { minutes: number; tokens?: number | null; costUsd?: number | null };
  };
}

export type ViewMode = "board" | "timeline" | "cascade";
export type GroupBy = "stream" | "assignee";
export type CascadeOrder = "priority_score" | "due_date" | "start_date" | "float";
export type CascadeGroup = "stream" | "app" | "assignee" | "source";
/** Cascade mode draws the same graph two ways; the choice is remembered. */
export type CascadeRender = "tree" | "graph";

/** One row of `critical_path`'s CPM schedule, as the wire carries it. */
export interface CriticalPathEntry {
  taskId: number;
  earliestStart: string | null;
  earliestFinish: string | null;
  latestStart: string | null;
  latestFinish: string | null;
  /** Slack in days: latestStart − earliestStart. Zero means critical. */
  floatDays: number;
  onCriticalPath: boolean;
}

export interface CriticalPathResponse {
  /** Longest chain by estimated duration — the action's original reading. */
  totalDays: number;
  taskCount: number;
  tasks: PlanTask[];
  /** The forward/backward pass. Absent on a server older than the CPM change. */
  perTask?: CriticalPathEntry[];
  projectStart?: string | null;
  projectFinish?: string | null;
  spanDays?: number;
}
