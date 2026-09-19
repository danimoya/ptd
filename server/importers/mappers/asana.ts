/**
 * Asana → PTD.
 *
 * Asana has no status column. Completion is a separate fact (`Completed At`, or
 * a `Completed` boolean in older exports) and the *stage* of an unfinished task
 * lives in `Section/Column`, which behaves like a Trello list. So the status is
 * assembled from both: completed wins, otherwise the section name is read as a
 * workflow step.
 *
 * `Projects` is a comma-separated list when a task sits in several; the first
 * one becomes the stream, since a PTD card belongs to exactly one.
 */

import type { NormalisedTask, RowResult, TaskMapper } from "../types";
import { assign, assignAll, baseName, findColumn, ignoreRest, isTruthy, mapStatus, norm, pick } from "./shared";
import { buildTask } from "./taskRow";

export const asana: TaskMapper = {
  source: "asana",
  kind: "task",
  label: "Asana",
  hint: "Project → ⌄ → Export/Print → CSV.",
  // `Assignee Email` is deliberately NOT strong: PTD's own generic template has a
  // column by that name, and one shared header must not make a hand-written CSV
  // look like an Asana export.
  signature: {
    strong: ["Task ID", "Section/Column", "Blocked By (Dependencies)", "Blocking (Dependents)"],
    weak: ["Created At", "Completed At", "Last Modified", "Name", "Assignee", "Assignee Email", "Start Date", "Due Date", "Tags", "Notes", "Projects", "Parent task"],
  },

  mapping(columns) {
    const map: Record<string, string> = {};
    assign(map, columns, "title", ["Name", "Task Name", "Title"]);
    assign(map, columns, "externalKey", ["Task ID", "Task Id", "ID"]);
    assign(map, columns, "description", ["Notes", "Description"]);
    assign(map, columns, "status", ["Section/Column", "Section", "Column"]);
    assign(map, columns, "stream", ["Projects", "Project"]);
    assign(map, columns, "dueDate", ["Due Date", "Due On", "Due"]);
    assign(map, columns, "startDate", ["Start Date", "Start On", "Start"]);
    assign(map, columns, "createdAt", ["Created At", "Created"]);
    assign(map, columns, "priority", ["Priority"]);
    assignAll(map, columns, "tags", ["Tags", "Tag"]);
    assign(map, columns, "assigneeEmail", ["Assignee Email", "Assignee E-mail", "Assignee"]);
    return ignoreRest(map, columns);
  },

  normalise(row, mapping, index): RowResult<NormalisedTask> {
    return buildTask(row, mapping, index, {
      source: "asana",
      refine: (task, r, m, warnings) => {
        const columns = Object.keys(m);
        const completedFlag = findColumn(columns, ["Completed"]);
        const completedAt = findColumn(columns, ["Completed At", "Completed On"]);
        const done =
          (completedFlag && isTruthy(r[completedFlag] ?? "")) || (completedAt ? (r[completedAt] ?? "").trim() !== "" : false);
        if (done) {
          task.status = "completed";
          return;
        }
        // Not completed: a section named "Done" is a parking lane, not a state,
        // so an unfinished task in it must not come across as completed.
        if (task.status === "completed") {
          const section = pick(r, m, "status");
          task.status = "in-progress";
          warnings.push(`section "${section}" reads as done but the task is not completed in Asana — filed as in-progress`);
        }
      },
    });
  },

  template() {
    return [
      ["Task ID", "Created At", "Completed At", "Name", "Section/Column", "Assignee", "Assignee Email", "Start Date", "Due Date", "Tags", "Notes", "Projects"],
      ["1205993847561234", "2026-03-02", "", "Draft the March newsletter", "In Progress", "Elena Ruiz", "elena@atelier14.demo", "2026-03-10", "2026-03-18", "newsletter, copy", "Two sections plus the shop banner.", "Editorial"],
      ["1205993847561235", "2026-03-03", "2026-03-11", "Book the studio", "Done", "Mira Koch", "mira@atelier14.demo", "", "2026-03-12", "", "", "Editorial, Ops"],
    ];
  },
};
