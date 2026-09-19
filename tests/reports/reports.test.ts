import { describe, expect, it, vi } from "vitest";

// Nothing here queries, but importing the module pulls in the drizzle client,
// which would demand a DATABASE_URL. The fold is what is under test.
vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import {
  bucketKey,
  bucketLabel,
  compareRanges,
  customerOf,
  enumerateBuckets,
  escapeLike,
  foldCustomerGoals,
  foldRange,
  metricsOf,
  pctChange,
  rowSeconds,
  trendFor,
  type ReportRow,
} from "../../server/track/reports";

/**
 * Rows are built in local time on purpose: the whole point of folding buckets in
 * JS is that a session belongs to the *member's* day, so a test that used UTC
 * would be testing the wrong thing.
 */
const at = (day: number, hour: number, minutes: number): { checkIn: Date; checkOut: Date } => ({
  checkIn: new Date(2026, 8, day, hour, 0, 0),
  checkOut: new Date(2026, 8, day, hour, minutes, 0),
});

let nextId = 1;

function row(over: Partial<ReportRow> & { checkIn: Date; checkOut: Date | null }): ReportRow {
  return {
    id: nextId++,
    userId: 1,
    userName: "Marcus Vellum",
    streamId: 1,
    streamName: "Security audit",
    streamColor: "#B8451A",
    streamCustomerId: null,
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

const human = (day: number, hour: number, minutes: number, over: Partial<ReportRow> = {}) => row({ ...at(day, hour, minutes), ...over });

const agent = (day: number, hour: number, minutes: number, tokens: number, cost: number, over: Partial<ReportRow> = {}) =>
  row({ ...at(day, hour, minutes), entrySource: "agent", tokensUsed: tokens, apiCostUsd: cost, ...over });

const win = { from: new Date(2026, 8, 14, 0, 0, 0), to: new Date(2026, 8, 20, 23, 59, 59) };

describe("rowSeconds", () => {
  it("measures a closed session and ignores an open one", () => {
    expect(rowSeconds(human(14, 9, 90))).toBe(5400);
    expect(rowSeconds(row({ checkIn: new Date(2026, 8, 14, 9), checkOut: null }))).toBe(0);
  });

  it("never returns a negative duration for a reversed row", () => {
    expect(rowSeconds(row({ checkIn: new Date(2026, 8, 14, 10), checkOut: new Date(2026, 8, 14, 9) }))).toBe(0);
  });
});

describe("bucket keys and labels", () => {
  const monday = new Date(2026, 8, 14, 9, 0);
  const thursday = new Date(2026, 8, 17, 23, 30);

  it("keys a day by its local date", () => {
    expect(bucketKey(thursday, "day")).toBe("2026-09-17");
  });

  it("keys a week by its Monday, so a Thursday and the Monday before it agree", () => {
    expect(bucketKey(thursday, "week")).toBe("2026-09-14");
    expect(bucketKey(monday, "week")).toBe("2026-09-14");
  });

  it("keys a month by year and month only", () => {
    expect(bucketKey(thursday, "month")).toBe("2026-09");
  });

  it("labels each grain the way the chart axis prints it", () => {
    expect(bucketLabel(thursday, "day")).toBe("Thu 17 Sep");
    expect(bucketLabel(thursday, "week")).toBe("w/c 14 Sep");
    expect(bucketLabel(thursday, "month")).toBe("Sep 2026");
  });
});

describe("enumerateBuckets", () => {
  it("emits every day in the window, idle ones included", () => {
    expect(enumerateBuckets(win.from, win.to, "day")).toHaveLength(7);
  });

  it("emits one bucket per week and per month", () => {
    expect(enumerateBuckets(win.from, win.to, "week")).toHaveLength(1);
    expect(enumerateBuckets(new Date(2026, 6, 1), new Date(2026, 8, 30), "month")).toHaveLength(3);
  });

  it("gives up on a skeleton past MAX_BUCKETS rather than emit thousands", () => {
    expect(enumerateBuckets(new Date(2020, 0, 1), new Date(2026, 0, 1), "day")).toEqual([]);
  });

  it("returns nothing when the window is inverted", () => {
    expect(enumerateBuckets(win.to, win.from, "day")).toEqual([]);
  });
});

describe("foldRange", () => {
  const rows = [
    human(14, 9, 200),
    agent(14, 10, 29, 74_100, 1.1),
    human(15, 9, 160, { streamId: 2, streamName: "Checkout redesign", streamColor: "#1A1510" }),
    agent(15, 9, 41, 132_900, 1.74),
    row({ ...at(15, 13, 30), isBreak: true }),
    row({ checkIn: new Date(2026, 8, 16, 9), checkOut: null }),
  ];

  it("splits every bucket human vs agent and carries tokens and cost", () => {
    const r = foldRange(rows, { ...win, groupBy: "day" });
    expect(r.buckets).toHaveLength(7);
    const mon = r.buckets.find((b) => b.key === "2026-09-14")!;
    expect(mon.human.minutes).toBe(200);
    expect(mon.agent).toEqual({ minutes: 29, tokens: 74_100, costUsd: 1.1 });
    expect(mon.minutes).toBe(229);
    expect(mon.sessions).toBe(2);
  });

  it("totals the window and counts only days that carried work", () => {
    const r = foldRange(rows, { ...win, groupBy: "day" });
    expect(r.minutes).toBe(430);
    expect(r.human.minutes).toBe(360);
    expect(r.agent).toEqual({ minutes: 70, tokens: 207_000, costUsd: 2.84 });
    expect(r.sessions).toBe(4);
    expect(r.activeDays).toBe(2);
  });

  it("excludes a still-running session, which has no duration to report", () => {
    const r = foldRange(rows, { ...win, groupBy: "day" });
    expect(r.buckets.find((b) => b.key === "2026-09-16")!.minutes).toBe(0);
  });

  it("never counts a break as work, and only reports break minutes when asked", () => {
    expect(foldRange(rows, { ...win, groupBy: "day" }).breakMinutes).toBe(0);
    const withBreaks = foldRange(rows, { ...win, groupBy: "day", includeBreaks: true });
    expect(withBreaks.breakMinutes).toBe(30);
    expect(withBreaks.minutes).toBe(430);
    expect(withBreaks.sessions).toBe(4);
  });

  it("splits each bucket per stream, busiest first", () => {
    const tue = foldRange(rows, { ...win, groupBy: "day" }).buckets.find((b) => b.key === "2026-09-15")!;
    expect(tue.byStream.map((s) => [s.streamName, s.minutes])).toEqual([
      ["Checkout redesign", 160],
      ["Security audit", 41],
    ]);
  });

  it("rolls the whole window into one bucket when grouped by week", () => {
    const r = foldRange(rows, { ...win, groupBy: "week" });
    expect(r.buckets).toHaveLength(1);
    expect(r.buckets[0].key).toBe("2026-09-14");
    expect(r.buckets[0].minutes).toBe(430);
    expect(r.byStream.map((s) => s.streamName)).toEqual(["Security audit", "Checkout redesign"]);
  });

  it("keeps time logged without a stream visible under a null key", () => {
    const r = foldRange([human(14, 9, 60, { streamId: null, streamName: null, streamColor: null })], { ...win, groupBy: "day" });
    expect(r.byStream).toEqual([
      { streamId: null, streamName: null, streamColor: null, sessions: 1, minutes: 60, human: { minutes: 60 }, agent: { minutes: 0, tokens: 0, costUsd: 0 } },
    ]);
  });

  it("returns an all-zero report with a full skeleton when nothing was logged", () => {
    const r = foldRange([], { ...win, groupBy: "day" });
    expect(r.minutes).toBe(0);
    expect(r.buckets).toHaveLength(7);
    expect(r.buckets.every((b) => b.minutes === 0)).toBe(true);
    expect(r.byStream).toEqual([]);
  });

  it("rounds once at the end, so short sessions do not each lose half a minute", () => {
    const shorties = Array.from({ length: 4 }, (_, i) =>
      row({ checkIn: new Date(2026, 8, 14, 9, i * 2, 0), checkOut: new Date(2026, 8, 14, 9, i * 2, 50) })
    );
    // 4 × 50s = 200s = 3.33 min, which rounds to 3 — not to 4 × round(0.83) = 4.
    expect(foldRange(shorties, { ...win, groupBy: "day" }).minutes).toBe(3);
  });

  it("buckets a row that falls outside the enumerated skeleton rather than dropping it", () => {
    const r = foldRange([human(1, 9, 60)], { ...win, groupBy: "day" });
    expect(r.minutes).toBe(60);
    expect(r.buckets.some((b) => b.key === "2026-09-01")).toBe(true);
  });
});

describe("pctChange", () => {
  it("is a percentage of the previous period", () => {
    expect(pctChange(120, 100)).toBe(20);
    expect(pctChange(50, 100)).toBe(-50);
  });

  it("pins growth from nothing at 100% instead of infinity", () => {
    expect(pctChange(90, 0)).toBe(100);
    expect(pctChange(0, 0)).toBe(0);
  });
});

describe("trendFor", () => {
  it("treats more hours as the good direction", () => {
    const t = trendFor("minutes", 500, 400);
    expect([t.direction, t.arrow, t.better]).toEqual(["up", "↑", true]);
  });

  it("treats more agent spend as the direction to watch", () => {
    expect(trendFor("agentCostUsd", 12.87, 4).better).toBe(false);
    expect(trendFor("agentCostUsd", 4, 12.87).better).toBe(true);
  });

  it("treats fewer breaks as an improvement in the recess line, as TTM's card did", () => {
    expect(trendFor("breakMinutes", 20, 60).better).toBe(true);
  });

  it("reports no movement as flat, and flat is never bad news", () => {
    const t = trendFor("agentCostUsd", 5, 5);
    expect([t.direction, t.arrow, t.better, t.pct]).toEqual(["flat", "→", true, 0]);
  });
});

describe("compareRanges", () => {
  const current = foldRange([human(14, 9, 200), agent(14, 10, 60, 100_000, 2)], { ...win, groupBy: "day" });
  const previous = foldRange([human(7, 9, 100)], { from: new Date(2026, 8, 7), to: new Date(2026, 8, 13, 23, 59), groupBy: "day" });

  it("hands back both reports untouched", () => {
    const c = compareRanges(current, previous);
    expect(c.current.minutes).toBe(260);
    expect(c.previous.minutes).toBe(100);
  });

  it("computes a delta and a percent for every compared metric", () => {
    const c = compareRanges(current, previous);
    expect(c.delta.minutes).toBe(160);
    expect(c.delta.agentCostUsd).toBe(2);
    expect(c.deltaPct.minutes).toBe(160);
    expect(c.deltaPct.agentMinutes).toBe(100);
    expect(Object.keys(c.trend)).toHaveLength(8);
  });

  it("marks agent cost appearing out of nowhere as worth watching", () => {
    expect(compareRanges(current, previous).trend.agentCostUsd.better).toBe(false);
  });
});

describe("metricsOf", () => {
  it("flattens a report into the eight compared numbers", () => {
    const r = foldRange([agent(14, 9, 30, 1000, 0.5)], { ...win, groupBy: "day" });
    expect(metricsOf(r)).toEqual({
      minutes: 30,
      humanMinutes: 0,
      agentMinutes: 30,
      agentTokens: 1000,
      agentCostUsd: 0.5,
      sessions: 1,
      activeDays: 1,
      breakMinutes: 0,
    });
  });
});

describe("escapeLike", () => {
  it("keeps a wildcard typed by a reader literal", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("c:\\work")).toBe("c:\\\\work");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeLike("csrf middleware")).toBe("csrf middleware");
  });
});

