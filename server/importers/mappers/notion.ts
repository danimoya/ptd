/**
 * Notion → PTD.
 *
 * A Notion CSV has no fixed schema at all — the header is whatever the database
 * properties are called. Two things are nevertheless reliable: the title
 * property is the first column and is usually called `Name`, and a `Status` or
 * `Select` property carries the workflow. Everything else is matched by the
 * names Notion templates ship with.
 *
 * Keys: Notion does not export the page id as a column unless a formula adds
 * one, so the order is `Page ID`/`ID`/`Key`, then the 32-hex id at the tail of a
 * page URL, then a hash of title + created (shared.synthKey).
 */

import type { NormalisedTask, RowResult, TaskMapper } from "../types";
import { assign, assignAll, findColumn, ignoreRest, jiraPriority } from "./shared";
import { buildTask } from "./taskRow";

const NOTION_ID = /([0-9a-f]{32})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export const notion: TaskMapper = {
  source: "notion",
  kind: "task",
  label: "Notion",
  hint: "Database → ••• → Export → CSV (include all properties).",
  signature: {
    strong: ["Page ID", "Notion ID"],
    weak: ["Name", "Status", "Assign", "Tags", "Due", "Priority", "Created time", "Last edited time", "Owner", "Project"],
  },

  mapping(columns) {
    const map: Record<string, string> = {};
    // Notion's title property is always the first column; `Name` is the default
    // name for it, but a renamed one still has to be found.
    if (!assign(map, columns, "title", ["Name", "Title", "Task", "Task name", "Page"]) && columns.length > 0) {
      map[columns[0]] = "title";
    }
    assign(map, columns, "externalKey", ["Page ID", "Notion ID", "ID", "Key", "Ref"]);
    assign(map, columns, "description", ["Notes", "Description", "Summary", "Details"]);
    assign(map, columns, "status", ["Status", "State", "Stage", "Progress"]);
    assign(map, columns, "stream", ["Project", "Projects", "Stream", "Category", "Group", "Area", "Team"]);
    assign(map, columns, "dueDate", ["Due", "Due date", "Deadline", "Date"]);
    assign(map, columns, "startDate", ["Start", "Start date", "Kickoff"]);
    assign(map, columns, "createdAt", ["Created time", "Created", "Created At"]);
    assign(map, columns, "estimate", ["Estimate", "Days", "Effort (days)", "Duration"]);
    assign(map, columns, "priority", ["Priority", "Urgency level"]);
    assignAll(map, columns, "tags", ["Tags", "Labels", "Multi-select", "Topics"]);
    assign(map, columns, "assigneeEmail", ["Assignee Email", "Assign", "Assignee", "Owner", "Person"]);
    return ignoreRest(map, columns);
  },

  normalise(row, mapping, index): RowResult<NormalisedTask> {
    return buildTask(row, mapping, index, {
      source: "notion",
      priority: jiraPriority,
      fallbackKey: (r, m) => {
        const urlColumn = findColumn(Object.keys(m), ["URL", "Page URL", "Link", "Notion URL"]);
        const url = urlColumn ? (r[urlColumn] ?? "") : "";
        const id = url.match(NOTION_ID)?.[0];
        return id ? id.replace(/-/g, "").toLowerCase() : null;
      },
    });
  },

  template() {
    return [
      ["Name", "Status", "Assign", "Project", "Tags", "Priority", "Start", "Due", "Estimate", "Notes", "Created time"],
      ["Rewrite the about page", "In progress", "elena@atelier14.demo", "Website", "copy, web", "High", "2026-03-11", "2026-03-19", "2", "Keep the studio photograph.", "2026-03-01T09:00:00.000Z"],
      ["Collect client testimonials", "Not started", "", "Website", "outreach", "Low", "", "2026-04-02", "3", "", "2026-03-02T11:30:00.000Z"],
    ];
  },
};
