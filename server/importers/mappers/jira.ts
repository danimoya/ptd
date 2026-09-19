/**
 * Jira → PTD.
 *
 * Reads the classic "Export → CSV (all fields)" file. Three of its habits shape
 * this mapper:
 *
 *   - it repeats a column name once per value, so a card with three labels has
 *     three `Labels` columns — `assignAll` maps all of them onto `tags`;
 *   - `Original Estimate` is a count of SECONDS, while `Custom field (Story
 *     Points)` is a point count, so the two cannot share one scale;
 *   - `Assignee` is a display name, and the address (when the export includes
 *     one at all) sits in a separate column — so assignment falls back to
 *     unassigned rather than guessing a member from a name.
 */

import type { TaskStatus } from "../../../db/schema";
import type { NormalisedTask, RowResult, TaskMapper } from "../types";
import { assign, assignAll, baseName, ignoreRest, jiraPriority, norm, parseNumber, pointsToDays, secondsToDays } from "./shared";
import { buildTask } from "./taskRow";

/** Jira's default workflow plus the words teams rename those steps to. */
const STATUSES: Record<string, TaskStatus> = {
  todo: "triaged",
  inprogress: "in-progress",
  done: "completed",
  wontdo: "wontfix",
  cannotreproduce: "wontfix",
  duplicate: "wontfix",
  backlog: "backlog",
};

const STORY_POINTS = ["Custom field (Story Points)", "Story Points", "Story point estimate", "Story Point Estimate", "Custom field (Story point estimate)"];
const ORIGINAL_ESTIMATE = ["Original Estimate", "Original estimate", "Σ Original Estimate", "Time Estimate", "Original Estimate (seconds)"];

export const jira: TaskMapper = {
  source: "jira",
  kind: "task",
  label: "Jira",
  hint: "Issue navigator → Export → CSV (all fields or current fields).",
  signature: {
    strong: ["Issue key", "Issue id", "Issue Type", "Project key"],
    weak: ["Summary", "Status", "Priority", "Resolution", "Reporter", "Labels", "Sprint", "Assignee", "Due Date", "Description", "Project name"],
  },

  mapping(columns) {
    const map: Record<string, string> = {};
    assign(map, columns, "title", ["Summary", "Title"]);
    assign(map, columns, "externalKey", ["Issue key", "Key", "Issue Key"]);
    assign(map, columns, "description", ["Description"]);
    assign(map, columns, "status", ["Status"]);
    assign(map, columns, "stream", ["Project name", "Project", "Project key"]);
    assign(map, columns, "dueDate", ["Due Date", "Due date", "Duedate"]);
    assign(map, columns, "startDate", ["Start date", "Start Date", "Custom field (Start date)", "Target start"]);
    assign(map, columns, "createdAt", ["Created", "Created Date"]);
    assign(map, columns, "priority", ["Priority"]);
    assignAll(map, columns, "tags", ["Labels", "Label", "Component/s", "Components"]);
    // Story points first: a point count is the estimate a Jira team actually
    // maintains, and the seconds column is often an untouched default.
    if (!assign(map, columns, "estimate", STORY_POINTS)) assign(map, columns, "estimate", ORIGINAL_ESTIMATE);
    assign(map, columns, "assigneeEmail", ["Assignee Email", "Assignee email address", "Assignee E-mail", "Assignee"]);
    return ignoreRest(map, columns);
  },

  normalise(row, mapping, index): RowResult<NormalisedTask> {
    const estimateColumn = Object.keys(mapping).find((c) => mapping[c] === "estimate");
    const inSeconds = estimateColumn ? ORIGINAL_ESTIMATE.some((n) => norm(n) === norm(estimateColumn.replace(/\s*\(\d+\)$/, ""))) : false;
    return buildTask(row, mapping, index, {
      source: "jira",
      statuses: STATUSES,
      priority: jiraPriority,
      estimateDays: (raw) => {
        const n = parseNumber(raw);
        if (n === null || n <= 0) return null;
        return inSeconds ? secondsToDays(n) : pointsToDays(n);
      },
      refine: (task, r, m, warnings) => {
        // A Jira card closed as "Won't Do" or "Duplicate" still has status Done,
        // so the Resolution column is the only place that distinction survives.
        const column = Object.keys(m).find((c) => norm(baseName(c)) === "resolution");
        const resolution = column ? (r[column] ?? "").trim() : "";
        if (resolution && task.status === "completed" && /won|wont|duplicate|cannot|declin|incomplete|abandon/i.test(resolution)) {
          task.status = "wontfix";
          warnings.push(`resolution "${resolution}" → wontfix rather than completed`);
        }
      },
    });
  },

  template() {
    return [
      ["Issue key", "Summary", "Description", "Status", "Priority", "Project name", "Assignee Email", "Created", "Due Date", "Custom field (Story Points)", "Labels", "Labels"],
      ["ATL-101", "Rework the checkout summary", "Totals disagree with the invoice PDF.", "In Progress", "High", "Storefront", "elena@atelier14.demo", "12/Mar/26 9:14 AM", "20/Mar/26", "3", "billing", "regression"],
      ["ATL-102", "Archive the 2025 price list", "", "To Do", "Low", "Storefront", "", "13/Mar/26 10:02 AM", "", "1", "chore", ""],
    ];
  },
};
