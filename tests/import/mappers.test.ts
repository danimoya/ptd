import { describe, expect, it } from "vitest";
import { parseCsv } from "../../server/importers/csv";
import { detectSource } from "../../server/importers/detect";
import { MAPPERS, mapperFor } from "../../server/importers/mappers";
import type { NormalisedEntry, NormalisedTask, Source } from "../../server/importers/types";

/**
 * Each fixture is a real export's header row plus two records — the smallest
 * sample that exercises a mapper honestly, because the second row is always the
 * awkward one (empty cells, a closed card, a crossed-midnight session).
 */
const FIXTURES: Record<Source, string> = {
  jira: [
    "Issue key,Summary,Description,Status,Priority,Resolution,Project name,Assignee,Assignee Email,Created,Due Date,Custom field (Story Points),Labels,Labels",
    'ATL-101,Rework the checkout summary,"Totals disagree with the invoice PDF.\nSeen on staging, twice.",In Progress,High,,Storefront,Elena Ruiz,elena@atelier14.demo,12/Mar/26 9:14 AM,20/Mar/26,3,billing,regression',
    "ATL-102,Archive the 2025 price list,,Done,Lowest,Won't Do,Storefront,,,13/Mar/26 10:02 AM,,1,chore,",
  ].join("\n"),

  trello: [
    "Card ID,Card Name,Card Description,List Name,Board Name,Due Date,Start Date,Labels,Members,Archived,Card URL",
    "5f2b9c1d4e8a7b0012c3d456,Photograph the spring range,Studio booked for the 4th.,Doing,Atelier 14 · Editorial,2026-03-20,2026-03-16,\"photography,spring\",mira,false,https://trello.com/c/Ab12Cd34/12-photograph",
    ",Retire the 2025 lookbook,,Done,Atelier 14 · Editorial,,,chore,,true,https://trello.com/c/Ef56Gh78/13-retire",
  ].join("\n"),

  asana: [
    "Task ID,Created At,Completed At,Name,Section/Column,Assignee,Assignee Email,Start Date,Due Date,Tags,Notes,Projects,Blocked By (Dependencies)",
    "1205993847561234,2026-03-02,,Draft the March newsletter,In Progress,Elena Ruiz,elena@atelier14.demo,2026-03-10,2026-03-18,\"newsletter, copy\",Two sections plus the banner.,Editorial,",
    "1205993847561235,2026-03-03,2026-03-11,Book the studio,Done,Mira Koch,mira@atelier14.demo,,2026-03-12,,,\"Editorial, Ops\",",
  ].join("\n"),

  linear: [
    "ID,Team,Title,Description,Status,Estimate,Priority,Project,Assignee,Labels,Cycle Number,Created,Started,Completed,Canceled,Due Date,Parent issue",
    "ENG-214,Engineering,Split the ledger query,It scans the whole table.,In Progress,3,2,Ledger,elena@atelier14.demo,performance,7,2026-03-04T08:11:00Z,2026-03-09T09:00:00Z,,,2026-03-24,",
    "ENG-215,Engineering,Drop the legacy export,,Canceled,1,4,Ledger,,chore,7,2026-03-05T10:00:00Z,,,2026-03-08T12:00:00Z,,",
  ].join("\n"),

  notion: [
    "Name,Status,Assign,Project,Tags,Priority,Start,Due,Estimate,Notes,Created time,URL",
    "Rewrite the about page,In progress,elena@atelier14.demo,Website,\"copy, web\",High,2026-03-11,2026-03-19,2,Keep the studio photograph.,2026-03-01T09:00:00.000Z,https://www.notion.so/Rewrite-3f2a1b4c5d6e7f8091a2b3c4d5e6f701",
    "Collect client testimonials,Not started,,Website,outreach,Low,,2026-04-02,3,,2026-03-02T11:30:00.000Z,",
  ].join("\n"),

  generic: [
    "externalKey,title,description,status,stream,assigneeEmail,startDate,dueDate,estimate,tags,urgency,impact,effort",
    "OPS-1,Re-key the studio locks,Locksmith booked.,triaged,Operations,elena@atelier14.demo,2026-03-16,2026-03-17,1,facilities,7,6,2",
    "OPS-2,Renew the insurance policy,,backlog,Operations,,,2026-04-30,2,\"admin,finance\",5,8,3",
  ].join("\n"),

  toggl: [
    "User,Email,Client,Project,Task,Description,Billable,Start date,Start time,End date,End time,Duration,Tags",
    "Elena Ruiz,elena@atelier14.demo,Kestrel & Co,Storefront,,[ATL-101] checkout totals,Yes,2026-03-16,09:05:00,2026-03-16,11:35:00,02:30:00,dev",
    "Mira Koch,mira@atelier14.demo,Kestrel & Co,Storefront,,Rework the checkout summary,Yes,2026-03-16,23:30:00,2026-03-17,00:45:00,01:15:00,",
  ].join("\n"),

  clockify: [
    "Project,Client,Description,Task,User,Group,Email,Tags,Billable,Start Date,Start Time,End Date,End Time,Duration (h),Duration (decimal),Billable Rate (USD)",
    "Editorial,Atelier 14,[ATL-102] archive the price list,,Elena Ruiz,,elena@atelier14.demo,,No,2026-03-17,10:00:00,2026-03-17,11:30:00,01:30:00,1.50,0",
    "Editorial,Atelier 14,Draft the March newsletter,,Mira Koch,,mira@atelier14.demo,copy,Yes,2026-03-17,14:15:00,2026-03-17,17:00:00,02:45:00,2.75,90",
  ].join("\n"),

  harvest: [
    "Date,Client,Project,Task,Notes,Hours,Billable?,First Name,Last Name,Email,Project Code,Billable Rate,Cost Rate",
    "2026-03-18,Kestrel & Co,Storefront,Development,[ATL-101] checkout totals,3.25,Yes,Elena,Ruiz,elena@atelier14.demo,STORE,90,60",
    "2026-03-18,Kestrel & Co,Storefront,Design,Rework the checkout summary,1.75,Yes,Mira,Koch,mira@atelier14.demo,STORE,85,55",
  ].join("\n"),
};

