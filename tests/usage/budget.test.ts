/** Hard budgets: the verdict, the month window, and the once-a-day announcement. */
import { beforeEach, describe, expect, it, vi } from "vitest";

// budget.ts reads the ledger and fans an event out; neither is what is under test
// here, so the client and the webhook fan-out are both faked.
vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});
const dispatched: unknown[] = [];
vi.mock("../../server/webhooks", () => ({
  dispatchWebhooks: async (orgId: number, event: unknown) => {
    dispatched.push({ orgId, event });
  },
}));

import { db } from "../../db";
import { streams, timeEntries } from "../../db/schema";
import {
  announceExhausted,
  evaluateBudget,
  monthStart,
  monthToDateSpend,
  resetExhaustionThrottle,
  shouldAnnounce,
  streamBudgets,
} from "../../server/usage/budget";
import type { FakeDb } from "./fake-db";

const fake = db as unknown as FakeDb;
const period = new Date("2026-09-01T00:00:00");

beforeEach(() => {
  fake.reset();
  dispatched.length = 0;
  resetExhaustionThrottle();
});

const lane = (over: Record<string, unknown> = {}) => ({ id: 1, name: "Security audit", agentBudgetUsd: 10, budgetMode: "alert", archived: false, ...over });

describe("evaluateBudget", () => {
  it("reports burn and remaining against a ceiling", () => {
    const b = evaluateBudget(lane(), { costUsd: 2.5, tokens: 1_000 }, period);
    expect(b).toMatchObject({ budgetUsd: 10, spentUsd: 2.5, remainingUsd: 7.5, burnPct: 25, overBudget: false, blocked: false });
  });

  it("never reports negative headroom", () => {
    const b = evaluateBudget(lane(), { costUsd: 25, tokens: 0 }, period);
    expect(b.remainingUsd).toBe(0);
    expect(b.burnPct).toBe(250);
    expect(b.overBudget).toBe(true);
  });

  it("warns but does not block in alert mode, which is the default", () => {
    const b = evaluateBudget(lane({ budgetMode: "alert" }), { costUsd: 99, tokens: 0 }, period);
    expect(b.overBudget).toBe(true);
    expect(b.enforced).toBe(false);
    expect(b.blocked).toBe(false);
  });

  it("blocks in enforce mode once the ceiling is reached", () => {
    const exactly = evaluateBudget(lane({ budgetMode: "enforce" }), { costUsd: 10, tokens: 0 }, period);
    expect(exactly.blocked).toBe(true); // reaching the budget is spending it
    const under = evaluateBudget(lane({ budgetMode: "enforce" }), { costUsd: 9.99, tokens: 0 }, period);
    expect(under.blocked).toBe(false);
    expect(under.enforced).toBe(true);
  });

  it("enforces nothing without a ceiling — enforce mode on an unbudgeted lane is a no-op", () => {
    const b = evaluateBudget(lane({ budgetMode: "enforce", agentBudgetUsd: null }), { costUsd: 500, tokens: 0 }, period);
    expect(b.budgetUsd).toBeNull();
    expect(b.remainingUsd).toBeNull();
    expect(b.burnPct).toBeNull();
    expect(b.enforced).toBe(false);
    expect(b.blocked).toBe(false);
  });

  it("treats a zero budget as no budget rather than as instantly exhausted", () => {
    const b = evaluateBudget(lane({ budgetMode: "enforce", agentBudgetUsd: 0 }), { costUsd: 0, tokens: 0 }, period);
    expect(b.budgetUsd).toBeNull();
    expect(b.blocked).toBe(false);
  });

  it("falls back to alert for an unrecognised mode", () => {
    expect(evaluateBudget(lane({ budgetMode: "nonsense" }), { costUsd: 99, tokens: 0 }, period).mode).toBe("alert");
    expect(evaluateBudget(lane({ budgetMode: null }), { costUsd: 99, tokens: 0 }, period).mode).toBe("alert");
  });
});

describe("monthStart", () => {
  it("is midnight on the first of the caller's local month", () => {
    const start = monthStart(new Date(2026, 8, 20, 13, 45));
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(8);
    expect(start.getDate()).toBe(1);
    expect(start.getHours()).toBe(0);
  });
});

describe("monthToDateSpend", () => {
  it("coerces the strings postgres.js returns and keys the map by stream, nulls included", async () => {
    fake.queue(timeEntries, [
      { streamId: 1, cost: "4.5", tokens: "120000" },
      { streamId: null, cost: "0.25", tokens: "900" },
    ]);
    const spend = await monthToDateSpend(7, period);
    expect(spend.get(1)).toEqual({ costUsd: 4.5, tokens: 120_000 });
    expect(spend.get(null)).toEqual({ costUsd: 0.25, tokens: 900 });
    expect(spend.get(99)).toBeUndefined();
  });
});

describe("streamBudgets", () => {
  it("drops archived lanes and zeroes a lane nothing was spent in", async () => {
    fake.queue(streams, [lane({ id: 1 }), lane({ id: 2, name: "Retired", archived: true }), lane({ id: 3, name: "Quiet", agentBudgetUsd: 5 })]);
    fake.queue(timeEntries, [{ streamId: 1, cost: "12", tokens: "50" }]);
    const budgets = await streamBudgets(4, new Date(2026, 8, 20));
    expect(budgets.map((b) => b.streamId)).toEqual([1, 3]);
    expect(budgets[0].overBudget).toBe(true);
    expect(budgets[1]).toMatchObject({ spentUsd: 0, remainingUsd: 5, overBudget: false });
  });
});

describe("budget.exhausted", () => {
  it("announces a blocked lane once per day and not again", () => {
    const day = new Date("2026-09-20T10:00:00Z");
    expect(shouldAnnounce(1, 9, day)).toBe(true);
    expect(shouldAnnounce(1, 9, new Date("2026-09-20T23:00:00Z"))).toBe(false);
    expect(shouldAnnounce(1, 9, new Date("2026-09-21T00:30:00Z"))).toBe(true);
  });

  it("throttles per stream and per organization, not globally", () => {
    const day = new Date("2026-09-20T10:00:00Z");
    expect(shouldAnnounce(1, 9, day)).toBe(true);
    expect(shouldAnnounce(1, 10, day)).toBe(true);
    expect(shouldAnnounce(2, 9, day)).toBe(true);
  });

  it("fans out only for lanes that are actually blocked, with the figures that blocked them", async () => {
    const blocked = evaluateBudget(lane({ budgetMode: "enforce" }), { costUsd: 12, tokens: 0 }, period);
    const warning = evaluateBudget(lane({ id: 2, budgetMode: "alert" }), { costUsd: 12, tokens: 0 }, period);
    await announceExhausted(3, [blocked, warning], new Date("2026-09-20T10:00:00Z"));
    expect(dispatched).toHaveLength(1);
    const { orgId, event } = dispatched[0] as { orgId: number; event: { kind: string; payload: Record<string, unknown> } };
    expect(orgId).toBe(3);
    expect(event.kind).toBe("budget.exhausted");
    expect(event.payload).toMatchObject({ streamId: 1, budgetUsd: 10, spentUsd: 12, mode: "enforce" });
  });

  it("does not repeat the same day's announcement on a second evaluation", async () => {
    const blocked = evaluateBudget(lane({ budgetMode: "enforce" }), { costUsd: 12, tokens: 0 }, period);
    const at = new Date("2026-09-20T10:00:00Z");
    await announceExhausted(3, [blocked], at);
    await announceExhausted(3, [blocked], at);
    expect(dispatched).toHaveLength(1);
  });
});
