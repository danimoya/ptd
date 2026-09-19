import { describe, expect, it, vi } from "vitest";

// server/ical.ts pulls in the drizzle client for the route; the calendar builder
// itself is pure, so the tests below never touch it.
vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import {
  buildCalendar,
  contentLine,
  escapeText,
  eventRange,
  eventSummary,
  foldLine,
  icalDay,
  icalPath,
  icalStamp,
  type IcalTask,
} from "../../server/ical";

const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};

const task = (over: Partial<IcalTask> = {}): IcalTask => ({
  id: 42,
  title: "Rework the checkout summary",
  status: "in-progress",
  externalKey: "ATL-101",
  startDate: day("2026-03-16"),
  dueDate: day("2026-03-20"),
  estimatedDuration: 5,
  priorityScore: 14,
  tags: ["billing"],
  streamName: "Storefront",
  appName: "Shop",
  assigneeName: "Elena Ruiz",
  updatedAt: new Date(Date.UTC(2026, 2, 17, 9, 30, 0)),
  ...over,
});

/** Split a folded body back into logical lines, the way a parser would. */
const unfold = (body: string) => body.replace(/\r\n[ \t]/g, "").split("\r\n").filter(Boolean);

describe("escapeText", () => {
  it("escapes the backslash before anything else", () => {
    expect(escapeText("a\\b")).toBe("a\\\\b");
    expect(escapeText("a\\;b")).toBe("a\\\\\\;b");
  });

  it("escapes semicolons, commas and newlines", () => {
    expect(escapeText("a;b,c")).toBe("a\\;b\\,c");
    expect(escapeText("one\r\ntwo\nthree")).toBe("one\\ntwo\\nthree");
  });

  it("leaves a colon alone — it is legal inside TEXT", () => {
    expect(escapeText("Stream: Storefront")).toBe("Stream: Storefront");
  });
});

