import { describe, expect, it, vi } from "vitest";

// The fold never touches the database; the modules it lives in do, at import
// time, so the pool is stubbed rather than opened.
vi.mock("../../db", () => ({ db: { execute: async () => [] } }));

import { foldHybrid, median, narrateHybrid, sharePct } from "../../server/overview/hybrid";
import { APPS, AT, BASE, completion, entry, STREAMS, taskCost } from "./fixtures";

/**
 * The fold is the whole feature: every figure the Hybrid tab prints comes out of
 * `foldHybrid`, so these tests are the specification of the dashboard. They run
 * on plain rows with no database anywhere near them.
 */

describe("sharePct", () => {
  it("is a measurement, to one decimal", () => {
    expect(sharePct(1, 3)).toBe(33.3);
    expect(sharePct(309, 1879)).toBe(16.4);
  });

  it("refuses to divide by nothing", () => {
    expect(sharePct(5, 0)).toBe(0);
    expect(sharePct(0, 0)).toBe(0);
  });
});

describe("median", () => {
  it("averages the two middle values on an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1])).toBe(2);
  });

  it("takes the middle one on an odd count, in value order not arrival order", () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  it("is zero for nothing at all", () => {
    expect(median([])).toBe(0);
  });
});

describe("foldHybrid — series", () => {
  it("emits one bucket per day in the window, idle days included", () => {
    const s = foldHybrid({ ...BASE, entries: [entry({ day: 15, minutes: 60 })] });
    expect(s.series).toHaveLength(7);
    expect(s.series.map((b) => b.minutes)).toEqual([0, 60, 0, 0, 0, 0, 0]);
    expect(s.range.buckets).toBe(7);
    expect(s.range.days).toBe(7);
  });

  it("splits each bucket human vs agent and carries the agent's tokens and dollars", () => {
    const s = foldHybrid({
      ...BASE,
      entries: [
        entry({ day: 16, minutes: 120 }),
        entry({ day: 16, minutes: 40, agent: true, tokens: 48_200, cost: 0.61 }),
      ],
    });
    const bucket = s.series.find((b) => b.minutes > 0)!;
    expect(bucket.human.minutes).toBe(120);
    expect(bucket.agent).toEqual({ minutes: 40, tokens: 48_200, costUsd: 0.61 });
    expect(bucket.agentSharePct).toBe(25);
    expect(bucket.sessions).toBe(2);
  });

  it("bins by Monday-started weeks when asked", () => {
    const s = foldHybrid({
      ...BASE,
      groupBy: "week",
      entries: [entry({ day: 14, minutes: 60 }), entry({ day: 20, minutes: 60 })],
    });
    // 14 Sep 2026 is a Monday, 20 Sep the Sunday that closes the same week.
    expect(s.series).toHaveLength(1);
    expect(s.series[0].minutes).toBe(120);
    expect(s.series[0].label).toContain("w/c");
  });

  it("rounds once, at the end, so short sessions do not each lose half a minute", () => {
    const rows = Array.from({ length: 4 }, () => entry({ day: 15, minutes: 0.5 }));
    const s = foldHybrid({ ...BASE, entries: rows });
    expect(s.totals.human.minutes).toBe(2);
  });

  it("drops rows with no duration rather than counting them as sessions", () => {
    const s = foldHybrid({ ...BASE, entries: [{ ...entry({ day: 15, minutes: 10 }), seconds: "0" }] });
    expect(s.totals.sessions).toBe(0);
    expect(s.totals.minutes).toBe(0);
  });
});

