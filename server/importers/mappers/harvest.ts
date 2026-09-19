/**
 * Harvest → PTD time entries.
 *
 * The odd one out: Harvest's time report has a `Date` and a decimal `Hours`
 * column and no clock times at all, so the interval has to be invented. Each row
 * is placed at 09:00 on its day (`entryRow.DEFAULT_START_HOUR`) and runs for
 * `Hours`, which every row reports as a warning so nobody mistakes the ledger's
 * clock times for recorded ones. The totals — the number PTD actually reports
 * on — are exact.
 *
 * Harvest identifies people by `First Name` / `Last Name` and only includes
 * `Email` when the report is configured with it; without an address the entry
 * lands on the importer's own ledger and the name is kept in the note.
 */

import type { NormalisedEntry, RowResult, TimeMapper } from "../types";
import { assign, findColumn, ignoreRest } from "./shared";
import { buildEntry } from "./entryRow";

export const harvest: TimeMapper = {
  source: "harvest",
  kind: "time",
  label: "Harvest",
  hint: "Reports → Time → Export → CSV.",
  signature: {
    strong: ["First Name", "Last Name", "Project Code", "Billable Rate", "Cost Rate"],
    weak: ["Date", "Client", "Project", "Task", "Notes", "Hours", "Billable?", "Invoiced?", "Currency", "Roles"],
  },

  mapping(columns) {
    const map: Record<string, string> = {};
    assign(map, columns, "userEmail", ["Email", "E-mail", "User Email"]);
    assign(map, columns, "userName", ["First Name", "Employee", "User"]);
    assign(map, columns, "customer", ["Client", "Customer"]);
    assign(map, columns, "stream", ["Project", "Project Name"]);
    assign(map, columns, "notes", ["Notes", "Description"]);
    assign(map, columns, "taskRef", ["Task"]);
    assign(map, columns, "date", ["Date", "Spent Date", "Spent At"]);
    assign(map, columns, "hours", ["Hours", "Decimal Hours"]);
    assign(map, columns, "startTime", ["Start Time", "Started At"]);
    assign(map, columns, "endTime", ["End Time", "Ended At"]);
    return ignoreRest(map, columns);
  },

  normalise(row, mapping, index): RowResult<NormalisedEntry> {
    const result = buildEntry(row, mapping, index);
    if (result.value) {
      // Harvest's `Task` is a billing category ("Design", "Development"), not a
      // ticket, so it must not be used to guess a PTD task — the notes are.
      result.value.taskRef = result.value.notes;
      const last = findColumn(Object.keys(mapping), ["Last Name"]);
      const surname = last ? (row[last] ?? "").trim() : "";
      if (surname && result.value.userName) result.value.userName = `${result.value.userName} ${surname}`;
    }
    return result;
  },

  template() {
    return [
      ["Date", "Client", "Project", "Task", "Notes", "Hours", "Billable?", "First Name", "Last Name", "Email"],
      ["2026-03-18", "Kestrel & Co", "Storefront", "Development", "[ATL-101] checkout totals", "3.25", "Yes", "Elena", "Ruiz", "elena@atelier14.demo"],
      ["2026-03-18", "Kestrel & Co", "Storefront", "Design", "Rework the checkout summary", "1.75", "Yes", "Mira", "Koch", "mira@atelier14.demo"],
    ];
  },
};