describe("customerOf", () => {
  it("bills through the stream when the session has one", () => {
    expect(customerOf(human(14, 9, 60, { streamId: 3, streamCustomerId: 9, customerId: 4 }))).toBe(9);
  });

  it("falls back to the session's own customer when it has no stream", () => {
    expect(customerOf(human(14, 9, 60, { streamId: null, streamCustomerId: null, customerId: 4 }))).toBe(4);
  });

  it("is unattributed when neither says anything", () => {
    expect(customerOf(human(14, 9, 60, { streamId: null, streamCustomerId: null, customerId: null }))).toBeNull();
  });
});

describe("foldCustomerGoals", () => {
  const streams = [
    { id: 1, name: "Security audit", customerId: 1 },
    { id: 2, name: "Checkout redesign", customerId: 1 },
    { id: 4, name: "API v2", customerId: 2 },
  ];
  const customers = [
    { id: 1, name: "Maison Corbeau", weeklyGoalHours: 20 },
    { id: 2, name: "Verso Press", weeklyGoalHours: 6 },
    { id: 3, name: "No Work Ltd", weeklyGoalHours: 4 },
  ];
  const rows = [
    human(14, 9, 300, { streamId: 1, streamName: "Security audit", streamCustomerId: 1 }),
    agent(15, 9, 60, 10_000, 1.5, { streamId: 2, streamName: "Checkout redesign", streamCustomerId: 1 }),
    human(15, 11, 360, { streamId: 4, streamName: "API v2", streamCustomerId: 2 }),
    row({ ...at(16, 13, 30), isBreak: true, streamId: 1, streamCustomerId: 1 }),
  ];

  it("measures each customer against its weekly goal", () => {
    const goals = foldCustomerGoals(rows, customers, streams);
    const corbeau = goals.find((g) => g.customerId === 1)!;
    expect(corbeau.minutes).toBe(360);
    expect(corbeau.goalMinutes).toBe(1200);
    expect(corbeau.pct).toBe(30);
    expect(corbeau.remainingMinutes).toBe(840);
    expect(corbeau.met).toBe(false);
  });

  it("marks a fulfilled pledge", () => {
    const verso = foldCustomerGoals(rows, customers, streams).find((g) => g.customerId === 2)!;
    expect(verso.minutes).toBe(360);
    expect(verso.met).toBe(true);
  });

  it("keeps the human/agent split per customer", () => {
    const corbeau = foldCustomerGoals(rows, customers, streams).find((g) => g.customerId === 1)!;
    expect(corbeau.human.minutes).toBe(300);
    expect(corbeau.agent).toEqual({ minutes: 60, tokens: 10_000, costUsd: 1.5 });
  });

  it("never counts a break towards a billable pledge", () => {
    expect(foldCustomerGoals(rows, customers, streams).find((g) => g.customerId === 1)!.sessions).toBe(2);
  });

  it("still lists a customer nobody worked for, at zero", () => {
    const idle = foldCustomerGoals(rows, customers, streams).find((g) => g.customerId === 3)!;
    expect([idle.minutes, idle.pct, idle.met]).toEqual([0, 0, false]);
  });

  it("breaks each customer down by stream", () => {
    const corbeau = foldCustomerGoals(rows, customers, streams).find((g) => g.customerId === 1)!;
    expect(corbeau.streams).toEqual([
      { streamId: 1, name: "Security audit", minutes: 300 },
      { streamId: 2, name: "Checkout redesign", minutes: 60 },
    ]);
  });

  it("orders by how close each account is to its target", () => {
    expect(foldCustomerGoals(rows, customers, streams).map((g) => g.name)).toEqual(["Verso Press", "Maison Corbeau", "No Work Ltd"]);
  });
});
