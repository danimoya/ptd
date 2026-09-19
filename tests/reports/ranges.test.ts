import { describe, expect, it } from "vitest";
import {
  PRESET_KEYS,
  PRESET_LABELS,
  describeRange,
  invoiceYears,
  presetRange,
  previousRange,
  rangeDays,
  suggestedGroupBy,
  toKey,
} from "../../client/src/features/track/reports/ranges";

/** A Thursday, chosen so week and month boundaries are both non-trivial. */
const NOW = new Date(2026, 8, 17, 15, 30, 0);

describe("presetRange", () => {
  it("runs this week Monday to Sunday", () => {
    expect(presetRange("this-week", NOW)).toEqual({ from: "2026-09-14", to: "2026-09-20" });
  });

  it("runs last week the same way, a week earlier", () => {
    expect(presetRange("last-week", NOW)).toEqual({ from: "2026-09-07", to: "2026-09-13" });
  });

  it("runs this month to the last day of the month, not to today", () => {
    expect(presetRange("this-month", NOW)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("runs last month over the whole prior calendar month", () => {
    expect(presetRange("last-month", NOW)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("runs the last 30 days inclusive of today", () => {
    const r = presetRange("last-30", NOW);
    expect(r).toEqual({ from: "2026-08-19", to: "2026-09-17" });
    expect(rangeDays(r)).toBe(30);
  });

  it("gives every preset a label", () => {
    for (const key of PRESET_KEYS) expect(PRESET_LABELS[key]).toBeTruthy();
  });

  it("seeds Custom with this week rather than an empty range", () => {
    expect(presetRange("custom", NOW)).toEqual(presetRange("this-week", NOW));
  });
});

describe("rangeDays", () => {
  it("counts a single day as one", () => {
    expect(rangeDays({ from: "2026-09-17", to: "2026-09-17" })).toBe(1);
  });

  it("counts a week as seven, inclusive of both ends", () => {
    expect(rangeDays({ from: "2026-09-14", to: "2026-09-20" })).toBe(7);
  });

  it("counts across a month boundary", () => {
    expect(rangeDays({ from: "2026-08-31", to: "2026-09-02" })).toBe(3);
  });
});

describe("previousRange", () => {
  it("compares this month against the previous calendar month, not 30 days back", () => {
    const current = presetRange("this-month", NOW);
    expect(previousRange("this-month", current, NOW)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("compares last month against the month before that", () => {
    const current = presetRange("last-month", NOW);
    expect(previousRange("last-month", current, NOW)).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });

  it("compares this week against the week immediately before it", () => {
    const current = presetRange("this-week", NOW);
    expect(previousRange("this-week", current, NOW)).toEqual({ from: "2026-09-07", to: "2026-09-13" });
  });

  it("compares any custom window against the same number of days before it", () => {
    const current = { from: "2026-09-10", to: "2026-09-12" };
    expect(previousRange("custom", current, NOW)).toEqual({ from: "2026-09-07", to: "2026-09-09" });
  });

  it("compares a single day against the day before", () => {
    expect(previousRange("custom", { from: "2026-09-01", to: "2026-09-01" }, NOW)).toEqual({ from: "2026-08-31", to: "2026-08-31" });
  });

  it("produces a comparison window of the same length as the current one", () => {
    const current = presetRange("last-30", NOW);
    expect(rangeDays(previousRange("last-30", current, NOW))).toBe(rangeDays(current));
  });
});

describe("suggestedGroupBy", () => {
  it("buckets a month or less by day", () => {
    expect(suggestedGroupBy(presetRange("this-week", NOW))).toBe("day");
    expect(suggestedGroupBy(presetRange("this-month", NOW))).toBe("day");
  });

  it("buckets a quarter by week", () => {
    expect(suggestedGroupBy({ from: "2026-07-01", to: "2026-09-30" })).toBe("week");
  });

  it("buckets a year by month", () => {
    expect(suggestedGroupBy({ from: "2026-01-01", to: "2026-12-31" })).toBe("month");
  });
});

describe("describeRange", () => {
  it("prints one day plainly", () => {
    expect(describeRange({ from: "2026-09-17", to: "2026-09-17" })).toBe("17 September 2026");
  });

  it("elides the repeated month within one month", () => {
    expect(describeRange({ from: "2026-09-01", to: "2026-09-30" })).toBe("1 – 30 September 2026");
  });

  it("names both months within one year", () => {
    expect(describeRange({ from: "2026-08-19", to: "2026-09-17" })).toBe("19 Aug – 17 Sep 2026");
  });

  it("names both years when the window crosses one", () => {
    expect(describeRange({ from: "2025-12-29", to: "2026-01-04" })).toBe("29 Dec 2025 – 4 Jan 2026");
  });
});

describe("toKey and invoiceYears", () => {
  it("keys a date as a local YYYY-MM-DD, never shifted by a timezone", () => {
    expect(toKey(new Date(2026, 0, 1, 0, 30))).toBe("2026-01-01");
    expect(toKey(new Date(2026, 11, 31, 23, 30))).toBe("2026-12-31");
  });

  it("offers this year and the four before it, newest first", () => {
    expect(invoiceYears(NOW)).toEqual([2026, 2025, 2024, 2023, 2022]);
  });
});

describe("hourTicks", () => {
  it("never prints the same hour twice, whatever the tallest bar is", async () => {
    const { hourTicks } = await import("../../client/src/features/track/reports/SourceBars");
    for (const max of [1, 45, 59, 61, 150, 200, 480, 700, 1440, 5000, 20_000]) {
      const labels = hourTicks(max).map((m) => m / 60);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("puts every tick on a whole hour, starting at zero", async () => {
    const { hourTicks } = await import("../../client/src/features/track/reports/SourceBars");
    const ticks = hourTicks(150);
    expect(ticks[0]).toBe(0);
    expect(ticks.every((m) => m % 60 === 0)).toBe(true);
  });

  it("reaches at least the tallest bar, so nothing is clipped", async () => {
    const { hourTicks } = await import("../../client/src/features/track/reports/SourceBars");
    for (const max of [150, 379, 901, 1879]) {
      expect(hourTicks(max).at(-1)!).toBeGreaterThanOrEqual(max);
    }
  });

  it("keeps the axis to a readable handful of ticks", async () => {
    const { hourTicks } = await import("../../client/src/features/track/reports/SourceBars");
    for (const max of [60, 480, 1440, 20_000]) {
      expect(hourTicks(max).length).toBeLessThanOrEqual(9);
    }
  });
});