function run<T>(source: Source) {
  const parsed = parseCsv(FIXTURES[source]);
  const mapper = mapperFor(source);
  const mapping = mapper.mapping(parsed.columns);
  const rows = parsed.rows.map((row, i) => mapper.normalise(row, mapping, i + 1));
  return { parsed, mapping, rows: rows as { value: T | null; skip: string | null; warnings: string[] }[] };
}

const iso = (d: Date | null) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null);

describe("detection", () => {
  it.each(Object.keys(FIXTURES) as Source[])("recognises a %s export", (source) => {
    const parsed = parseCsv(FIXTURES[source]);
    const detection = detectSource(parsed.columns);
    expect(detection.source).toBe(source);
  });

  it("does not mistake Toggl for Clockify or the other way round", () => {
    const toggl = detectSource(parseCsv(FIXTURES.toggl).columns);
    const clockify = detectSource(parseCsv(FIXTURES.clockify).columns);
    expect([toggl.source, clockify.source]).toEqual(["toggl", "clockify"]);
    // Toggl steps aside explicitly rather than merely scoring lower.
    expect(clockify.scores.find((s) => s.source === "toggl")!.score).toBe(0);
  });

  it("falls back to generic with low confidence for an unfamiliar header", () => {
    const detection = detectSource(["Thing", "Other thing"]);
    expect(detection.source).toBe("generic");
    expect(detection.confidence).toBeLessThan(0.4);
  });

  it("explains itself through the matched strong headers", () => {
    const detection = detectSource(parseCsv(FIXTURES.jira).columns);
    expect(detection.scores[0].matched).toContain("Issue key");
    expect(detection.confidence).toBeGreaterThan(0.4);
  });

  it("declares every mapper's kind consistently", () => {
    expect(MAPPERS.filter((m) => m.kind === "task").map((m) => m.source).sort()).toEqual(
      ["asana", "generic", "jira", "linear", "notion", "trello"]
    );
    expect(MAPPERS.filter((m) => m.kind === "time").map((m) => m.source).sort()).toEqual(["clockify", "harvest", "toggl"]);
  });
});

