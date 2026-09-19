/**
 * One row → one NormalisedTask, for every task source.
 *
 * The six task mappers differ only in which header carries which field, which
 * words their status column uses, and how their estimate column is scaled. All
 * three are data, so the walk itself lives here once: mapping through the
 * shared `pick` helpers, parsing, clamping, warning. That is what makes the
 * preview trustworthy — a Trello row and a Jira row are put together by the
 * same code, so the only thing a mapper can get wrong is the dictionary.
 */

import type { TaskStatus } from "../../../db/schema";
import type { NormalisedTask, RowResult } from "../types";
import {
  clampDescription,
  clampScore,
  clampTitle,
  DEFAULT_PRIORITY,
  extractEmail,
  mapStatus,
  ok,
  parseDay,
  parseNumber,
  pick,
  pickAll,
  skip,
  splitList,
  synthKey,
  type Priority,
} from "./shared";

export interface TaskRowOptions {
  source: string;
  /** Source-specific status words, layered over the shared vocabulary. */
  statuses?: Record<string, TaskStatus>;
  /** PTD status to assume when the row has no status column at all. */
  fallbackStatus?: TaskStatus;
  /** Turn the source's priority cell into urgency/impact/effort. */
  priority?: (raw: string) => Priority | null;
  /** Turn the source's estimate cell into whole days. */
  estimateDays?: (raw: string) => number | null;
  /**
   * Last word on a row after the generic walk: completion flags, archived
   * columns, board-specific quirks. May mutate `task` and push warnings.
   */
  refine?: (task: NormalisedTask, row: Record<string, string>, mapping: Record<string, string>, warnings: string[]) => void;
  /** Compute the external key when no mapped column yields one. */
  fallbackKey?: (row: Record<string, string>, mapping: Record<string, string>) => string | null;
}

export function buildTask(
  row: Record<string, string>,
  mapping: Record<string, string>,
  index: number,
  options: TaskRowOptions
): RowResult<NormalisedTask> {
  const warnings: string[] = [];
  const title = clampTitle(pick(row, mapping, "title"));
  if (!title) return skip(index, "no title");

  const statusRaw = pick(row, mapping, "status");
  const mapped = mapStatus(statusRaw, options.statuses ?? {}, options.fallbackStatus ?? "backlog");
  if (!mapped.matched) {
    warnings.push(`status "${statusRaw}" is not a status PTD knows — filed as ${mapped.status}`);
  }

  let externalKey = pick(row, mapping, "externalKey");
  let keySynthesised = false;
  if (!externalKey && options.fallbackKey) externalKey = options.fallbackKey(row, mapping) ?? "";
  if (!externalKey) {
    externalKey = synthKey(options.source, title, pick(row, mapping, "createdAt"));
    keySynthesised = true;
  }
  externalKey = externalKey.slice(0, 128);

  const startDate = parseDay(pick(row, mapping, "startDate"));
  const dueDate = parseDay(pick(row, mapping, "dueDate"));
  if (startDate && dueDate && dueDate < startDate) {
    warnings.push("due date is before the start date — both kept as given");
  }

  const estimateRaw = pick(row, mapping, "estimate");
  let estimatedDuration: number | null = null;
  if (estimateRaw) {
    estimatedDuration = (options.estimateDays ?? defaultEstimateDays)(estimateRaw);
    if (estimatedDuration === null) warnings.push(`estimate "${estimateRaw}" is not a number — ignored`);
  }

  const priority = readPriority(row, mapping, options, warnings);
  const assigneeEmail = readAssignee(row, mapping, warnings);

  const task: NormalisedTask = {
    title,
    description: clampDescription(pick(row, mapping, "description")),
    status: mapped.status,
    externalKey,
    keySynthesised,
    streamName: pick(row, mapping, "stream").split(/[,;]/)[0]?.trim() || null,
    startDate,
    dueDate,
    estimatedDuration,
    tags: splitList(pickAll(row, mapping, "tags")).slice(0, 25).map((t) => t.slice(0, 60)),
    assigneeEmail,
    ...priority,
  };

  options.refine?.(task, row, mapping, warnings);

  // A completed card with no dates would otherwise be invisible on the timeline;
  // that is a Plan-surface decision, not ours, so we only note dates we dropped.
  return ok(index, task, warnings);
}

function defaultEstimateDays(raw: string): number | null {
  const n = parseNumber(raw);
  return n === null || n <= 0 ? null : Math.max(1, Math.ceil(n));
}

function readPriority(
  row: Record<string, string>,
  mapping: Record<string, string>,
  options: TaskRowOptions,
  warnings: string[]
): Priority {
  // Explicit urgency/impact/effort columns (generic CSV, PTD's own template)
  // win over a source priority word, because they say exactly what they mean.
  const direct: Partial<Priority> = {};
  for (const field of ["urgency", "impact", "effort"] as const) {
    const raw = pick(row, mapping, field);
    if (!raw) continue;
    const n = parseNumber(raw);
    if (n === null) warnings.push(`${field} "${raw}" is not a number — default 5 used`);
    else direct[field] = clampScore(n);
  }
  if (Object.keys(direct).length > 0) return { ...DEFAULT_PRIORITY, ...direct };

  const raw = pick(row, mapping, "priority");
  if (!raw) return { ...DEFAULT_PRIORITY };
  const parsed = options.priority?.(raw);
  if (parsed) return parsed;
  warnings.push(`priority "${raw}" is not on this source's scale — urgency 5 used`);
  return { ...DEFAULT_PRIORITY };
}

function readAssignee(row: Record<string, string>, mapping: Record<string, string>, warnings: string[]): string | null {
  for (const raw of pickAll(row, mapping, "assigneeEmail")) {
    const email = extractEmail(raw);
    if (email) return email;
  }
  const any = pick(row, mapping, "assigneeEmail");
  if (any) warnings.push(`assignee "${any}" is not an e-mail address — the card is left unassigned`);
  return null;
}
