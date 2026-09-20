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
  /** Custom field values, keyed by field key. Always present from `task.list`/`task.get`; `{}` when the org defines no fields. */
  custom?: CustomValues;
}

/** Custom field values on a card, keyed by field key — `custom` on the wire. */
export type CustomValues = Record<string, unknown>;

export type CustomFieldKind = "text" | "number" | "date" | "select" | "multiselect" | "checkbox" | "url";

/** A custom field definition as `field.list` returns it. */
export interface CustomFieldDef {
  id: number;
  name: string;
  key: string;
  kind: CustomFieldKind | string;
  options: string[];
  position: number;
  archived: boolean;
  createdAt: string | null;
}

/** One comment as `task.comment_list` returns it. Bodies are markdown-lite source, never HTML. */
export interface TaskComment {
  id: number;
  taskId: number;
  body: string;
  via: string;
  author: { userId: number | null; displayName: string | null; isAgent: boolean };
  createdAt: string | null;
  updatedAt: string | null;
}

/** One attachment as `task.attachment_list` returns it. `url` is the authenticated download route. */
export interface TaskAttachment {
  id: number;
  taskId: number;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  /** True when the browser may render it in place rather than downloading it. */
  inline: boolean;
  uploadedBy: { userId: number | null; displayName: string | null; isAgent: boolean };
  createdAt: string | null;
  url: string;
}

/** One recurrence as `task.recur_list` returns it. `preview` is the server's human reading of `rule`. */
export interface TaskRecurrence {
  id: number;
  templateTaskId: number;
  templateTitle: string | null;
  templateKey: string | null;
  rule: string;
  preview: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  active: boolean;
  createdBy: number | null;
  createdAt: string | null;
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
