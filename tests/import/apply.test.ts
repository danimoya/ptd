import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import { db } from "../../db";
import { customers, importRuns, memberships, streams, taskEvents, tasks, timeEntries } from "../../db/schema";
import type { ActionContext } from "../../server/actions/registry";
import { commit, descriptionToStore, prepare, preview, runsFor } from "../../server/importers/apply";
import type { FakeDb } from "./fake-db";

const fake = db as unknown as FakeDb;

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  userId: 2,
  email: "elena@atelier14.demo",
  displayName: "Elena Ruiz",
  orgId: 5,
  role: "owner",
  authType: "human",
  via: "web",
  ...over,
});

const MEMBERS = [
  { userId: 2, email: "elena@atelier14.demo", isAgent: false, displayName: "Elena Ruiz" },
  { userId: 3, email: "mira@atelier14.demo", isAgent: false, displayName: "Mira Koch" },
  { userId: 9, email: "claude@atelier14.demo", isAgent: true, displayName: "Claude Worker" },
];

/**
 * loadOrgIndex fires four SELECTs in parallel, one per table, so the fake's
 * per-table queues line up regardless of which resolves first.
 */
function queueOrg({ taskRows = [] as any[], streamRows = [] as any[], customerRows = [] as any[], members = MEMBERS } = {}) {
  fake.queue(tasks, taskRows);
  fake.queue(streams, streamRows);
  fake.queue(customers, customerRows);
  fake.queue(memberships, members);
}

/** A Jira export with six issues, one of them carrying a quoted multi-line description. */
const JIRA_CSV = [
  "Issue key,Summary,Description,Status,Priority,Project name,Assignee Email,Created,Due Date,Custom field (Story Points),Labels,Labels",
  'ATL-101,Rework the checkout summary,"Totals disagree with the invoice PDF.\nSeen on staging, twice.",In Progress,High,Storefront,elena@atelier14.demo,12/Mar/26 9:14 AM,20/Mar/26,3,billing,regression',
  "ATL-102,Archive the 2025 price list,,To Do,Lowest,Storefront,,13/Mar/26 10:02 AM,,1,chore,",
  "ATL-103,Re-shoot the hero image,Studio booked.,Backlog,Medium,Storefront,mira@atelier14.demo,14/Mar/26 11:00 AM,28/Mar/26,2,photography,",
  "ATL-104,Fix the VAT rounding,,Done,Highest,Ledger,elena@atelier14.demo,15/Mar/26 8:30 AM,18/Mar/26,5,billing,tax",
  "ATL-105,Drop the legacy CSV export,,In Progress,Low,Ledger,,16/Mar/26 9:00 AM,,1,chore,",
  "ATL-106,,Nothing to do here,To Do,Medium,Ledger,,17/Mar/26 9:00 AM,,,,",
].join("\n");

beforeEach(() => {
  fake.reset();
});

describe("prepare", () => {
  it("detects the source and normalises every row once", () => {
    const prepared = prepare({ csv: JIRA_CSV });
    expect(prepared.source).toBe("jira");
    expect(prepared.kind).toBe("task");
    expect(prepared.taskRows).toHaveLength(6);
    expect(prepared.taskRows.filter((r) => r.value).length).toBe(5);
    // The titleless row is refused by the mapper, not by the writer.
    expect(prepared.taskRows[5].skip).toBe("no title");
  });

  it("lets a mapping override move a column", () => {
    const prepared = prepare({ csv: JIRA_CSV, mapping: { "Project name": "-", Summary: "title" } });
    expect(prepared.mapping["Project name"]).toBe("-");
    expect(prepared.taskRows[0].value!.streamName).toBeNull();
  });

  it("warns about a mapping that names a column the file lacks", () => {
    const prepared = prepare({ csv: JIRA_CSV, mapping: { Nonexistent: "title" } });
    expect(prepared.warnings.join(" ")).toMatch(/not in the file/);
  });

  it("refuses a file with no title column at all", () => {
    expect(() => prepare({ source: "generic", csv: "status,stream\nbacklog,Ops" })).toThrow(/title/);
  });

  it("honours an explicit source over detection", () => {
    expect(prepare({ source: "generic", csv: JIRA_CSV }).source).toBe("generic");
  });
});

