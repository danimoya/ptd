/**
 * Trello → PTD.
 *
 * A Trello board has no status field: the list a card sits in *is* its status,
 * so `List Name` drives PTD's status and `Board Name` becomes the stream. The
 * `Archived` column overrides both — an archived card is `wontfix` whatever
 * list it was parked in.
 *
 * External keys: Trello's `Card ID` is a 24-character ObjectId, stable forever;
 * the short link (the 8 characters in the card URL) is the fallback because
 * board exports sometimes omit the id column but never the URL.
 */

import type { TaskStatus } from "../../../db/schema";
import type { NormalisedTask, RowResult, TaskMapper } from "../types";
import { assign, assignAll, baseName, findColumn, ignoreRest, isTruthy, norm, pick } from "./shared";
import { buildTask } from "./taskRow";

/** Common Trello list names beyond the shared vocabulary. */
const STATUSES: Record<string, TaskStatus> = {
  inbox: "backlog",
  someday: "backlog",
  thisweek: "triaged",
  uphext: "triaged",
  wip: "in-progress",
  inprogress: "in-progress",
  blocked: "in-progress",
  waiting: "in-progress",
  qa: "in-progress",
  shipped: "completed",
  live: "completed",
};

const SHORT_LINK = /trello\.com\/c\/([A-Za-z0-9]{6,12})/;

export const trello: TaskMapper = {
  source: "trello",
  kind: "task",
  label: "Trello",
  hint: "Board menu → More → Print and Export → Export as CSV (Premium).",
  signature: {
    strong: ["Card ID", "Card Name", "List Name", "Card Short Link", "Board Name"],
    weak: ["Card URL", "Card Description", "Due Date", "Members", "Labels", "Archived", "Start Date", "List ID", "Board ID"],
  },

  mapping(columns) {
    const map: Record<string, string> = {};
    assign(map, columns, "title", ["Card Name", "Name", "Title"]);
    assign(map, columns, "externalKey", ["Card ID", "Card Short Link", "Short Link"]);
    assign(map, columns, "description", ["Card Description", "Description"]);
    assign(map, columns, "status", ["List Name", "List"]);
    // Board first — a Trello board is the swim-lane; the list is the column in it.
    assign(map, columns, "stream", ["Board Name", "Board", "List Name"]);
    assign(map, columns, "dueDate", ["Due Date", "Due"]);
    assign(map, columns, "startDate", ["Start Date", "Start"]);
    assign(map, columns, "createdAt", ["Created", "Card Created", "Date Created"]);
    assignAll(map, columns, "tags", ["Labels", "Label"]);
    assign(map, columns, "assigneeEmail", ["Member Emails", "Members Email", "Members", "Member"]);
    return ignoreRest(map, columns);
  },

  normalise(row, mapping, index): RowResult<NormalisedTask> {
    return buildTask(row, mapping, index, {
      source: "trello",
      statuses: STATUSES,
      fallbackKey: (r, m) => {
        const columns = Object.keys(m);
        const urlColumn = findColumn(columns, ["Card URL", "URL", "Link"]);
        const url = urlColumn ? (r[urlColumn] ?? "") : "";
        return url.match(SHORT_LINK)?.[1] ?? null;
      },
      refine: (task, r, m, warnings) => {
        const archivedColumn = Object.keys(m).find((c) => norm(baseName(c)) === "archived");
        if (archivedColumn && isTruthy(r[archivedColumn] ?? "")) {
          if (task.status !== "wontfix") warnings.push(`archived card — filed as wontfix instead of ${task.status}`);
          task.status = "wontfix";
        }
        // When the board column was also used as the status, the stream name
        // would otherwise be a status word ("Doing") rather than a project.
        const streamColumn = Object.keys(m).find((c) => m[c] === "stream");
        const statusColumn = Object.keys(m).find((c) => m[c] === "status");
        if (streamColumn && streamColumn === statusColumn) {
          warnings.push(`no Board column in the file — the list "${pick(r, m, "stream")}" was used as the stream`);
        }
      },
    });
  },

  template() {
    return [
      ["Card ID", "Card Name", "Card Description", "List Name", "Board Name", "Due Date", "Start Date", "Labels", "Members", "Archived", "Card URL"],
      ["5f2b9c1d4e8a7b0012c3d456", "Photograph the spring range", "Studio booked for the 4th.", "Doing", "Atelier 14 · Editorial", "2026-03-20", "2026-03-16", "photography,spring", "mira", "false", "https://trello.com/c/Ab12Cd34/12-photograph"],
      ["5f2b9c1d4e8a7b0012c3d457", "Retire the 2025 lookbook", "", "Done", "Atelier 14 · Editorial", "", "", "chore", "", "true", "https://trello.com/c/Ef56Gh78/13-retire"],
    ];
  },
};