describe("jira", () => {
  const { mapping, rows } = run<NormalisedTask>("jira");

  it("maps the columns a Jira export actually has", () => {
    expect(mapping["Issue key"]).toBe("externalKey");
    expect(mapping["Summary"]).toBe("title");
    expect(mapping["Project name"]).toBe("stream");
    expect(mapping["Custom field (Story Points)"]).toBe("estimate");
    expect(mapping["Labels"]).toBe("tags");
    expect(mapping["Labels (2)"]).toBe("tags");
  });

  it("normalises the first issue", () => {
    const task = rows[0].value!;
    expect(task.title).toBe("Rework the checkout summary");
    expect(task.externalKey).toBe("ATL-101");
    expect(task.keySynthesised).toBe(false);
    expect(task.status).toBe("in-progress");
    expect(task.streamName).toBe("Storefront");
    expect(task.description).toContain("Seen on staging, twice.");
    expect(iso(task.dueDate)).toBe("2026-03-20");
    expect(task.estimatedDuration).toBe(3);
    expect(task.assigneeEmail).toBe("elena@atelier14.demo");
    // Highest/High/Medium/Low/Lowest → 9/7/5/3/1, impact 5.
    expect([task.urgency, task.impact]).toEqual([7, 5]);
  });

  it("collects every repeated Labels column into tags", () => {
    expect(rows[0].value!.tags).toEqual(["billing", "regression"]);
  });

  it("reads a Won't Do resolution as wontfix rather than completed", () => {
    expect(rows[1].value!.status).toBe("wontfix");
    expect(rows[1].warnings.join(" ")).toMatch(/wontfix/);
    expect(rows[1].value!.urgency).toBe(1);
  });

  it("reads Original Estimate as seconds when that is the estimate column", () => {
    const csv = "Issue key,Summary,Status,Original Estimate\nATL-9,Thing,To Do,28800";
    const parsed = parseCsv(csv);
    const m = mapperFor("jira");
    const task = m.normalise(parsed.rows[0], m.mapping(parsed.columns), 1).value as NormalisedTask;
    expect(task.estimatedDuration).toBe(1); // 28 800 s = 8 h = one working day
    expect(task.status).toBe("triaged");
  });
});

describe("trello", () => {
  const { mapping, rows } = run<NormalisedTask>("trello");

  it("uses the board as the stream and the list as the status", () => {
    expect(mapping["Board Name"]).toBe("stream");
    expect(mapping["List Name"]).toBe("status");
    const task = rows[0].value!;
    expect(task.streamName).toBe("Atelier 14 · Editorial");
    expect(task.status).toBe("in-progress");
    expect(task.tags).toEqual(["photography", "spring"]);
    expect(iso(task.startDate)).toBe("2026-03-16");
  });

  it("falls back to the short link when Card ID is empty", () => {
    expect(rows[1].value!.externalKey).toBe("Ef56Gh78");
  });

  it("files an archived card as wontfix whatever list it was in", () => {
    expect(rows[1].value!.status).toBe("wontfix");
    expect(rows[1].warnings.join(" ")).toMatch(/archived/);
  });

  it("leaves a non-email member unassigned and says so", () => {
    expect(rows[0].value!.assigneeEmail).toBeNull();
    expect(rows[0].warnings.join(" ")).toMatch(/not an e-mail/);
  });
});

describe("asana", () => {
  const { rows } = run<NormalisedTask>("asana");

  it("reads the section as the workflow step", () => {
    expect(rows[0].value!.status).toBe("in-progress");
    expect(rows[0].value!.tags).toEqual(["newsletter", "copy"]);
  });

  it("lets Completed At settle completion", () => {
    expect(rows[1].value!.status).toBe("completed");
  });

  it("takes the first of several projects as the stream", () => {
    expect(rows[1].value!.streamName).toBe("Editorial");
  });

  it("does not read a Done section as completed when the task is still open", () => {
    const csv = "Task ID,Name,Section/Column,Completed At\n7,Ship it,Done,";
    const parsed = parseCsv(csv);
    const m = mapperFor("asana");
    const result = m.normalise(parsed.rows[0], m.mapping(parsed.columns), 1);
    expect((result.value as NormalisedTask).status).toBe("in-progress");
    expect(result.warnings.join(" ")).toMatch(/not completed in Asana/);
  });
});