describe("foldLine", () => {
  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("does not fold at exactly 75 octets", () => {
    const line = "X".repeat(75);
    expect(foldLine(line)).toBe(line);
  });

  it("folds at 76 octets with a leading space on the continuation", () => {
    const folded = foldLine("X".repeat(76));
    expect(folded).toBe(`${"X".repeat(75)}\r\n X`);
  });

  it("keeps every folded line within 75 octets, continuation space included", () => {
    const folded = foldLine(`SUMMARY:${"long words ".repeat(40)}`);
    for (const line of folded.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
  });

  it("never splits a multi-byte character across the fold", () => {
    // 40 × 2-octet characters = 80 octets, so the fold lands mid-sequence
    // unless the boundary is walked back.
    const folded = foldLine("é".repeat(40));
    expect(unfold(folded).join("")).toBe("é".repeat(40));
    for (const line of folded.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
  });

  it("round-trips a long unicode value through unfolding", () => {
    const value = `Rework the “checkout” summary — ${"ünïcødé ".repeat(12)}`;
    expect(unfold(foldLine(`SUMMARY:${escapeText(value)}`)).join("")).toBe(`SUMMARY:${escapeText(value)}`);
  });
});

describe("contentLine", () => {
  it("escapes the value but not the parameters", () => {
    expect(contentLine("DTSTART", "20260316", ";VALUE=DATE")).toBe("DTSTART;VALUE=DATE:20260316");
    expect(contentLine("SUMMARY", "a,b")).toBe("SUMMARY:a\\,b");
  });
});

describe("date formatting", () => {
  it("stamps UTC without punctuation", () => {
    expect(icalStamp(new Date(Date.UTC(2026, 2, 19, 14, 0, 0)))).toBe("20260319T140000Z");
  });

  it("uses local calendar parts for an all-day value", () => {
    expect(icalDay(day("2026-03-20"))).toBe("20260320");
    expect(icalDay(new Date(2026, 0, 1))).toBe("20260101");
  });
});

describe("eventRange", () => {
  it("makes DTEND exclusive — the day after the due date", () => {
    const { start, end } = eventRange(task());
    expect(icalDay(start)).toBe("20260316");
    expect(icalDay(end)).toBe("20260321");
  });

  it("gives a due-date-only card a single day", () => {
    const { start, end } = eventRange(task({ startDate: null, dueDate: day("2026-03-20") }));
    expect([icalDay(start), icalDay(end)]).toEqual(["20260320", "20260321"]);
  });

  it("runs a start-date-only card for its estimate", () => {
    const { start, end } = eventRange(task({ startDate: day("2026-03-16"), dueDate: null, estimatedDuration: 3 }));
    expect([icalDay(start), icalDay(end)]).toEqual(["20260316", "20260319"]);
  });

  it("defaults to one day when there is no estimate either", () => {
    const { start, end } = eventRange(task({ startDate: day("2026-03-16"), dueDate: null, estimatedDuration: null }));
    expect([icalDay(start), icalDay(end)]).toEqual(["20260316", "20260317"]);
  });

  it("does not produce a negative span when the due date precedes the start", () => {
    const { start, end } = eventRange(task({ startDate: day("2026-03-20"), dueDate: day("2026-03-16") }));
    expect(new Date(end).getTime()).toBeGreaterThan(new Date(start).getTime());
  });
});

describe("buildCalendar", () => {
  const body = buildCalendar([task()], { orgName: "Atelier 14", base: "https://ptd.example", scope: "org", now: new Date(Date.UTC(2026, 2, 19, 14, 0, 0)) });

  it("uses CRLF everywhere, including the last line", () => {
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(body.split("\n").every((line, i, all) => i === all.length - 1 || line.endsWith("\r"))).toBe(true);
    expect(body).not.toMatch(/[^\r]\n/);
  });

  it("opens and closes the calendar", () => {
    const lines = unfold(body);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("BEGIN:VEVENT");
    expect(lines).toContain("END:VEVENT");
  });

  it("names the calendar after the organization", () => {
    expect(unfold(body)).toContain("X-WR-CALNAME:PTD — Atelier 14");
  });

  it("writes the UID, all-day range, summary and URL the brief specifies", () => {
    const lines = unfold(body);
    expect(lines).toContain("UID:task-42@ptd");
    expect(lines).toContain("DTSTART;VALUE=DATE:20260316");
    expect(lines).toContain("DTEND;VALUE=DATE:20260321");
    expect(lines).toContain("SUMMARY:[ATL-101] Rework the checkout summary");
    expect(lines).toContain("URL:https://ptd.example/plan?task=42");
    expect(lines).toContain("DTSTAMP:20260319T140000Z");
    expect(lines).toContain("LAST-MODIFIED:20260317T093000Z");
  });

  it("puts stream, app, assignee and score in the description", () => {
    const description = unfold(body).find((l) => l.startsWith("DESCRIPTION:"))!;
    expect(description).toContain("Stream: Storefront");
    expect(description).toContain("App: Shop");
    expect(description).toContain("Assignee: Elena Ruiz");
    expect(description).toContain("Priority score: 14");
    // Line breaks inside the value are the escaped form, never real ones.
    expect(description.split("\\n").length).toBeGreaterThan(4);
  });

  it("keeps tasks out of free/busy", () => {
    expect(unfold(body)).toContain("TRANSP:TRANSPARENT");
  });

  it("marks a wontfix card CANCELLED", () => {
    const cancelled = buildCalendar([task({ status: "wontfix" })], { orgName: "A", base: "https://x", scope: "me" });
    expect(unfold(cancelled)).toContain("STATUS:CANCELLED");
  });

  it("falls back to a PTD key when the card has no external key", () => {
    expect(eventSummary(task({ externalKey: null }))).toBe("[PTD-42] Rework the checkout summary");
  });

  it("escapes a comma in the title rather than splitting the value", () => {
    const tricky = buildCalendar([task({ title: "Totals, taxes; and \\fees" })], { orgName: "A", base: "https://x", scope: "me" });
    const summary = unfold(tricky).find((l) => l.startsWith("SUMMARY:"))!;
    expect(summary).toBe("SUMMARY:[ATL-101] Totals\\, taxes\\; and \\\\fees");
  });

  it("emits a valid empty calendar when nothing is scheduled", () => {
    const empty = buildCalendar([], { orgName: "Atelier 14", base: "https://x", scope: "me" });
    expect(unfold(empty)).not.toContain("BEGIN:VEVENT");
    expect(empty.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("folds a long summary and the unfolded value survives intact", () => {
    const title = "Reconcile the ledger against the invoice PDF for every customer in the March close";
    const long = buildCalendar([task({ title })], { orgName: "A", base: "https://x", scope: "me" });
    expect(long).toMatch(/\r\n /); // it really did fold
    expect(unfold(long)).toContain(`SUMMARY:[ATL-101] ${title}`);
    for (const line of long.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
  });
});

describe("icalPath", () => {
  it("appends the org scope only when asked", () => {
    expect(icalPath("ptd_abc", "me")).toBe("/ical/ptd_abc.ics");
    expect(icalPath("ptd_abc", "org")).toBe("/ical/ptd_abc.ics?scope=org");
  });
});
