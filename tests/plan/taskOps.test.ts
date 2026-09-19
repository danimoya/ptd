import { describe, expect, it, vi } from "vitest";

// Every module under test imports the drizzle client at load time; the pure
// helpers never touch it, so an empty stub keeps the suite off a live database.
vi.mock("../../db", () => ({ db: {} }));

import type { Task } from "../../db/schema";
import { ActionError } from "../../server/actions/registry";
import {
  assertDependencies,
  canComplete,
  computeCriticalPath,
  deriveStatus,
  endOf,
  floatDays,
  isBlocked,
  parseDate,
  resolvePriority,
  serializeTask,
} from "../../server/plan/taskOps";
import { actorFrom, diffTask, summariseChanges } from "../../server/plan/taskEvents";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function task(id: number, over: Partial<Task> = {}): Task {
  return {
    id,
    orgId: 1,
    title: `Task ${id}`,
    description: null,
    status: "backlog",
    streamId: null,
    appId: null,
    assignedTo: null,
    startDate: null,
    dueDate: null,
    estimatedDuration: null,
    dependencies: [],
    externalKey: null,
    urgency: 5,
    impact: 5,
    effort: 5,
    priorityScore: 5,
    prioritySource: "formula",
    priorityNote: null,
    tags: [],
    completed: false,
    createdBy: 1,
    createdAt: day("2026-09-01"),
    updatedAt: day("2026-09-01"),
    ...over,
  } as Task;
}

describe("endOf / floatDays", () => {
  it("ends at start + duration", () => {
    expect(endOf(task(1, { startDate: day("2026-10-01"), estimatedDuration: 4 }))!.toISOString()).toBe(day("2026-10-05").toISOString());
  });

  it("prefers a later explicit dueDate", () => {
    expect(endOf(task(1, { startDate: day("2026-10-01"), estimatedDuration: 1, dueDate: day("2026-10-09") }))!.toISOString()).toBe(day("2026-10-09").toISOString());
  });

  it("ignores a dueDate that is earlier than the start", () => {
    expect(endOf(task(1, { startDate: day("2026-10-10"), dueDate: day("2026-10-01") }))!.toISOString()).toBe(day("2026-10-10").toISOString());
  });

  it("has no end without a start", () => {
    expect(endOf(task(1))).toBeNull();
  });

  it("computes slack, negative when the work overruns the deadline", () => {
    expect(floatDays(task(1, { startDate: day("2026-10-01"), dueDate: day("2026-10-10"), estimatedDuration: 3 }))).toBe(6);
    expect(floatDays(task(1, { startDate: day("2026-10-01"), dueDate: day("2026-10-03"), estimatedDuration: 8 }))).toBe(-6);
    expect(floatDays(task(1, { startDate: day("2026-10-01") }))).toBeNull();
  });
});

describe("deriveStatus", () => {
  it("promotes a backlog card that gets a start date", () => {
    expect(deriveStatus(task(1, { status: "backlog" }), day("2026-10-01"))).toBe("in-progress");
  });

  it("demotes an in-progress card that loses its start date", () => {
    expect(deriveStatus(task(1, { status: "in-progress" }), null)).toBe("backlog");
  });

  it("lets an explicit status win", () => {
    expect(deriveStatus(task(1, { status: "backlog" }), day("2026-10-01"), "triaged")).toBe("triaged");
  });

  it("never re-derives a completed card", () => {
    expect(deriveStatus(task(1, { status: "completed", completed: true }), day("2026-10-01"))).toBeUndefined();
  });

  it("leaves other statuses alone", () => {
    expect(deriveStatus(task(1, { status: "triaged" }), day("2026-10-01"))).toBeUndefined();
    expect(deriveStatus(task(1, { status: "wontfix" }), null)).toBeUndefined();
  });
});

