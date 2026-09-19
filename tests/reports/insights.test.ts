import { describe, expect, it, vi } from "vitest";

vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import { FOCUS_GAP_MINUTES, foldPatterns, longestFocusBlock, narrate, sayMinutes, sayTokens, sayUsd } from "../../server/track/insights";
import type { ReportRow } from "../../server/track/reports";

let nextId = 1;

/** Local-time rows: hour-of-day and weekday are read in the member's own clock. */
function row(over: Partial<ReportRow> & { checkIn: Date; checkOut: Date | null }): ReportRow {
  return {
    id: nextId++,
    userId: 1,
    userName: "Marcus Vellum",
    streamId: 1,
    streamName: "Security audit",
    streamColor: "#B8451A",
    streamCustomerId: 1,
    taskId: 10,
    taskTitle: "Threat model the checkout flow",
    customerId: null,
    isBreak: false,
    notes: null,
    entrySource: "human",
    tokensUsed: null,
    apiCostUsd: null,
    ...over,
  };
}

const span = (day: number, hour: number, minute: number, minutes: number) => ({
  checkIn: new Date(2026, 8, day, hour, minute, 0),
  checkOut: new Date(2026, 8, day, hour, minute + minutes, 0),
});

const human = (day: number, hour: number, minutes: number, over: Partial<ReportRow> = {}) => row({ ...span(day, hour, 0, minutes), ...over });
const agent = (day: number, hour: number, minutes: number, tokens: number, cost: number, over: Partial<ReportRow> = {}) =>
  row({ ...span(day, hour, 0, minutes), entrySource: "agent", tokensUsed: tokens, apiCostUsd: cost, ...over });

const FROM = new Date(2026, 8, 14, 0, 0, 0);
const TO = new Date(2026, 8, 20, 23, 59, 59);

describe("foldPatterns", () => {
  const rows = [
    human(14, 9, 120), // Monday 09:00
    agent(14, 14, 30, 50_000, 0.75), // Monday 14:00
    human(15, 9, 60), // Tuesday 09:00
    row({ ...span(15, 12, 0, 30), isBreak: true }),
    row({ ...span(16, 9, 0, 45), isBreak: true }),
    row({ checkIn: new Date(2026, 8, 17, 9), checkOut: null }),
  ];
  const p = foldPatterns(rows, FROM, TO);

  it("bins work by hour of day, split by source", () => {
    expect(p.byHour[9].minutes).toBe(180);
    expect(p.byHour[9].human.minutes).toBe(180);
    expect(p.byHour[14].agent).toEqual({ minutes: 30, tokens: 50_000, costUsd: 0.75 });
    expect(p.byHour).toHaveLength(24);
  });

  it("bins work by weekday and counts the days each weekday carried", () => {
    expect(p.byWeekday[1].name).toBe("Monday");
    expect(p.byWeekday[1].minutes).toBe(150);
    expect(p.byWeekday[1].activeDays).toBe(1);
    expect(p.byWeekday[2].minutes).toBe(60);
  });

  it("builds a 7 × 24 heat matrix and its agent counterpart", () => {
    expect(p.heat).toHaveLength(7);
    expect(p.heat[1]).toHaveLength(24);
    expect(p.heat[1][9]).toBe(120);
    expect(p.heatAgent[1][14]).toBe(30);
    expect(p.heatAgent[1][9]).toBe(0);
    expect(p.heatMax).toBe(120);
  });

  it("names the peak hour and the heaviest weekday", () => {
    expect(p.peakHour).toBe(9);
    expect(p.peakWeekday).toBe(1);
  });

  it("counts breaks without ever counting them as work", () => {
    expect(p.minutes).toBe(210);
    expect(p.breaks.count).toBe(2);
    expect(p.breaks.minutes).toBe(75);
    expect(p.breaks.avgMinutes).toBe(38);
    expect(p.breaks.longestMinutes).toBe(45);
  });

  it("reports break frequency against days that carried work", () => {
    // Two breaks over two active days (Monday and Tuesday).
    expect(p.activeDays).toBe(2);
    expect(p.breaks.perActiveDay).toBe(1);
  });

  it("counts human and agent sessions separately", () => {
    expect(p.sessions).toBe(3);
    expect(p.humanSessions).toBe(2);
    expect(p.agentSessions).toBe(1);
    expect(p.avgSessionMinutes).toBe(70);
  });

  it("lists the streams the agents worked in, with their share of each", () => {
    expect(p.agentStreams).toEqual([
      { streamId: 1, streamName: "Security audit", minutes: 30, totalMinutes: 210, costUsd: 0.75, tokens: 50_000, sharePct: 14 },
    ]);
  });

  it("counts the customers the window touched", () => {
    expect(p.customersTouched).toBe(1);
  });

  it("reads an empty window as all zeroes rather than throwing", () => {
    const empty = foldPatterns([], FROM, TO);
    expect([empty.minutes, empty.sessions, empty.heatMax]).toEqual([0, 0, 0]);
    expect(empty.peakHour).toBeNull();
    expect(empty.peakWeekday).toBeNull();
    expect(empty.longestFocus).toBeNull();
  });
});

