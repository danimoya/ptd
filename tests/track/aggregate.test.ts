import { describe, expect, it } from "vitest";
import { emptyBySource, entryMinutes, foldGroups, minutesFrom, num, totalMinutes, usd } from "../../server/track/aggregate";

describe("num", () => {
  it("coerces the strings postgres.js returns for SUM()", () => {
    expect(num("5400.000002")).toBeCloseTo(5400, 5);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num("not a number")).toBe(0);
  });
});

describe("usd", () => {
  it("restores a float4 round-trip to the number that was sent", () => {
    expect(usd(0.03999999910593033)).toBe(0.04);
    expect(usd(0.3300000000000001)).toBe(0.33);
  });
});

describe("foldGroups", () => {
  it("splits seconds into human and agent buckets and carries tokens and cost", () => {
    const folded = foldGroups([
      { key: 7, entrySource: "human", seconds: "5400" },
      { key: 7, entrySource: "agent", seconds: "2700", tokens: "18400", cost: "0.33" },
    ]);
    expect(folded.get(7)).toEqual({ human: { minutes: 90 }, agent: { minutes: 45, tokens: 18400, costUsd: 0.33 } });
    expect(totalMinutes(folded.get(7)!)).toBe(135);
  });

  it("never credits tokens or cost to the human bucket", () => {
    const folded = foldGroups([{ key: 1, entrySource: "human", seconds: "600", tokens: "9999", cost: "5" }]);
    expect(folded.get(1)).toEqual({ human: { minutes: 10 }, agent: { minutes: 0, tokens: 0, costUsd: 0 } });
  });

  it("rounds once at the end, so many short sessions do not each lose half a minute", () => {
    const rows = Array.from({ length: 4 }, () => ({ key: 1, entrySource: "human", seconds: "29" }));
    expect(foldGroups(rows).get(1)!.human.minutes).toBe(2); // 116s, not 4 × round(29s) = 0
  });

  it("keeps an unattributed group under the null key", () => {
    const folded = foldGroups([{ key: null, entrySource: "agent", seconds: "60", tokens: "10", cost: "0.5" }]);
    expect(folded.get(null)!.agent).toEqual({ minutes: 1, tokens: 10, costUsd: 0.5 });
  });

  it("clamps a negative span rather than subtracting time", () => {
    expect(foldGroups([{ key: 1, entrySource: "human", seconds: "-600" }]).get(1)!.human.minutes).toBe(0);
  });
});

describe("entryMinutes", () => {
  it("measures a closed entry", () => {
    expect(entryMinutes("2026-09-19T09:00:00Z", "2026-09-19T10:30:00Z")).toBe(90);
  });

  it("measures an open entry against now", () => {
    const now = new Date("2026-09-19T10:00:00Z");
    expect(entryMinutes("2026-09-19T09:15:00Z", null, now)).toBe(45);
  });
});

describe("shapes", () => {
  it("an empty bucket is the zeroed contract, not undefined", () => {
    expect(emptyBySource()).toEqual({ human: { minutes: 0 }, agent: { minutes: 0, tokens: 0, costUsd: 0 } });
    expect(minutesFrom(0)).toBe(0);
  });
});