describe("foldHybrid — byStream", () => {
  const entries = [
    entry({ day: 15, minutes: 300, streamId: 1 }),
    entry({ day: 15, minutes: 100, streamId: 1, agent: true, tokens: 10_000, cost: 4.5 }),
    entry({ day: 16, minutes: 60, streamId: 3, agent: true, tokens: 5_000, cost: 6.25 }),
    entry({ day: 16, minutes: 30, streamId: null }),
  ];

  it("measures spend against the stream's budget", () => {
    const s = foldHybrid({ ...BASE, entries });
    const audit = s.byStream.find((r) => r.streamId === 1)!;
    expect(audit.agent.costUsd).toBe(4.5);
    expect(audit.agentBudgetUsd).toBe(25);
    expect(audit.burnPct).toBe(18);
    expect(audit.overBudget).toBe(false);
    expect(audit.remainingUsd).toBe(20.5);
    expect(audit.agentSharePct).toBe(25);
  });

  it("flags a stream that has spent past its budget, and says by how much", () => {
    const s = foldHybrid({ ...BASE, entries });
    const api = s.byStream.find((r) => r.streamId === 3)!;
    expect(api.overBudget).toBe(true);
    expect(api.burnPct).toBe(156.3);
    expect(api.remainingUsd).toBe(-2.25);
    expect(s.totals.overBudgetStreams).toBe(1);
  });

  it("has no burn figure for a stream with no budget, rather than a zero", () => {
    const s = foldHybrid({ ...BASE, entries: [entry({ day: 15, minutes: 60, streamId: 2, agent: true, cost: 2 })] });
    const checkout = s.byStream.find((r) => r.streamId === 2)!;
    expect(checkout.burnPct).toBeNull();
    expect(checkout.remainingUsd).toBeNull();
    expect(checkout.overBudget).toBe(false);
  });

  it("keeps work filed against no stream instead of losing it", () => {
    const s = foldHybrid({ ...BASE, entries });
    const orphan = s.byStream.find((r) => r.streamId === null)!;
    expect(orphan.name).toBe("(no stream)");
    expect(orphan.minutes).toBe(30);
  });

  it("lists a live stream that has a budget but no spend, and ignores an archived one", () => {
    const s = foldHybrid({ ...BASE, entries: [] });
    expect(s.byStream.map((r) => r.streamId).sort()).toEqual([1, 3]);
    expect(s.byStream.every((r) => r.agent.costUsd === 0)).toBe(true);
  });

  it("orders by what was spent, dearest first", () => {
    const s = foldHybrid({ ...BASE, entries });
    expect(s.byStream.map((r) => r.streamId).slice(0, 2)).toEqual([3, 1]);
  });

  it("sums only live budgets into the authorised total", () => {
    const s = foldHybrid({ ...BASE, entries });
    expect(s.totals.budgetUsd).toBe(29); // 25 + 4; the archived 100 is not authorised spend
  });
});

describe("foldHybrid — byApp", () => {
  it("attributes a session to the app of the task it points at", () => {
    const s = foldHybrid({
      ...BASE,
      entries: [
        entry({ day: 15, minutes: 100, appId: 1 }),
        entry({ day: 15, minutes: 50, appId: 1, agent: true, cost: 1 }),
        entry({ day: 15, minutes: 200, appId: 2 }),
        entry({ day: 15, minutes: 10, appId: null }),
      ],
    });
    expect(s.byApp.map((a) => [a.name, a.minutes])).toEqual([
      ["Atelier API", 200],
      ["Atelier Web", 150],
      ["(no app)", 10],
    ]);
    expect(s.byApp[1].agentSharePct).toBe(33.3);
    expect(s.byApp[1].key).toBe("web");
  });

  it("names an app the org no longer has rather than dropping its hours", () => {
    const s = foldHybrid({ ...BASE, apps: [], entries: [entry({ day: 15, minutes: 30, appId: 7 })] });
    expect(s.byApp[0]).toMatchObject({ appId: 7, name: "app 7", minutes: 30 });
  });
});

describe("foldHybrid — topAgents", () => {
  const entries = [
    entry({ day: 15, minutes: 60, agent: true, userId: 90, name: "Claude Code", tokens: 100, cost: 8.5 }),
    entry({ day: 16, minutes: 30, agent: true, userId: 90, name: "Claude Code", tokens: 50, cost: 1 }),
    entry({ day: 16, minutes: 200, agent: true, userId: 91, name: "Atelier Orchestrator", tokens: 10, cost: 4.4 }),
    entry({ day: 16, minutes: 400, userId: 10 }),
  ];

  it("lists agent seats only, dearest first, with sessions and totals", () => {
    const s = foldHybrid({ ...BASE, entries });
    expect(s.topAgents.map((a) => a.displayName)).toEqual(["Claude Code", "Atelier Orchestrator"]);
    expect(s.topAgents[0]).toMatchObject({ minutes: 90, tokens: 150, costUsd: 9.5, sessions: 2 });
    expect(s.totals.agentSeats).toBe(2);
  });

  it("counts the tasks each seat closed, once per task however many events it has", () => {
    const s = foldHybrid({
      ...BASE,
      entries,
      completions: [completion(100, 90), completion(100, 90), completion(101, 90), completion(102, 91), completion(103, null)],
    });
    expect(s.topAgents.find((a) => a.userId === 90)!.tasksCompleted).toBe(2);
    expect(s.topAgents.find((a) => a.userId === 91)!.tasksCompleted).toBe(1);
    expect(s.totals.tasksCompleted).toBe(4);
  });

  it("falls back to the agent label when the seat has no display name", () => {
    const row = { ...entry({ day: 15, minutes: 10, agent: true }), displayName: null, agentLabel: "Nightly Triage" };
    const s = foldHybrid({ ...BASE, entries: [row] });
    expect(s.topAgents[0].displayName).toBe("Nightly Triage");
  });
});

