import { z } from "zod";
import { TASK_STATUSES } from "../../db/schema";

/**
 * The pure half of the backlog query: status vocabulary, the priority bands and
 * the argument schema. Kept free of any database import so the action schema, the
 * REST route and the tests can all read it without opening a connection.
 */

/** Statuses that count as "still on the board". Mirrors Sprinter's open/triaged/in_progress. */
export const OPEN_STATUSES = ["backlog", "triaged", "in-progress"] as const;
/** Statuses `next_task` will hand out — never something already being worked on. */
export const CLAIMABLE_STATUSES = ["backlog", "triaged"] as const;
/** Hidden unless asked for, the way Sprinter hides `rejected`. */
export const CLOSED_STATUSES = ["completed", "wontfix"] as const;

export const SORTS = ["priority", "due", "updated", "title"] as const;
export type Sort = (typeof SORTS)[number];

export const taskQueryInput = z.object({
  search: z.string().max(200).optional().describe("Case-insensitive substring of the title or description."),
  streamId: z.union([z.number().int().positive(), z.literal("none"), z.null()]).optional()
    .describe('Stream id, or null / "none" for tasks filed against no stream.'),
  appId: z.union([z.number().int().positive(), z.literal("none"), z.null()]).optional()
    .describe('App id, or null / "none" for tasks filed against no app — which is where cards land when a stream is detached from an app.'),
  status: z.array(z.enum(TASK_STATUSES)).optional().describe("Explicit status whitelist; overrides includeCompleted."),
  assignedTo: z.union([z.number().int().positive(), z.literal("me"), z.literal("none"), z.null()]).optional()
    .describe('User id, "me" for the caller, or null / "none" for unassigned tasks.'),
  priorityMin: z.number().int().min(0).max(100).optional().describe("Lowest priorityScore to include (0-100)."),
  priorityMax: z.number().int().min(0).max(100).optional().describe("Highest priorityScore to include (0-100)."),
  effortMax: z.number().int().min(0).max(10).optional().describe("Only tasks costing at most this much effort (0-10)."),
  tags: z.array(z.string().max(60)).max(20).optional().describe("Match tasks carrying ANY of these tags."),
  includeCompleted: z.boolean().optional().describe("Include completed and wontfix tasks (default false)."),
  sort: z.enum(SORTS).optional().describe("priority (default), due, updated or title."),
  order: z.enum(["asc", "desc"]).optional().describe("Sort direction; defaults to desc for priority/updated, asc for due/title."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size, max 200 (default 25)."),
  offset: z.number().int().min(0).optional().describe("Rows to skip (default 0)."),
});

export type TaskQueryInput = z.infer<typeof taskQueryInput>;

export type Scope = "none";
export const NONE: Scope = "none";

/** Collapse the two accepted spellings of "filed against nothing" into one. */
export function normaliseScope<T>(value: T | Scope | null | undefined): T | Scope | undefined {
  if (value === null) return NONE;
  return value ?? undefined;
}


export function band(score: number): "critical" | "high" | "medium" | "low" {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}
