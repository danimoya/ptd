/**
 * Clockify → PTD time entries.
 *
 * Nearly Toggl's layout with different capitalisation, and two columns that make
 * it unmistakable in detection: `Duration (h)` (an `hh:mm:ss` clock string) and
 * `Duration (decimal)`. The clock column is mapped first because it is the one
 * Clockify always writes; the decimal is a fallback for reports configured
 * without it.
 */

import type { NormalisedEntry, RowResult, TimeMapper } from "../types";
import { assign, ignoreRest } from "./shared";
import { buildEntry } from "./entryRow";

export const clockify: TimeMapper = {
  source: "clockify",
  kind: "time",
  label: "Clockify",
  hint: "Reports → Detailed → Export → CSV.",
  signature: {
    strong: ["Duration (h)", "Duration (decimal)", "Billable Rate (USD)"],
    weak: ["Project", "Client", "Description", "Task", "User", "Group", "Email", "Tags", "Billable", "Start Date", "Start Time", "End Date", "End Time"],
  },

  mapping(columns) {
    const map: Record<string, string> = {};
    assign(map, columns, "userEmail", ["Email", "User Email", "E-mail"]);
    assign(map, columns, "userName", ["User", "User Name"]);
    assign(map, columns, "customer", ["Client", "Customer"]);
    assign(map, columns, "stream", ["Project", "Project Name"]);
    assign(map, columns, "notes", ["Description", "Notes"]);
    assign(map, columns, "taskRef", ["Task"]);
    assign(map, columns, "startDate", ["Start Date", "Start date"]);
    assign(map, columns, "startTime", ["Start Time", "Start time"]);
    assign(map, columns, "endDate", ["End Date", "End date"]);
    assign(map, columns, "endTime", ["End Time", "End time"]);
    if (!assign(map, columns, "duration", ["Duration (h)", "Duration"])) {
      assign(map, columns, "hours", ["Duration (decimal)", "Duration (decimal hours)"]);
    }
    return ignoreRest(map, columns);
  },

  normalise(row, mapping, index): RowResult<NormalisedEntry> {
    return buildEntry(row, mapping, index);
  },

  template() {
    return [
      ["Project", "Client", "Description", "Task", "User", "Group", "Email", "Tags", "Billable", "Start Date", "Start Time", "End Date", "End Time", "Duration (h)", "Duration (decimal)"],
      ["Editorial", "Atelier 14", "[ATL-102] archive the price list", "", "Elena Ruiz", "", "elena@atelier14.demo", "", "No", "2026-03-17", "10:00:00", "2026-03-17", "11:30:00", "01:30:00", "1.50"],
      ["Editorial", "Atelier 14", "Draft the March newsletter", "", "Mira Koch", "", "mira@atelier14.demo", "copy", "Yes", "2026-03-17", "14:15:00", "2026-03-17", "17:00:00", "02:45:00", "2.75"],
    ];
  },
};