describe("foldHybrid — perCompletedTask", () => {
  it("charges each completed task its whole life, not just this window", () => {
    const s = foldHybrid({
      ...BASE,
      entries: [entry({ day: 15, minutes: 5, taskId: 100, agent: true, cost: 0.1, tokens: 500 })],
      completions: [completion(100, 90)],
      // The lifetime aggregate says the task actually cost far more than the
      // five minutes that happen to fall inside this window.
      taskCosts: [taskCost(100, 60, 200_000, 3.2)],
    });
    expect(s.perCompletedTask.total).toEqual({ agentMinutes: 60, tokens: 200_000, costUsd: 3.2 });
  });

  it("counts an agent-less completion at zero in the median, and reports both medians", () => {
    const s = foldHybrid({
      ...BASE,
      entries: [],
      completions: [completion(1), completion(2), completion(3), completion(4)],
      taskCosts: [taskCost(1, 20, 1000, 1)],
    });
    expect(s.perCompletedTask.count).toBe(4);
    expect(s.perCompletedTask.withAgent).toBe(1);
    expect(s.perCompletedTask.median.costUsd).toBe(0);
    expect(s.perCompletedTask.withAgentMedian).toEqual({ agentMinutes: 20, tokens: 1000, costUsd: 1 });
    expect(s.perCompletedTask.mean.costUsd).toBe(0.25);
  });

  it("is all zeroes when nothing was completed", () => {
    const s = foldHybrid({ ...BASE, entries: [entry({ day: 15, minutes: 60 })] });
    expect(s.perCompletedTask).toMatchObject({ count: 0, withAgent: 0, median: { costUsd: 0, tokens: 0, agentMinutes: 0 } });
  });
});

describe("foldHybrid — totals", () => {
  it("agrees with the series it was folded from", () => {
    const entries = [
      entry({ day: 14, minutes: 120 }),
      entry({ day: 15, minutes: 60, agent: true, tokens: 1000, cost: 2.5 }),
      entry({ day: 16, minutes: 30, agent: true, tokens: 500, cost: 1.25 }),
    ];
    const s = foldHybrid({ ...BASE, entries });
    const summed = s.series.reduce((a, b) => a + b.minutes, 0);
    expect(summed).toBe(s.totals.minutes);
    expect(s.totals).toMatchObject({
      minutes: 210,
      sessions: 3,
      human: { minutes: 120 },
      agent: { minutes: 90, tokens: 1500, costUsd: 3.75 },
      agentSharePct: 42.9,
    });
  });
});

describe("narrateHybrid", () => {
  const rich = () =>
    foldHybrid({
      ...BASE,
      entries: [
        entry({ day: 15, minutes: 300, streamId: 1 }),
        entry({ day: 15, minutes: 118, streamId: 1, agent: true, userId: 90, tokens: 340_500, cost: 4.57 }),
      ],
      completions: [completion(100, 90)],
      taskCosts: [taskCost(100, 22, 48_200, 0.61)],
    });

  it("states the split, the money and the budget in one paragraph", () => {
    const text = rich().narrative;
    expect(text).toContain("Agents did");
    expect(text).toContain("Security audit");
    expect(text).toContain("$4.57");
    expect(text).toContain("under the $25.00 budget");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("never claims a figure the fold did not produce", () => {
    const s = rich();
    expect(s.narrative).toContain(`${s.totals.agentSharePct}%`);
    expect(s.narrative).toContain(String(s.totals.tasksCompleted));
  });

  it("says so plainly when an overspend has happened", () => {
    const s = foldHybrid({
      ...BASE,
      entries: [entry({ day: 15, minutes: 60, streamId: 3, agent: true, cost: 6.25 })],
    });
    expect(s.narrative).toContain("past its $4.00 budget");
  });

  it("has a sentence for a window with no agent work at all", () => {
    const s = foldHybrid({ ...BASE, entries: [entry({ day: 15, minutes: 60 })] });
    expect(s.narrative).toContain("all of it human");
    expect(s.narrative).toContain("$0.00");
  });

  it("has a sentence for an empty window", () => {
    const s = foldHybrid({ ...BASE, entries: [] });
    expect(s.narrative).toContain("Nothing closed between");
    expect(s.totals.minutes).toBe(0);
  });

  it("is a pure function of the summary it is handed", () => {
    const s = rich();
    const { narrative, ...rest } = s;
    expect(narrateHybrid(rest)).toBe(narrative);
  });
});

describe("foldHybrid — window", () => {
  it("reports the range it was asked for, and flags a truncated read", () => {
    const s = foldHybrid({ ...BASE, entries: [], truncated: true });
    expect(s.range.from).toBe(AT(14, 0).toISOString());
    expect(s.range.groupBy).toBe("day");
    expect(s.truncated).toBe(true);
  });

  it("still counts a row that falls outside the enumerated buckets", () => {
    const s = foldHybrid({ ...BASE, entries: [entry({ day: 30, minutes: 45 })] });
    expect(s.totals.minutes).toBe(45);
    expect(s.series.some((b) => b.minutes === 45)).toBe(true);
  });

  it("keeps the fixtures' shape stable", () => {
    expect(STREAMS).toHaveLength(4);
    expect(APPS).toHaveLength(2);
  });
});