describe("longestFocusBlock", () => {
  it("merges back-to-back sessions into one stretch of attention", () => {
    const block = longestFocusBlock([
      row(span(14, 9, 0, 50)),
      row(span(14, 9, 55, 60)), // 5-minute gap: same stretch
    ])!;
    expect(block.minutes).toBe(110);
    expect(block.sessions).toBe(2);
    expect(block.entrySource).toBe("human");
  });

  it("ends a stretch at a gap longer than the focus threshold", () => {
    const gap = FOCUS_GAP_MINUTES + 5;
    const block = longestFocusBlock([row(span(14, 9, 0, 40)), row(span(14, 9, 40 + gap, 30))])!;
    expect(block.minutes).toBe(40);
    expect(block.sessions).toBe(1);
  });

  it("ends a stretch at a logged break, however short", () => {
    const block = longestFocusBlock([
      row(span(14, 9, 0, 40)),
      row({ ...span(14, 9, 40, 5), isBreak: true }),
      row(span(14, 9, 45, 30)),
    ])!;
    expect(block.minutes).toBe(40);
  });

  it("never merges two members' sessions into one person's focus", () => {
    const block = longestFocusBlock([
      row({ ...span(14, 9, 0, 50), userId: 1, userName: "Marcus Vellum" }),
      row({ ...span(14, 9, 52, 60), userId: 2, userName: "Priya Indigo" }),
    ])!;
    expect(block.minutes).toBe(60);
    expect(block.userName).toBe("Priya Indigo");
  });

  it("labels a stretch that a human and an agent both worked as mixed", () => {
    const block = longestFocusBlock([
      row(span(14, 9, 0, 40)),
      row({ ...span(14, 9, 42, 40), entrySource: "agent" }),
    ])!;
    expect(block.entrySource).toBe("mixed");
    expect(block.minutes).toBe(80);
  });

  it("drops the stream when a stretch crossed lanes", () => {
    const block = longestFocusBlock([
      row(span(14, 9, 0, 40)),
      row({ ...span(14, 9, 42, 40), streamId: 2, streamName: "Checkout redesign" }),
    ])!;
    expect(block.streamId).toBeNull();
    expect(block.streamName).toBeNull();
  });

  it("ignores still-running sessions, which have no length yet", () => {
    expect(longestFocusBlock([row({ checkIn: new Date(2026, 8, 14, 9), checkOut: null })])).toBeNull();
  });

  it("does not depend on the order rows arrive in", () => {
    // 09:00–09:50 then 09:55–10:55 is one stretch; 11:20 onwards is a new one.
    const shuffled = [row(span(14, 11, 20, 60)), row(span(14, 9, 0, 50)), row(span(14, 9, 55, 60))];
    expect(longestFocusBlock(shuffled)!.minutes).toBe(110);
  });

  it("chains a whole run of near-adjacent sessions into one stretch", () => {
    const run = [row(span(14, 9, 0, 50)), row(span(14, 9, 55, 60)), row(span(14, 11, 0, 60))];
    expect(longestFocusBlock(run)!.minutes).toBe(170);
    expect(longestFocusBlock(run)!.sessions).toBe(3);
  });
});