describe("linear", () => {
  const { rows } = run<NormalisedTask>("linear");

  it("reads the 1–4 priority scale the right way round", () => {
    expect(rows[0].value!.urgency).toBe(7); // 2 = High
    expect(rows[1].value!.urgency).toBe(3); // 4 = Low
  });

  it("uses Project over Team as the stream and points as days", () => {
    expect(rows[0].value!.streamName).toBe("Ledger");
    expect(rows[0].value!.estimatedDuration).toBe(3);
    expect(rows[0].value!.externalKey).toBe("ENG-214");
    expect(iso(rows[0].value!.startDate)).toBe("2026-03-09");
  });

  it("maps Canceled to wontfix", () => {
    expect(rows[1].value!.status).toBe("wontfix");
  });
});

describe("notion", () => {
  const { rows } = run<NormalisedTask>("notion");

  it("maps Name, Status and the select property", () => {
    const task = rows[0].value!;
    expect(task.title).toBe("Rewrite the about page");
    expect(task.status).toBe("in-progress");
    expect(task.streamName).toBe("Website");
    expect(task.urgency).toBe(7);
    expect(task.tags).toEqual(["copy", "web"]);
  });

  it("takes the page id out of the URL when there is no id column", () => {
    expect(rows[0].value!.externalKey).toBe("3f2a1b4c5d6e7f8091a2b3c4d5e6f701");
    expect(rows[0].value!.keySynthesised).toBe(false);
  });

  it("hashes title + created when the row has no id at all", () => {
    const task = rows[1].value!;
    expect(task.keySynthesised).toBe(true);
    expect(task.externalKey).toMatch(/^notion-[0-9a-f]{16}$/);
    expect(task.status).toBe("backlog");
  });

  it("derives the same key twice for the same row", () => {
    const again = run<NormalisedTask>("notion");
    expect(again.rows[1].value!.externalKey).toBe(rows[1].value!.externalKey);
  });
});

describe("generic", () => {
  const { rows } = run<NormalisedTask>("generic");

  it("honours explicit urgency/impact/effort columns", () => {
    expect([rows[0].value!.urgency, rows[0].value!.impact, rows[0].value!.effort]).toEqual([7, 6, 2]);
  });

  it("accepts PTD's own status words", () => {
    expect(rows[0].value!.status).toBe("triaged");
    expect(rows[1].value!.status).toBe("backlog");
  });

  it("matches loosely named columns", () => {
    const parsed = parseCsv("Ticket Summary,Current State,Target Due,Owner Email\nDo the thing,Doing,2026-05-01,ada@x.io");
    const m = mapperFor("generic");
    const mapping = m.mapping(parsed.columns);
    expect(mapping["Ticket Summary"]).toBe("title");
    expect(mapping["Current State"]).toBe("status");
    expect(mapping["Target Due"]).toBe("dueDate");
    const task = m.normalise(parsed.rows[0], mapping, 1).value as NormalisedTask;
    expect(task.assigneeEmail).toBe("ada@x.io");
    expect(task.status).toBe("in-progress");
  });

  it("skips a row with no title", () => {
    const parsed = parseCsv("title,status\n,backlog");
    const m = mapperFor("generic");
    expect(m.normalise(parsed.rows[0], m.mapping(parsed.columns), 1).skip).toBe("no title");
  });
});

