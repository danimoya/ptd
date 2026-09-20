import { describe, expect, it } from "vitest";

import { buildCpIndex, floatExplainer } from "../../client/src/features/plan/criticalPath";
import type { CriticalPathResponse, PlanTask } from "../../client/src/features/plan/types";

const iso = (day: string) => `${day}T00:00:00.000Z`;

const entry = (taskId: number, es: string, ef: string, floatDays: number) => ({
  taskId,
  earliestStart: iso(es),
  earliestFinish: iso(ef),
  latestStart: iso(es),
  latestFinish: iso(ef),
  floatDays,
  onCriticalPath: floatDays === 0,
});

/** Only the id is ever read off these, so a cast keeps the fixture readable. */
const chainTask = (id: number) => ({ id }) as PlanTask;

describe("buildCpIndex", () => {
  it("is not ready without a response", () => {
    const index = buildCpIndex(null);
    expect(index.ready).toBe(false);
    expect(index.onPath(1)).toBe(false);
    expect(index.floatOf(1)).toBeNull();
  });

  it("is not ready for a response with neither reading", () => {
    expect(buildCpIndex({ totalDays: 0, taskCount: 0, tasks: [] }).ready).toBe(false);
  });

  it("reads the CPM rows when they are there", () => {
    const response: CriticalPathResponse = {
      totalDays: 9,
      taskCount: 2,
      tasks: [chainTask(1), chainTask(2)],
      projectFinish: iso("2026-10-10"),
      perTask: [entry(1, "2026-10-01", "2026-10-04", 0), entry(2, "2026-10-04", "2026-10-10", 0), entry(3, "2026-10-01", "2026-10-02", 4)],
    };
    const index = buildCpIndex(response);
    expect(index.ready).toBe(true);
    expect(index.onPath(1)).toBe(true);
    expect(index.onPath(3)).toBe(false);
    expect(index.floatOf(3)).toBe(4);
    expect(index.floatOf(99)).toBeNull();
    expect(index.count).toBe(2);
    expect(index.projectFinish).toBe(iso("2026-10-10"));
  });

  it("only calls an edge critical when the hand-off is tight", () => {
    const index = buildCpIndex({
      totalDays: 9,
      taskCount: 3,
      tasks: [],
      perTask: [
        entry(1, "2026-10-01", "2026-10-04", 0),
        entry(2, "2026-10-04", "2026-10-10", 0),
        // Zero float too, but it starts a day after #1 finishes: not a link.
        entry(3, "2026-10-05", "2026-10-10", 0),
      ],
    });
    expect(index.isCriticalEdge(1, 2)).toBe(true);
    expect(index.isCriticalEdge(1, 3)).toBe(false);
    // Direction matters: the chain runs dependency → dependent.
    expect(index.isCriticalEdge(2, 1)).toBe(false);
  });

  it("never calls an edge critical when one end has float", () => {
    const index = buildCpIndex({
      totalDays: 4,
      taskCount: 1,
      tasks: [],
      perTask: [entry(1, "2026-10-01", "2026-10-04", 0), entry(2, "2026-10-04", "2026-10-06", 2)],
    });
    expect(index.isCriticalEdge(1, 2)).toBe(false);
  });

  it("falls back to the legacy chain when a server sends no CPM rows", () => {
    const index = buildCpIndex({ totalDays: 7, taskCount: 3, tasks: [chainTask(5), chainTask(6), chainTask(7)] });
    expect(index.ready).toBe(true);
    expect(index.onPath(6)).toBe(true);
    expect(index.onPath(8)).toBe(false);
    // Consecutive cards in the chain are its edges; a skip is not one.
    expect(index.isCriticalEdge(5, 6)).toBe(true);
    expect(index.isCriticalEdge(5, 7)).toBe(false);
    // No per-card schedule to read a float off.
    expect(index.floatOf(6)).toBeNull();
    expect(index.count).toBe(3);
  });
});

describe("floatExplainer", () => {
  it("names the critical case", () => {
    expect(floatExplainer(0)).toContain("critical path");
  });

  it("counts a day singular", () => {
    expect(floatExplainer(1)).toContain("1 day:");
    expect(floatExplainer(3)).toContain("3 days:");
  });

  it("says so when there is no schedule", () => {
    expect(floatExplainer(null)).toContain("unknown");
  });
});
