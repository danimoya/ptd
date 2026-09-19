import { describe, expect, it } from "vitest";
import { band, CLAIMABLE_STATUSES, normaliseScope, OPEN_STATUSES, SORTS, taskQueryInput } from "../../server/overview/schema";
import { priorityScore, TASK_STATUSES } from "../../db/schema";

describe("band", () => {
  it("cuts at Sprinter's thresholds", () => {
    expect(band(100)).toBe("critical");
    expect(band(75)).toBe("critical");
    expect(band(74)).toBe("high");
    expect(band(50)).toBe("high");
    expect(band(49)).toBe("medium");
    expect(band(25)).toBe("medium");
    expect(band(24)).toBe("low");
    expect(band(0)).toBe("low");
  });

  it("covers the whole 0-100 range with no gaps", () => {
    const seen = new Set<string>();
    for (let i = 0; i <= 100; i++) seen.add(band(i));
    expect([...seen].sort()).toEqual(["critical", "high", "low", "medium"]);
  });

  it("agrees with the schema's own scoring formula", () => {
    expect(band(priorityScore(10, 10, 1))).toBe("critical"); // 100
    expect(band(priorityScore(8, 9, 1))).toBe("high"); // 72
    expect(band(priorityScore(9, 8, 2))).toBe("medium"); // 36
    expect(band(priorityScore(2, 2, 1))).toBe("low"); // 4
  });
});

describe("status sets", () => {
  it("treats backlog, triaged and in-progress as open", () => {
    expect([...OPEN_STATUSES]).toEqual(["backlog", "triaged", "in-progress"]);
  });

  it("only hands out work that has not been started", () => {
    expect([...CLAIMABLE_STATUSES]).toEqual(["backlog", "triaged"]);
    expect(CLAIMABLE_STATUSES).not.toContain("in-progress");
  });

  it("uses statuses the frozen schema actually defines", () => {
    for (const s of [...OPEN_STATUSES, ...CLAIMABLE_STATUSES]) {
      expect(TASK_STATUSES).toContain(s);
    }
  });
});

describe("taskQueryInput", () => {
  it("accepts an empty object — every filter is optional", () => {
    expect(taskQueryInput.safeParse({}).success).toBe(true);
  });

  it("caps the page size at 200 and refuses zero", () => {
    expect(taskQueryInput.safeParse({ limit: 200 }).success).toBe(true);
    expect(taskQueryInput.safeParse({ limit: 201 }).success).toBe(false);
    expect(taskQueryInput.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("refuses a negative offset", () => {
    expect(taskQueryInput.safeParse({ offset: 0 }).success).toBe(true);
    expect(taskQueryInput.safeParse({ offset: -1 }).success).toBe(false);
  });

  it("clamps priority to 0-100 and effort to 0-10", () => {
    expect(taskQueryInput.safeParse({ priorityMin: 0, priorityMax: 100 }).success).toBe(true);
    expect(taskQueryInput.safeParse({ priorityMin: 101 }).success).toBe(false);
    expect(taskQueryInput.safeParse({ priorityMax: -1 }).success).toBe(false);
    expect(taskQueryInput.safeParse({ effortMax: 10 }).success).toBe(true);
    expect(taskQueryInput.safeParse({ effortMax: 11 }).success).toBe(false);
  });

  it("only allows statuses from the schema", () => {
    expect(taskQueryInput.safeParse({ status: ["backlog", "wontfix"] }).success).toBe(true);
    expect(taskQueryInput.safeParse({ status: ["in_progress"] }).success).toBe(false);
    expect(taskQueryInput.safeParse({ status: ["open"] }).success).toBe(false);
  });

  it('accepts null as a synonym for "none", matching Plan task.list\'s vocabulary', () => {
    // Plan's task.list spells "filed against nothing" as null; a query string
    // cannot carry null, so the REST route needs "none". Both are accepted here
    // so one MCP vocabulary works across every surface.
    for (const key of ["streamId", "appId", "assignedTo"]) {
      expect(taskQueryInput.safeParse({ [key]: null }).success, `${key}: null`).toBe(true);
      expect(taskQueryInput.safeParse({ [key]: "none" }).success, `${key}: "none"`).toBe(true);
    }
  });

  it("collapses both spellings to one internal value, and keeps omitted distinct from null", () => {
    expect(normaliseScope(null)).toBe("none");
    expect(normaliseScope("none")).toBe("none");
    expect(normaliseScope(undefined)).toBeUndefined();
    expect(normaliseScope(7)).toBe(7);
    // Omitting a key is "no filter"; null is an explicit "filed against nothing".
    expect(normaliseScope(undefined)).not.toBe(normaliseScope(null));
  });

  it('accepts an id or "none" for streamId and appId', () => {
    // Detaching a stream from an app clears tasks.app_id on that lane's cards
    // (Plan's stream.detach_app), so "no app" is a population worth finding.
    expect(taskQueryInput.safeParse({ appId: "none" }).success).toBe(true);
    expect(taskQueryInput.safeParse({ streamId: "none" }).success).toBe(true);
    expect(taskQueryInput.safeParse({ appId: 3, streamId: 1 }).success).toBe(true);
    expect(taskQueryInput.safeParse({ appId: "any" }).success).toBe(false);
    expect(taskQueryInput.safeParse({ appId: 0 }).success).toBe(false);
    expect(taskQueryInput.safeParse({ streamId: -1 }).success).toBe(false);
  });

  it('accepts a user id, "me" or "none" for assignedTo and nothing else', () => {
    expect(taskQueryInput.safeParse({ assignedTo: 7 }).success).toBe(true);
    expect(taskQueryInput.safeParse({ assignedTo: "me" }).success).toBe(true);
    expect(taskQueryInput.safeParse({ assignedTo: "none" }).success).toBe(true);
    expect(taskQueryInput.safeParse({ assignedTo: "anyone" }).success).toBe(false);
    expect(taskQueryInput.safeParse({ assignedTo: 0 }).success).toBe(false);
  });

  it("only allows the four sort keys", () => {
    for (const s of SORTS) expect(taskQueryInput.safeParse({ sort: s }).success).toBe(true);
    expect(taskQueryInput.safeParse({ sort: "urgency" }).success).toBe(false);
  });

  it("describes every field, so the MCP tool schema is self-documenting", () => {
    for (const [key, field] of Object.entries(taskQueryInput.shape)) {
      expect(field.description, `${key} has no .describe()`).toBeTruthy();
    }
  });

  it("strips unknown keys rather than silently filtering on them", () => {
    const parsed = taskQueryInput.safeParse({ limit: 5, bogusFilter: "drop me" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty("bogusFilter");
  });
});
