/**
 * Any CSV → PTD.
 *
 * The fallback, and also the format PTD documents for a hand-written file: one
 * column per PTD field, named after the field. It matches by shape rather than
 * by an exact header list — `title`/`name`/`summary`/`task` all mean the title —
 * and it accepts the direct `urgency`/`impact`/`effort` columns that no external
 * tool emits, so an org can round-trip its own scoring.
 *
 * Detection never *prefers* this mapper; it is what is left when nothing else
 * recognises the header, which is also why it warns loudly about a synthesised
 * external key: without a key column, a re-import can only be idempotent for
 * rows whose title and created date did not change.
 */

import type { NormalisedTask, RowResult, TaskMapper } from "../types";
import { assign, assignAll, findLike, ignoreRest, jiraPriority, parseNumber } from "./shared";
import { buildTask } from "./taskRow";

export const generic: TaskMapper = {
  source: "generic",
  kind: "task",
  label: "Generic CSV",
  hint: "Any CSV with a title column. Map the rest yourself, or name the columns after PTD's fields.",
  // Its signature is PTD's own field vocabulary — the headers of the template
  // this mapper hands out. Nothing here is `strong`, so a file that genuinely
  // came from Jira or Linear always outscores it.
  signature: {
    strong: [],
    weak: [
      "title", "name", "summary", "task", "status", "description", "stream", "externalKey",
      "assigneeEmail", "startDate", "dueDate", "estimate", "tags", "urgency", "impact", "effort",
      "priority", "createdAt",
    ],
  },

  mapping(columns) {
    const map: Record<string, string> = {};
    // Exact field names first, so a file written against PTD's own template maps
    // perfectly; then the loose contains-match for everything else.
    assign(map, columns, "title", ["title", "name", "summary", "task", "task name", "card", "issue"]);
    assign(map, columns, "externalKey", ["externalKey", "external key", "key", "id", "ref", "reference", "ticket"]);
    assign(map, columns, "description", ["description", "notes", "details", "body", "summary"]);
    assign(map, columns, "status", ["status", "state", "stage", "column", "list"]);
    assign(map, columns, "stream", ["stream", "project", "board", "team", "lane", "workstream"]);
    assign(map, columns, "dueDate", ["dueDate", "due date", "due", "deadline", "target date"]);
    assign(map, columns, "startDate", ["startDate", "start date", "start", "begin", "kickoff"]);
    assign(map, columns, "createdAt", ["createdAt", "created at", "created", "date created"]);
    assign(map, columns, "estimate", ["estimate", "estimatedDuration", "estimated duration", "days", "duration", "story points", "points"]);
    assign(map, columns, "priority", ["priority", "severity"]);
    assign(map, columns, "urgency", ["urgency"]);
    assign(map, columns, "impact", ["impact"]);
    assign(map, columns, "effort", ["effort"]);
    assignAll(map, columns, "tags", ["tags", "labels", "label", "tag", "topics"]);
    assign(map, columns, "assigneeEmail", ["assigneeEmail", "assignee email", "assignee", "owner", "email", "e-mail", "member"]);

    // Anything still unclaimed gets one loose pass, so `Ticket Summary` or
    // `Target Due` land where they obviously belong.
    const unclaimed = () => columns.filter((c) => !map[c]);
    for (const [field, fragments] of [
      ["title", ["title", "summary", "subject"]],
      ["status", ["status", "state"]],
      ["dueDate", ["due", "deadline"]],
      ["startDate", ["start"]],
      ["stream", ["project", "stream", "board"]],
      ["assigneeEmail", ["email", "assignee", "owner"]],
      ["description", ["descr", "note", "detail"]],
    ] as const) {
      if (Object.values(map).includes(field)) continue;
      const hit = findLike(unclaimed(), [...fragments]);
      if (hit) map[hit] = field;
    }
    return ignoreRest(map, columns);
  },

  normalise(row, mapping, index): RowResult<NormalisedTask> {
    return buildTask(row, mapping, index, {
      source: "generic",
      priority: jiraPriority,
      estimateDays: (raw) => {
        const n = parseNumber(raw);
        return n === null || n <= 0 ? null : Math.max(1, Math.ceil(n));
      },
    });
  },

  template() {
    return [
      ["externalKey", "title", "description", "status", "stream", "assigneeEmail", "startDate", "dueDate", "estimate", "tags", "urgency", "impact", "effort"],
      ["OPS-1", "Re-key the studio locks", "Locksmith booked for the morning.", "triaged", "Operations", "elena@atelier14.demo", "2026-03-16", "2026-03-17", "1", "facilities", "7", "6", "2"],
      ["OPS-2", "Renew the insurance policy", "", "backlog", "Operations", "", "", "2026-04-30", "2", "admin,finance", "5", "8", "3"],
    ];
  },
};