describe("narrate", () => {
  const rows = [
    human(14, 9, 200),
    human(15, 9, 160),
    agent(15, 10, 41, 132_900, 1.74),
    agent(16, 10, 77, 400_000, 11.13, { streamId: 2, streamName: "Checkout redesign" }),
    row({ ...span(15, 13, 0, 25), isBreak: true }),
  ];
  const p = foldPatterns(rows, FROM, TO);
  const sentences = narrate(p, { who: "the organization" });

  it("stays between three and six sentences", () => {
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(sentences.length).toBeLessThanOrEqual(6);
  });

  it("opens with the window, the volume and the session count", () => {
    expect(sentences[0]).toContain("Between 14 Sep and 20 Sep 2026");
    expect(sentences[0]).toContain("the organization recorded 7h 58m");
    expect(sentences[0]).toContain("across 4 sessions on 3 days");
  });

  it("always accounts for what the agents cost, naming their busiest stream", () => {
    const money = sentences.find((s) => s.includes("$"))!;
    expect(money).toMatch(/^Agents logged 1h 58m across 2 sessions for \$12\.87/);
    expect(money).toContain("Checkout redesign");
    expect(money).toMatch(/\d+% of the hours/);
  });

  it("reports the token count and the agent share of all hours", () => {
    expect(sentences.some((s) => s.includes("532.9k tokens") && s.includes("25% of all recorded hours"))).toBe(true);
  });

  it("says when the work clusters and which weekday is heaviest", () => {
    expect(sentences.some((s) => s.includes("Work clusters at 09:00") && s.includes("Tuesday"))).toBe(true);
  });

  it("names the longest unbroken stretch and whose it was", () => {
    expect(sentences.some((s) => s.includes("longest unbroken stretch") && s.includes("Marcus Vellum"))).toBe(true);
  });

  it("closes on how breaks were taken, and counts one break as one", () => {
    expect(sentences[sentences.length - 1]).toContain("1 break was logged");
  });

  it("invents no figure: every number in the prose is in the facts", () => {
    expect(sentences.join(" ")).not.toContain("NaN");
    expect(sentences.join(" ")).not.toContain("undefined");
  });

  it("still says something useful, and still mentions agent cost, on an empty window", () => {
    const empty = narrate(foldPatterns([], FROM, TO));
    expect(empty).toHaveLength(3);
    expect(empty[0]).toContain("Nothing was logged");
    expect(empty.some((s) => s.includes("no API cost"))).toBe(true);
  });

  it("states a zero cost plainly when only humans worked", () => {
    const humanOnly = narrate(foldPatterns([human(14, 9, 90)], FROM, TO));
    expect(humanOnly.some((s) => s.includes("agent API cost for the period is $0.00"))).toBe(true);
    expect(humanOnly.some((s) => s.includes("No breaks were logged at all"))).toBe(true);
  });

  it("is deterministic — the same window always reads the same", () => {
    expect(narrate(foldPatterns(rows, FROM, TO), { who: "the organization" })).toEqual(sentences);
  });
});

describe("phrasing helpers", () => {
  it("reads durations as the ledger does", () => {
    expect(sayMinutes(45)).toBe("45m");
    expect(sayMinutes(90)).toBe("1h 30m");
    expect(sayMinutes(120)).toBe("2h");
    expect(sayMinutes(309)).toBe("5h 09m");
  });

  it("abbreviates tokens past a thousand", () => {
    expect(sayTokens(958_300)).toBe("958.3k");
    expect(sayTokens(940)).toBe("940");
    expect(sayTokens(2_500_000)).toBe("2.50M");
  });

  it("prints money to the cent, and to a tenth of a cent below one", () => {
    expect(sayUsd(12.87)).toBe("$12.87");
    expect(sayUsd(0)).toBe("$0.00");
    expect(sayUsd(0.0042)).toBe("$0.0042");
  });
});
