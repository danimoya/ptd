/**
 * Toggl Track → PTD time entries.
 *
 * The "Detailed report → Download CSV" file. `Email` is the column that matters
 * most: it is the only thing in any of these exports that can be resolved to a
 * PTD membership, so a team import lands on the right ledgers instead of all on
 * the importer's.
 *
 * `Project` becomes the stream and `Client` the customer, both created on demand
 * (apply.ts), because a time sheet that cannot name where the hours went is not
 * worth importing.
 */

import type { NormalisedEntry, RowResult, TimeMapper } from "../types";
import { assign, ignoreRest } from "./shared";
import { buildEntry } from "./entryRow";

export const toggl: TimeMapper = {
  source: "toggl",
  kind: "time",
  label: "Toggl Track",
  hint: "Reports → Detailed → Download → CSV.",
  signature: {
    strong: ["Start date", "Start time", "End date", "End time"],
    weak: ["User", "Email", "Client", "Project", "Task", "Description", "Billable", "Duration", "Tags"],
    // Clockify's own columns; when they are present that mapper is the right one.
    absent: ["Duration (h)", "Duration (decimal)"],
  },

  mapping(columns) {
    const map: Record<string, string> = {};
    assign(map, columns, "userEmail", ["Email", "User Email", "E-mail"]);
    assign(map, columns, "userName", ["User", "User Name"]);
    assign(map, columns, "customer", ["Client", "Customer"]);
    assign(map, columns, "stream", ["Project", "Project Name"]);
    assign(map, columns, "notes", ["Description", "Notes"]);
    assign(map, columns, "taskRef", ["Task"]);
    assign(map, columns, "startDate", ["Start date", "Start Date"]);
    assign(map, columns, "startTime", ["Start time", "Start Time"]);
    assign(map, columns, "endDate", ["End date", "End Date"]);
    assign(map, columns, "endTime", ["End time", "End Time"]);
    assign(map, columns, "duration", ["Duration", "Duration (h)"]);
    return ignoreRest(map, columns);
  },

  normalise(row, mapping, index): RowResult<NormalisedEntry> {
    return buildEntry(row, mapping, index);
  },

  template() {
    return [
      ["User", "Email", "Client", "Project", "Task", "Description", "Billable", "Start date", "Start time", "End date", "End time", "Duration", "Tags"],
      ["Elena Ruiz", "elena@atelier14.demo", "Kestrel & Co", "Storefront", "", "[ATL-101] checkout totals", "Yes", "2026-03-16", "09:05:00", "2026-03-16", "11:35:00", "02:30:00", "dev"],
      ["Mira Koch", "mira@atelier14.demo", "Kestrel & Co", "Storefront", "", "Rework the checkout summary", "Yes", "2026-03-16", "13:00:00", "2026-03-16", "15:45:00", "02:45:00", ""],
    ];
  },
};