describe("resolvePriority", () => {
  const formula = { urgency: 5, impact: 5, effort: 5, priorityScore: 5, prioritySource: "formula" };
  const manual = { urgency: 5, impact: 5, effort: 5, priorityScore: 90, prioritySource: "manual" };

  it("recomputes urgency×impact/effort", () => {
    expect(resolvePriority(formula, { urgency: 8, impact: 9, effort: 3 })).toMatchObject({ priorityScore: 24, prioritySource: "formula" });
  });

  it("pins and clamps a manual score", () => {
    expect(resolvePriority(formula, { manualScore: 140 })).toMatchObject({ priorityScore: 100, prioritySource: "manual" });
    expect(resolvePriority(formula, { manualScore: -5 })).toMatchObject({ priorityScore: 0, prioritySource: "manual" });
  });

  it("keeps a manual score through an ordinary field edit", () => {
    expect(resolvePriority(manual, { urgency: 1, impact: 1, effort: 9 })).toMatchObject({ priorityScore: 90, prioritySource: "manual", urgency: 1, effort: 9 });
  });

  it("keeps an ai score the same way", () => {
    const ai = { ...manual, prioritySource: "ai", priorityScore: 63 };
    expect(resolvePriority(ai, { urgency: 2 })).toMatchObject({ priorityScore: 63, prioritySource: "ai" });
  });

  it("drops back to the formula when task.set_priority forces it", () => {
    expect(resolvePriority(manual, { urgency: 10, impact: 10, effort: 2 }, { force: true })).toMatchObject({ priorityScore: 50, prioritySource: "formula" });
  });

  it("clears an override when manualScore is explicitly null", () => {
    expect(resolvePriority(manual, { manualScore: null })).toMatchObject({ priorityScore: 5, prioritySource: "formula" });
  });
});

describe("canComplete", () => {
  const mine = task(1, { assignedTo: 7 });
  const theirs = task(2, { assignedTo: 9 });

  it("lets a member complete only their own card", () => {
    expect(canComplete("member", mine, 7)).toBe(true);
    expect(canComplete("member", theirs, 7)).toBe(false);
    expect(canComplete("member", task(3), 7)).toBe(false);
  });

  it("lets manager and above complete anything", () => {
    for (const role of ["manager", "admin", "owner"] as const) expect(canComplete(role, theirs, 7)).toBe(true);
  });
});

describe("computeCriticalPath", () => {
  it("returns the longest duration-weighted chain", () => {
    const rows = [
      task(1, { estimatedDuration: 5 }),
      task(2, { estimatedDuration: 2, dependencies: [1] }),
      task(3, { estimatedDuration: 10 }),
      task(4, { estimatedDuration: 1, dependencies: [3] }),
    ];
    const { length, path } = computeCriticalPath(rows);
    expect(length).toBe(11);
    expect(path.map((t) => t.id)).toEqual([3, 4]);
  });

  it("follows the longer of two branches", () => {
    const rows = [
      task(1, { estimatedDuration: 1 }),
      task(2, { estimatedDuration: 9 }),
      task(3, { estimatedDuration: 2, dependencies: [1, 2] }),
    ];
    expect(computeCriticalPath(rows).path.map((t) => t.id)).toEqual([2, 3]);
  });

  it("is empty for no tasks and terminates on a loop", () => {
    expect(computeCriticalPath([])).toEqual({ length: 0, path: [] });
    const loop = [task(1, { estimatedDuration: 2, dependencies: [2] }), task(2, { estimatedDuration: 3, dependencies: [1] })];
    expect(computeCriticalPath(loop).length).toBeGreaterThan(0);
  });
});

describe("isBlocked", () => {
  it("blocks on an unfinished dependency and clears once it is done", () => {
    const open = [task(1, { startDate: new Date(Date.now() + 86_400_000), estimatedDuration: 3 }), task(2, { dependencies: [1] })];
    expect(isBlocked(open[1], open)).toBe(true);
    const closed = [task(1, { completed: true }), task(2, { dependencies: [1] })];
    expect(isBlocked(closed[1], closed)).toBe(false);
  });

  it("is never blocked without dependencies, or by an id that no longer exists", () => {
    expect(isBlocked(task(1), [task(1)])).toBe(false);
    const dangling = [task(2, { dependencies: [404] })];
    expect(isBlocked(dangling[0], dangling)).toBe(false);
  });
});

describe("assertDependencies", () => {
  const all = [task(1), task(2), task(3)];

  it("keeps the given order and drops duplicates", () => {
    expect(assertDependencies(3, [2, 1, 2], all)).toEqual([2, 1]);
  });

  it("rejects self-reference, unknown ids and non-integers", () => {
    expect(() => assertDependencies(1, [1], all)).toThrow(ActionError);
    expect(() => assertDependencies(1, [99], all)).toThrow(/not a task in this organization/);
    expect(() => assertDependencies(1, [1.5], all)).toThrow(/integer/);
  });

  it("allows any owned id while drafting (no task id yet)", () => {
    expect(assertDependencies(null, [1, 2], all)).toEqual([1, 2]);
  });
});

