/**
 * The vocabulary every importer shares.
 *
 * An import is three stages, and this file names the values that travel between
 * them so that the preview a user approves is provably the same computation the
 * commit performs:
 *
 *   csv text ──parseCsv──▶ columns + string rows
 *            ──mapper────▶ NormalisedTask / NormalisedEntry  (source-agnostic)
 *            ──apply─────▶ Drizzle writes
 *
 * `mapping` is always `column name → PTD field`, never the reverse, because the
 * UI renders one row per column of the user's file and because several columns
 * may legitimately feed one field (Jira emits a `Labels` column per label).
 */

import type { TaskStatus } from "../../db/schema";

/* ── Sources ─────────────────────────────────────────────────────────── */

export const TASK_SOURCES = ["jira", "trello", "asana", "linear", "notion", "generic"] as const;
export const TIME_SOURCES = ["toggl", "clockify", "harvest"] as const;
export const SOURCES = [...TASK_SOURCES, ...TIME_SOURCES] as const;

export type TaskSource = (typeof TASK_SOURCES)[number];
export type TimeSource = (typeof TIME_SOURCES)[number];
export type Source = (typeof SOURCES)[number];
export type SourceArg = Source | "auto";

export type ImportKind = "task" | "time";

export function isTaskSource(s: Source): s is TaskSource {
  return (TASK_SOURCES as readonly string[]).includes(s);
}

/* ── PTD fields a column can be mapped onto ──────────────────────────── */

/**
 * Task fields. `stream` and `assigneeEmail` are names/emails, not ids: the
 * importer resolves them against the org (creating streams, never users).
 */
export const TASK_FIELDS = [
  "title",
  "description",
  "status",
  "externalKey",
  "stream",
  "startDate",
  "dueDate",
  "estimate",
  "tags",
  "assigneeEmail",
  "priority",
  "urgency",
  "impact",
  "effort",
  "createdAt",
] as const;
export type TaskField = (typeof TASK_FIELDS)[number];

export const TIME_FIELDS = [
  "userEmail",
  "userName",
  "customer",
  "stream",
  "taskRef",
  "notes",
  "date",
  "startDate",
  "startTime",
  "endDate",
  "endTime",
  "duration",
  "hours",
] as const;
export type TimeField = (typeof TIME_FIELDS)[number];

/** Ignored columns are mapped to this, so "unmapped" and "deliberately skipped" differ. */
export const IGNORE = "-" as const;

export const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  description: "Description",
  status: "Status",
  externalKey: "External key",
  stream: "Stream (project)",
  startDate: "Start date",
  dueDate: "Due date",
  estimate: "Estimate",
  tags: "Tags",
  assigneeEmail: "Assignee e-mail",
  priority: "Priority",
  urgency: "Urgency (0–10)",
  impact: "Impact (0–10)",
  effort: "Effort (0–10)",
  createdAt: "Created at",
  userEmail: "Member e-mail",
  userName: "Member name",
  customer: "Customer (client)",
  taskRef: "Task reference",
  notes: "Notes",
  date: "Date",
  startTime: "Start time",
  endDate: "End date",
  endTime: "End time",
  duration: "Duration (hh:mm:ss)",
  hours: "Hours (decimal)",
  [IGNORE]: "— ignore —",
};

/* ── Normalised rows ─────────────────────────────────────────────────── */

export interface NormalisedTask {
  title: string;
  description: string | null;
  status: TaskStatus;
  externalKey: string;
  /** Whether externalKey came from the file or was synthesised from a hash. */
  keySynthesised: boolean;
  streamName: string | null;
  startDate: Date | null;
  dueDate: Date | null;
  /** Working days. */
  estimatedDuration: number | null;
  tags: string[];
  assigneeEmail: string | null;
  urgency: number;
  impact: number;
  effort: number;
}

export interface NormalisedEntry {
  userEmail: string | null;
  userName: string | null;
  customerName: string | null;
  streamName: string | null;
  notes: string | null;
  /** `[KEY]` prefix or the bare text we will try to match to a task title. */
  taskRef: string | null;
  checkIn: Date;
  checkOut: Date;
}

/** One row's outcome from a mapper: a value, or a reason it cannot be imported. */
export interface RowResult<T> {
  /** 1-based index within the data records, so it lines up with a spreadsheet. */
  index: number;
  value: T | null;
  skip: string | null;
  warnings: string[];
}

/* ── Mapper contract ─────────────────────────────────────────────────── */

export interface Signature {
  /** Distinctive headers, worth 3 points each in detection. */
  strong: string[];
  /** Supporting headers, worth 1 point each. */
  weak?: string[];
  /** Headers that rule this source out entirely when present. */
  absent?: string[];
}

export interface BaseMapper<T> {
  source: Source;
  kind: ImportKind;
  label: string;
  /** One sentence for the UI: where this file comes from. */
  hint: string;
  signature: Signature;
  /** Default `column → field` mapping for a concrete header row. */
  mapping(columns: string[]): Record<string, string>;
  normalise(row: Record<string, string>, mapping: Record<string, string>, index: number): RowResult<T>;
  /** Header + two example records for GET /api/import/template/<source>.csv. */
  template(): unknown[][];
}

export type TaskMapper = BaseMapper<NormalisedTask> & { kind: "task" };
export type TimeMapper = BaseMapper<NormalisedEntry> & { kind: "time" };
export type AnyMapper = TaskMapper | TimeMapper;
