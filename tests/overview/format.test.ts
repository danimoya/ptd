import { describe, expect, it, vi } from "vitest";
import {
  BAND_LABEL, band, bandChipClass, bandTextClass, formatAgo, formatDay,
  formatMinutes, formatTokens, formatUsd, isOverdue, statusChipClass, STATUS_LABEL,
} from "../../client/src/features/overview/format";
import { band as serverBand } from "../../server/overview/schema";
import { taskQueryString } from "../../client/src/features/overview/api";

describe("band parity", () => {
  it("client and server draw the bands at the same points", () => {
    for (let i = 0; i <= 100; i++) expect(band(i)).toBe(serverBand(i));
  });

  it("maps each band to a distinct colour, muted through vermilion", () => {
    const classes = [0, 30, 60, 90].map(bandTextClass);
    expect(new Set(classes).size).toBe(4);
    expect(bandTextClass(10)).toContain("ink-muted");
    expect(bandTextClass(90)).toContain("vermilion");
    expect(new Set([0, 30, 60, 90].map(bandChipClass)).size).toBe(4);
  });

  it("labels every band with its own numeric range", () => {
    expect(BAND_LABEL.critical).toContain("75-100");
    expect(BAND_LABEL.high).toContain("50-74");
    expect(BAND_LABEL.medium).toContain("25-49");
    expect(BAND_LABEL.low).toContain("0-24");
  });
});

describe("formatMinutes", () => {
  it("renders hours and minutes, and an em dash for nothing", () => {
    expect(formatMinutes(0)).toBe("—");
    expect(formatMinutes(null)).toBe("—");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(80)).toBe("1h 20m");
    expect(formatMinutes(267)).toBe("4h 27m");
  });
});

describe("formatUsd", () => {
  it("never renders a cost as an empty string, and flags sub-cent spend", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(null)).toBe("$0");
    expect(formatUsd(undefined)).toBe("$0");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(7.25)).toBe("$7.25");
    expect(formatUsd(1234.5)).toBe("$1234.50");
  });

  it("does not choke on a NaN arriving from a float column", () => {
    expect(formatUsd(Number.NaN)).toBe("$0");
  });
});

describe("formatTokens", () => {
  it("abbreviates once counts get long", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(48_000)).toBe("48k");
    expect(formatTokens(241_500)).toBe("242k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });
});

describe("formatDay / formatAgo", () => {
  it("returns an empty string for a missing or unparsable date", () => {
    expect(formatDay(null)).toBe("");
    expect(formatDay("")).toBe("");
    expect(formatDay("not a date")).toBe("");
    expect(formatAgo(null)).toBe("");
  });

  it("formats a date without drifting across a timezone boundary", () => {
    // Stored as midnight UTC; must still read as the 1st, not the 31st.
    expect(formatDay("2026-09-01T00:00:00.000Z")).toMatch(/^1 Sep/);
  });

  it("counts backwards in the coarsest sensible unit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    expect(formatAgo("2026-09-19T11:59:40.000Z")).toBe("just now");
    expect(formatAgo("2026-09-19T11:30:00.000Z")).toBe("30m ago");
    expect(formatAgo("2026-09-19T09:00:00.000Z")).toBe("3h ago");
    expect(formatAgo("2026-09-16T12:00:00.000Z")).toBe("3d ago");
    vi.useRealTimers();
  });
});

describe("isOverdue", () => {
  it("is true only for an open task whose due date has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    expect(isOverdue("2026-09-18T00:00:00.000Z", "backlog")).toBe(true);
    expect(isOverdue("2026-09-20T00:00:00.000Z", "backlog")).toBe(false);
    expect(isOverdue(null, "backlog")).toBe(false);
    // A closed task is never overdue, however late it was finished.
    expect(isOverdue("2026-09-01T00:00:00.000Z", "completed")).toBe(false);
    expect(isOverdue("2026-09-01T00:00:00.000Z", "wontfix")).toBe(false);
    vi.useRealTimers();
  });
});

describe("status chips", () => {
  it("labels and colours every status the schema defines", () => {
    for (const s of ["backlog", "triaged", "in-progress", "completed", "wontfix"]) {
      expect(STATUS_LABEL[s]).toBeTruthy();
      expect(statusChipClass(s)).toBeTruthy();
    }
    expect(STATUS_LABEL["in-progress"]).toBe("in progress");
    expect(statusChipClass("nonsense")).toContain("rule");
  });
});

describe("taskQueryString", () => {
  it("omits everything that is not set", () => {
    expect(taskQueryString({})).toBe("");
  });

  it("repeats status so the server sees a list", () => {
    expect(taskQueryString({ status: ["backlog", "triaged"] })).toBe("status=backlog&status=triaged");
  });

  it("joins tags with a comma, the other shape the route accepts", () => {
    expect(taskQueryString({ tags: ["security", "a11y"] })).toBe("tags=security%2Ca11y");
  });

  it("keeps a zero lower bound instead of dropping it as falsy", () => {
    expect(taskQueryString({ priorityMin: 0, offset: 0 })).toContain("priorityMin=0");
    expect(taskQueryString({ priorityMin: 0, offset: 0 })).toContain("offset=0");
  });

  it("only sends includeCompleted when it is on", () => {
    expect(taskQueryString({ includeCompleted: true })).toBe("includeCompleted=1");
    expect(taskQueryString({ includeCompleted: false })).toBe("");
  });

  it("round-trips through URLSearchParams to what the route parses", () => {
    const qs = taskQueryString({ search: "a & b", appId: 3, sort: "due", order: "asc", limit: 50, offset: 100 });
    const parsed = new URLSearchParams(qs);
    expect(parsed.get("search")).toBe("a & b");
    expect(parsed.get("appId")).toBe("3");
    expect(parsed.get("sort")).toBe("due");
    expect(parsed.get("limit")).toBe("50");
    expect(parsed.get("offset")).toBe("100");
  });
});