describe("parseDate", () => {
  it("accepts a date-only string as UTC midnight", () => {
    expect(parseDate("2026-10-05", "startDate").toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("rejects nonsense as a caller error", () => {
    expect(() => parseDate("last thursday", "startDate")).toThrow(ActionError);
    try {
      parseDate("nope", "dueDate");
    } catch (error) {
      expect((error as ActionError).code).toBe("invalid");
    }
  });
});

describe("serializeTask", () => {
  it("emits ISO dates, array jsonb columns and the derived end/slack", () => {
    const row = task(1, { startDate: day("2026-10-01"), dueDate: day("2026-10-10"), estimatedDuration: 4, dependencies: [2], tags: ["x"] });
    const wire = serializeTask(row);
    expect(wire.startDate).toBe("2026-10-01T00:00:00.000Z");
    expect(wire.end).toBe("2026-10-10T00:00:00.000Z");
    expect(wire.slackDays).toBe(5);
    expect(wire.dependencies).toEqual([2]);
    expect(wire.tags).toEqual(["x"]);
  });

  it("copes with null jsonb columns from an older row", () => {
    const row = task(1, { dependencies: null as unknown as number[], tags: null as unknown as string[] });
    expect(serializeTask(row)).toMatchObject({ dependencies: [], tags: [], end: null, slackDays: null });
  });
});

describe("diffTask", () => {
  it("returns null when nothing meaningful changed", () => {
    const before = task(1);
    expect(diffTask(before, { ...before, updatedAt: new Date() })).toBeNull();
  });

  it("reports scalar, date and array changes", () => {
    const before = task(1, { startDate: day("2026-10-01"), dependencies: [2, 3], tags: ["a"] });
    const after = task(1, { startDate: day("2026-10-05"), dependencies: [3], tags: ["a", "b"], title: "Renamed" });
    const changes = diffTask(before, after)!;
    expect(Object.keys(changes).sort()).toEqual(["dependencies", "startDate", "tags", "title"]);
    expect(changes.startDate).toEqual({ old: "2026-10-01T00:00:00.000Z", new: "2026-10-05T00:00:00.000Z" });
    expect(changes.dependencies).toEqual({ old: [2, 3], new: [3] });
  });

  it("treats a reordered array as unchanged", () => {
    const before = task(1, { dependencies: [3, 2] });
    const after = task(1, { dependencies: [2, 3] });
    expect(diffTask(before, after)).toBeNull();
  });

  it("normalises undefined to null", () => {
    const before = task(1, { description: null });
    const after = task(1, { description: undefined as unknown as string });
    expect(diffTask(before, after)).toBeNull();
  });

  it("tracks the priority columns", () => {
    const changes = diffTask(task(1), task(1, { priorityScore: 90, prioritySource: "manual" }))!;
    expect(Object.keys(changes).sort()).toEqual(["priorityScore", "prioritySource"]);
  });
});

describe("summariseChanges", () => {
  it("summarises by field count", () => {
    expect(summariseChanges(null)).toBe("no field changes");
    expect(summariseChanges({ title: { old: 1, new: 2 } })).toBe("title changed");
    expect(summariseChanges({ a: { old: 1, new: 2 }, b: { old: 1, new: 2 } })).toBe("a, b changed");
    const many = Object.fromEntries(["a", "b", "c", "d"].map((k) => [k, { old: 1, new: 2 }]));
    expect(summariseChanges(many)).toBe("4 fields changed");
  });
});

describe("actorFrom", () => {
  const base = { userId: 4, email: "dana@ptd.test", displayName: "Dana", orgId: 1, role: "manager" as const, via: "web" as const };

  it("labels a human by display name", () => {
    expect(actorFrom({ ...base, authType: "human" })).toEqual({ userId: 4, label: "Dana", isAgent: false, via: "web" });
  });

  it("marks an agent seat in the label so history is readable", () => {
    expect(actorFrom({ ...base, displayName: "planner-bot", authType: "agent", via: "mcp" })).toEqual({
      userId: 4,
      label: "planner-bot (agent)",
      isAgent: true,
      via: "mcp",
    });
  });
});
