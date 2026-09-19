/**
 * Linear → PTD.
 *
 * The cleanest of the five: `ID` is the human key (`ENG-214`), `Status` uses a
 * fixed vocabulary (Backlog / Todo / In Progress / Done / Canceled, plus Triage
 * and In Review), `Estimate` is a point count, and `Priority` is 1–4 with 1 the
 * most urgent — the inverse of every other scale here, which is why it gets its
 * own parser (`linearPriority`) rather than sharing Jira's.
 *
 * Stream: `Project` when the issue belongs to one, otherwise `Team`. A Linear
 * team is the durable grouping, so it is the better default than leaving the
 * card unfiled.
 */

import type { TaskStatus } from "../../../db/schema";
import type { NormalisedTask, RowResult, TaskMapper } from "../types";
import { assign, assignAll, findColumn, ignoreRest, linearPriority, parseNumber, pointsToDays } from "./shared";
import { buildTask } from "./taskRow";

const STATUSES: Record<string, TaskStatus> = {
  backlog: "backlog",
  todo: "triaged",
  triage: "triaged",
  inprogress: "in-progress",
  inreview: "in-progress",
  done: "completed",
  canceled: "wontfix",
  cancelled: "wontfix",
  duplicate: "wontfix",
};

export const linear: TaskMapper = {
  source: "linear",
  kind: "task",
  label: "Linear",
  hint: "Workspace settings → Import / Export → Export CSV.",
  signature: {
    strong: ["Cycle Number", "Cycle Name", "Parent issue", "SLA Status", "Roadmaps", "Project Milestone"],
    weak: ["ID", "Team", "Title", "Description", "Status", "Estimate", "Priority", "Project", "Creator", "Assignee", "Labels", "Started", "Triaged", "Completed", "Canceled", "Due Date"],
  },

  mapping(columns) {
    const map: Record<string, string> = {};
    assign(map, columns, "title", ["Title", "Name"]);
    assign(map, columns, "externalKey", ["ID", "Identifier", "Issue ID"]);
    assign(map, columns, "description", ["Description"]);
    assign(map, columns, "status", ["Status", "State"]);
    assign(map, columns, "stream", ["Project", "Team"]);
    assign(map, columns, "dueDate", ["Due Date", "Due"]);
    assign(map, columns, "startDate", ["Started", "Started At", "Start Date"]);
    assign(map, columns, "createdAt", ["Created", "Created At"]);
    assign(map, columns, "estimate", ["Estimate", "Estimate Points"]);
    assign(map, columns, "priority", ["Priority"]);
    assignAll(map, columns, "tags", ["Labels", "Label"]);
    assign(map, columns, "assigneeEmail", ["Assignee Email", "Assignee E-mail", "Assignee"]);
    return ignoreRest(map, columns);
  },

  normalise(row, mapping, index): RowResult<NormalisedTask> {
    return buildTask(row, mapping, index, {
      source: "linear",
      statuses: STATUSES,
      priority: linearPriority,
      estimateDays: (raw) => {
        const n = parseNumber(raw);
        return n === null || n <= 0 ? null : pointsToDays(n);
      },
      refine: (task, r, m) => {
        // `Canceled` and `Completed` are timestamp columns, not states; when the
        // status word was unrecognised they still settle the question.
        const columns = Object.keys(m);
        const canceled = findColumn(columns, ["Canceled", "Cancelled", "Canceled At"]);
        const completed = findColumn(columns, ["Completed", "Completed At"]);
        if (canceled && (r[canceled] ?? "").trim()) task.status = "wontfix";
        else if (completed && (r[completed] ?? "").trim() && task.status !== "wontfix") task.status = "completed";
      },
    });
  },

  template() {
    return [
      ["ID", "Team", "Title", "Description", "Status", "Estimate", "Priority", "Project", "Assignee", "Labels", "Created", "Started", "Completed", "Canceled", "Due Date"],
      ["ENG-214", "Engineering", "Split the ledger query", "It scans the whole table for a month view.", "In Progress", "3", "2", "Ledger", "elena@atelier14.demo", "performance", "2026-03-04T08:11:00Z", "2026-03-09T09:00:00Z", "", "", "2026-03-24"],
      ["ENG-215", "Engineering", "Drop the legacy export", "", "Canceled", "1", "4", "Ledger", "", "chore", "2026-03-05T10:00:00Z", "", "", "2026-03-08T12:00:00Z", ""],
    ];
  },
};