describe("toggl", () => {
  const { mapping, rows } = run<NormalisedEntry>("toggl");

  it("maps client to customer and project to stream", () => {
    expect(mapping["Client"]).toBe("customer");
    expect(mapping["Project"]).toBe("stream");
    const entry = rows[0].value!;
    expect(entry.userEmail).toBe("elena@atelier14.demo");
    expect(entry.customerName).toBe("Kestrel & Co");
    expect(entry.streamName).toBe("Storefront");
    expect(entry.checkIn.getHours()).toBe(9);
    expect(entry.checkOut.getTime() - entry.checkIn.getTime()).toBe(150 * 60_000);
    expect(entry.taskRef).toBe("[ATL-101] checkout totals");
  });

  it("handles a session that crosses midnight", () => {
    const entry = rows[1].value!;
    expect(entry.checkOut.getTime() - entry.checkIn.getTime()).toBe(75 * 60_000);
    expect(entry.checkOut.getDate()).toBe(17);
  });

  it("skips an entry longer than 24 hours", () => {
    const csv = "Email,Project,Description,Start date,Start time,End date,End time,Duration\nada@x.io,P,long,2026-03-01,08:00:00,2026-03-02,09:00:00,25:00:00";
    const parsed = parseCsv(csv);
    const m = mapperFor("toggl");
    const result = m.normalise(parsed.rows[0], m.mapping(parsed.columns), 1);
    expect(result.value).toBeNull();
    expect(result.skip).toMatch(/longer than the 24h/);
  });

  it("skips an entry whose end precedes its start with no usable duration", () => {
    const csv = "Email,Project,Description,Start date,Start time,End date,End time,Duration\nada@x.io,P,back,2026-03-02,10:00:00,2026-03-01,09:00:00,";
    const parsed = parseCsv(csv);
    const m = mapperFor("toggl");
    const result = m.normalise(parsed.rows[0], m.mapping(parsed.columns), 1);
    expect(result.value).toBeNull();
    expect(result.skip).toMatch(/is before start/);
  });
});

describe("clockify", () => {
  const { mapping, rows } = run<NormalisedEntry>("clockify");

  it("prefers the hh:mm:ss duration column", () => {
    expect(mapping["Duration (h)"]).toBe("duration");
    expect(rows[0].value!.checkOut.getTime() - rows[0].value!.checkIn.getTime()).toBe(90 * 60_000);
    expect(rows[1].value!.checkOut.getTime() - rows[1].value!.checkIn.getTime()).toBe(165 * 60_000);
  });

  it("falls back to the decimal duration when the clock column is absent", () => {
    const csv = "Project,Email,Description,Start Date,Start Time,Duration (decimal)\nP,ada@x.io,thing,2026-03-01,08:00:00,2.5";
    const parsed = parseCsv(csv);
    const m = mapperFor("clockify");
    const entry = m.normalise(parsed.rows[0], m.mapping(parsed.columns), 1).value as NormalisedEntry;
    expect(entry.checkOut.getTime() - entry.checkIn.getTime()).toBe(150 * 60_000);
  });
});

describe("harvest", () => {
  const { rows } = run<NormalisedEntry>("harvest");

  it("turns a date plus decimal hours into an interval and warns about the clock", () => {
    const entry = rows[0].value!;
    expect(entry.checkIn.getHours()).toBe(9);
    expect(entry.checkOut.getTime() - entry.checkIn.getTime()).toBe(195 * 60_000); // 3.25 h
    expect(rows[0].warnings.join(" ")).toMatch(/no clock time/);
  });

  it("keeps the notes as the task reference, not the billing task", () => {
    expect(rows[0].value!.taskRef).toBe("[ATL-101] checkout totals");
    expect(rows[1].value!.taskRef).toBe("Rework the checkout summary");
  });

  it("joins the first and last name", () => {
    expect(rows[0].value!.userName).toBe("Elena Ruiz");
  });
});

describe("templates", () => {
  it.each(MAPPERS.map((m) => m.source))("round-trips the %s template through its own mapper", (source) => {
    const mapper = mapperFor(source);
    const grid = mapper.template();
    const text = grid.map((r) => r.map((c) => (String(c).includes(",") ? `"${c}"` : c)).join(",")).join("\r\n");
    const parsed = parseCsv(text);
    // parseCsv de-duplicates a repeated header (Jira's several `Labels`), so the
    // comparison is against the base names rather than the literal header row.
    expect(parsed.columns.map((c) => c.replace(/ \(\d+\)$/, ""))).toEqual(grid[0]);
    const detection = detectSource(parsed.columns);
    expect(detection.source).toBe(source);
    const mapping = mapper.mapping(parsed.columns);
    for (const row of parsed.rows) {
      expect(mapper.normalise(row, mapping, 1).value).not.toBeNull();
    }
  });
});