describe("preview", () => {
  it("counts creates and names the stream it would make", async () => {
    queueOrg();
    const result = await preview({ csv: JIRA_CSV }, ctx());
    expect(result.source).toBe("jira");
    expect(result.counts).toEqual({ create: 5, update: 0, skip: 1 });
    expect(result.creates.streams.sort()).toEqual(["Ledger", "Storefront"]);
    expect(result.totalRows).toBe(6);
    expect(result.rows).toHaveLength(6);
    expect(result.rows[0].action).toBe("create");
    expect(result.rows[5].action).toBe("skip");
  });

  it("writes nothing", async () => {
    queueOrg();
    await preview({ csv: JIRA_CSV }, ctx());
    expect(fake.inserts).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it("marks a row that matches an existing external key as an update", async () => {
    queueOrg({
      taskRows: [{ id: 77, orgId: 5, title: "Rework the checkout summary", externalKey: "ATL-101", streamId: 9, tags: [], dependencies: [] }],
      streamRows: [{ id: 9, name: "Storefront", position: 1 }],
    });
    const result = await preview({ csv: JIRA_CSV }, ctx());
    expect(result.counts).toEqual({ create: 4, update: 1, skip: 1 });
    expect(result.rows[0].action).toBe("update");
    expect(result.rows[0].reason).toMatch(/#77/);
    expect(result.creates.streams).toEqual(["Ledger"]);
  });

  it("resolves the assignee and the derived priority score in the preview values", async () => {
    queueOrg();
    const result = await preview({ csv: JIRA_CSV }, ctx());
    expect(result.rows[0].values.assignee).toBe("Elena Ruiz");
    // High → urgency 7, impact 5, effort 5 → round(7×5/5) = 7
    expect(result.rows[0].values.priorityScore).toBe(7);
    expect(result.rows[0].values.tags).toEqual(["billing", "regression"]);
  });

  it("files every row under streamId when one is given", async () => {
    queueOrg({ streamRows: [{ id: 4, name: "Migration", position: 2 }] });
    const result = await preview({ csv: JIRA_CSV, streamId: 4 }, ctx());
    expect(result.creates.streams).toEqual([]);
    expect(result.rows[0].values.stream).toBe("Migration");
  });

  it("rejects a streamId from another organization", async () => {
    queueOrg();
    await expect(preview({ csv: JIRA_CSV, streamId: 999 }, ctx())).rejects.toThrow(/does not exist/);
  });
});

describe("commit — tasks", () => {
  it("creates the streams, then the cards, then the history rows", async () => {
    queueOrg();
    const result = await commit({ csv: JIRA_CSV }, ctx());

    expect(result).toMatchObject({ source: "jira", kind: "task", created: 5, updated: 0, skipped: 1 });
    expect(result.streamsCreated.sort()).toEqual(["Ledger", "Storefront"]);
    expect(result.errors).toEqual([]);

    const cards = fake.insertedInto(tasks);
    expect(cards).toHaveLength(5);
    const first = cards[0];
    expect(first).toMatchObject({
      orgId: 5,
      title: "Rework the checkout summary",
      externalKey: "ATL-101",
      status: "in-progress",
      urgency: 7,
      impact: 5,
      priorityScore: 7,
      completed: false,
      createdBy: 2,
    });
    expect(first.description).toContain("<br>");
    expect(first.assignedTo).toBe(2);
    expect(first.streamId).toBeTypeOf("number");

    // A Done issue lands completed, and the flag agrees with the status.
    const done = cards.find((c) => c.externalKey === "ATL-104")!;
    expect([done.status, done.completed]).toEqual(["completed", true]);
    expect(done.priorityScore).toBe(9); // Highest → 9×5/5
  });

  it("writes one task_events row per card, kind created, via import", async () => {
    queueOrg();
    await commit({ csv: JIRA_CSV }, ctx());
    const events = fake.insertedInto(taskEvents);
    expect(events).toHaveLength(5);
    for (const event of events) {
      expect(event.kind).toBe("created");
      expect(event.via).toBe("import");
      expect(event.orgId).toBe(5);
      expect(event.actorUserId).toBe(2);
      expect(event.note.startsWith("import: jira")).toBe(true);
    }
  });

  it("labels an agent-run import as an agent in the history rows", async () => {
    queueOrg();
    await commit({ csv: JIRA_CSV }, ctx({ displayName: "Claude Worker", authType: "agent", via: "mcp" }));
    expect(fake.insertedInto(taskEvents)[0].actorLabel).toBe("Claude Worker (agent)");
  });

  it("creates each stream exactly once for six rows across two projects", async () => {
    queueOrg();
    await commit({ csv: JIRA_CSV }, ctx());
    expect(fake.insertedInto(streams)).toHaveLength(2);
  });

  it("records the run as an import_runs row, warnings and all", async () => {
    queueOrg();
    await commit({ csv: JIRA_CSV }, ctx());
    const [row] = fake.insertedInto(importRuns);
    expect(row).toMatchObject({ orgId: 5, userId: 2, source: "jira", created: 5, skipped: 1 });
    // The run's warnings travel with it, so "what did that import complain about"
    // survives the restart the in-memory list did not.
    expect(row.warnings).toEqual(['Column "Labels" appears 2 times; all copies are read.']);
  });

  it("reads the history back out of the table, newest first and per organization", async () => {
    const at = new Date("2026-09-19T08:00:00.000Z");
    fake.queue(importRuns, [
      { at, source: "jira", created: 5, updated: 1, skipped: 1, warnings: ["error: row 3 blew up", "row 6: skipped"], userId: 9, displayName: "Claude Worker", isAgent: true },
    ]);
    const runs = await runsFor(5);
    expect(runs).toEqual([
      {
        at: at.toISOString(),
        source: "jira",
        kind: "task",
        by: "Claude Worker (agent)",
        created: 5,
        updated: 1,
        skipped: 1,
        warnings: ["row 6: skipped"],
        errors: 1,
      },
    ]);
    // Nothing queued for the next call: another organization sees an empty list.
    await expect(runsFor(6)).resolves.toEqual([]);
  });

  it("re-imports the same file as updates, not duplicates", async () => {
    // First pass on an empty org. The stream INSERTs get canned ids so the rows
    // fed back below are exactly what the org would hold afterwards.
    queueOrg();
    fake.queue(streams, [{ id: 9, name: "Storefront" }]);
    fake.queue(streams, [{ id: 10, name: "Ledger" }]);
    const firstRun = await commit({ csv: JIRA_CSV }, ctx());
    const created = fake.insertedInto(tasks).map((values, i) => ({ id: 500 + i, ...values }));
    expect(firstRun.created).toBe(5);
    expect(created.map((c) => c.streamId)).toEqual([9, 9, 9, 10, 10]);

    // Second pass with exactly what the first one wrote already in the org.
    fake.reset();
    queueOrg({
      taskRows: created,
      streamRows: [
        { id: 9, name: "Storefront", position: 1 },
        { id: 10, name: "Ledger", position: 2 },
      ],
    });
    const secondRun = await commit({ csv: JIRA_CSV }, ctx());

    expect(secondRun).toMatchObject({ created: 0, updated: 5, skipped: 1 });
    expect(fake.insertedInto(tasks)).toHaveLength(0);
    expect(fake.insertedInto(streams)).toHaveLength(0);
    expect(fake.updates.filter((u) => u.table === tasks)).toHaveLength(5);
    // Nothing moved, so the history rows carry no diff.
    const events = fake.insertedInto(taskEvents);
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.kind === "updated" && e.via === "import")).toBe(true);
    expect(events.every((e) => e.changes === null)).toBe(true);
    expect(events[0].note).toMatch(/re-imported by external key/);
  });

  it("diffs a re-import that really did change something", async () => {
    queueOrg({
      taskRows: [
        {
          id: 77, orgId: 5, title: "Rework the checkout summary", description: null, status: "backlog",
          externalKey: "ATL-101", streamId: 9, appId: null, assignedTo: null, startDate: null, dueDate: null,
          estimatedDuration: null, dependencies: [], urgency: 5, impact: 5, effort: 5, priorityScore: 5,
          prioritySource: "formula", priorityNote: null, tags: [], completed: false, createdBy: 2,
        },
      ],
      streamRows: [{ id: 9, name: "Storefront", position: 1 }],
    });
    await commit({ csv: JIRA_CSV, mapping: {} }, ctx());
    const updated = fake.insertedInto(taskEvents).find((e) => e.kind === "updated")!;
    expect(Object.keys(updated.changes)).toEqual(expect.arrayContaining(["status", "urgency", "priorityScore", "tags", "dueDate"]));
    expect(updated.changes.status).toEqual({ old: "backlog", new: "in-progress" });
  });

  it("leaves a card unassigned when the e-mail is not a member, and says so", async () => {
    queueOrg({ members: [MEMBERS[0]] });
    const result = await commit({ csv: JIRA_CSV }, ctx());
    const card = fake.insertedInto(tasks).find((c) => c.externalKey === "ATL-103")!;
    expect(card.assignedTo).toBeNull();
    expect(result.warnings.join(" ")).toMatch(/mira@atelier14\.demo.*not a member/);
  });

  it("uses defaultStreamName only for rows without a stream of their own", async () => {
    queueOrg();
    const csv = "title,status,stream\nWith a stream,backlog,Ops\nWithout one,backlog,";
    await commit({ source: "generic", csv, defaultStreamName: "Imported" }, ctx());
    const streamNames = fake.insertedInto(streams).map((s) => s.name);
    expect(streamNames).toEqual(["Ops", "Imported"]);
  });
});

describe("commit — time entries", () => {
  const TOGGL_CSV = [
    "User,Email,Client,Project,Description,Billable,Start date,Start time,End date,End time,Duration",
    "Elena Ruiz,elena@atelier14.demo,Kestrel & Co,Storefront,[ATL-101] checkout totals,Yes,2026-03-16,09:05:00,2026-03-16,11:35:00,02:30:00",
    "Mira Koch,mira@atelier14.demo,Kestrel & Co,Storefront,Re-shoot the hero image,Yes,2026-03-16,13:00:00,2026-03-16,15:45:00,02:45:00",
    "Nobody,ghost@elsewhere.test,Kestrel & Co,Storefront,Unknown person,Yes,2026-03-17,09:00:00,2026-03-17,10:00:00,01:00:00",
    "Elena Ruiz,elena@atelier14.demo,Kestrel & Co,Storefront,Too long,Yes,2026-03-18,08:00:00,2026-03-19,09:00:00,25:00:00",
  ].join("\n");

  const existingTasks = [
    { id: 501, orgId: 5, title: "Rework the checkout summary", externalKey: "ATL-101", streamId: 9, tags: [], dependencies: [] },
    { id: 503, orgId: 5, title: "Re-shoot the hero image", externalKey: "ATL-103", streamId: 9, tags: [], dependencies: [] },
  ];

  function queueTimeOrg(intervals: any[] = []) {
    queueOrg({ taskRows: existingTasks, streamRows: [{ id: 9, name: "Storefront", position: 1 }] });
    fake.queue(timeEntries, intervals); // loadIntervalKeys
  }

  it("creates the customer, links tasks by key and by title, and skips the bad rows", async () => {
    queueTimeOrg();
    const result = await commit({ csv: TOGGL_CSV }, ctx());

    expect(result.source).toBe("toggl");
    expect(result).toMatchObject({ created: 3, skipped: 1 });
    expect(result.customersCreated).toEqual(["Kestrel & Co"]);
    expect(result.streamsCreated).toEqual([]); // Storefront already existed
    expect(result.tasksLinked).toBe(2);

    const entries = fake.insertedInto(timeEntries);
    expect(entries[0]).toMatchObject({ userId: 2, orgId: 5, taskId: 501, streamId: 9, isBreak: false, entrySource: "human", agentLabel: null });
    // Title match inside the same stream, no bracketed key needed.
    expect(entries[1]).toMatchObject({ userId: 3, taskId: 503 });
    expect(entries[0].customerId).toBeTypeOf("number");
    expect(entries[0].checkOut.getTime() - entries[0].checkIn.getTime()).toBe(150 * 60_000);
  });

  it("logs a non-member's hours against the importer and warns", async () => {
    queueTimeOrg();
    const result = await commit({ csv: TOGGL_CSV }, ctx());
    expect(fake.insertedInto(timeEntries)[2]).toMatchObject({ userId: 2, taskId: null });
    expect(result.warnings.join(" ")).toMatch(/ghost@elsewhere\.test.*not a member/);
  });

  it("attributes an agent-run import to the agent, per the Track surface's rule", async () => {
    queueTimeOrg();
    await commit({ csv: TOGGL_CSV }, ctx({ displayName: "Claude Worker", authType: "agent" }));
    expect(fake.insertedInto(timeEntries)[0]).toMatchObject({ entrySource: "agent", agentLabel: "Claude Worker" });
  });

  it("skips an interval the ledger already has, so a re-import adds nothing", async () => {
    // Exactly the three intervals the first pass wrote.
    queueTimeOrg([
      { userId: 2, checkIn: new Date(2026, 2, 16, 9, 5), checkOut: new Date(2026, 2, 16, 11, 35) },
      { userId: 3, checkIn: new Date(2026, 2, 16, 13, 0), checkOut: new Date(2026, 2, 16, 15, 45) },
      { userId: 2, checkIn: new Date(2026, 2, 17, 9, 0), checkOut: new Date(2026, 2, 17, 10, 0) },
    ]);
    const result = await commit({ csv: TOGGL_CSV }, ctx());
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(4);
    expect(fake.insertedInto(timeEntries)).toHaveLength(0);
  });

  it("creates the stream when a Harvest project is new to the org", async () => {
    queueOrg({ members: MEMBERS });
    fake.queue(timeEntries, []);
    const csv = [
      "Date,Client,Project,Task,Notes,Hours,First Name,Last Name,Email,Project Code,Billable Rate",
      "2026-03-18,Northwind,Brand refresh,Design,Moodboard,3.5,Elena,Ruiz,elena@atelier14.demo,BR,90",
    ].join("\n");
    const result = await commit({ csv }, ctx());
    expect(result.source).toBe("harvest");
    expect(result.streamsCreated).toEqual(["Brand refresh"]);
    expect(result.customersCreated).toEqual(["Northwind"]);
    const entry = fake.insertedInto(timeEntries)[0];
    expect(entry.checkIn.getHours()).toBe(9);
    expect(entry.checkOut.getTime() - entry.checkIn.getTime()).toBe(210 * 60_000);
  });
});

describe("descriptionToStore", () => {
  it("leaves a single line exactly as it was", () => {
    expect(descriptionToStore("Totals disagree.")).toBe("Totals disagree.");
    expect(descriptionToStore(null)).toBeNull();
    expect(descriptionToStore("")).toBeNull();
  });

  it("escapes markup and turns newlines into breaks", () => {
    expect(descriptionToStore("a <b> & c\nsecond")).toBe("a &lt;b&gt; &amp; c<br>second");
  });
});
