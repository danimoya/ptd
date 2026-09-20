import { describe, expect, it, vi } from "vitest";

// taskOps imports the drizzle client at load time; the CPM pass never touches
// it, so an empty stub keeps this suite off a live database.
vi.mock("../../db", () => ({ db: {} }));

import type { Task } from "../../db/schema";
import { computeCpmSchedule, computeCriticalPath, durationDays } from "../../server/plan/taskOps";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** "today" for every case below, so the undated fixtures are deterministic. */
const NOW = day("2026-10-01");

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

/** Rows keyed by task id, so a case reads like the fixture it describes. */
function rows(all: Task[], now = NOW) {
  const schedule = computeCpmSchedule(all, now);
  const byId = new Map(schedule.perTask.map((row) => [row.taskId, row]));
  return { schedule, row: (id: number) => byId.get(id)!, iso: (d: Date) => d.toISOString().slice(0, 10) };
}

/** Days between two dates — the unit both passes work in. */
const between = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);

describe("durationDays", () => {
  it("counts an unknown, zero or negative duration as one day", () => {
    expect(durationDays(task(1))).toBe(1);
    expect(durationDays(task(1, { estimatedDuration: 0 }))).toBe(1);
    expect(durationDays(task(1, { estimatedDuration: -3 }))).toBe(1);
    expect(durationDays(task(1, { estimatedDuration: 4 }))).toBe(4);
  });
});

describe("computeCpmSchedule — a chain", () => {
  // 1 ──3d──▶ 2 ──2d──▶ 3, nothing dated: topological order from today.
  const chain = [
    task(1, { estimatedDuration: 3 }),
    task(2, { estimatedDuration: 2, dependencies: [1] }),
    task(3, { estimatedDuration: 4, dependencies: [2] }),
  ];

  it("walks the chain forward from today", () => {
    const { row, iso } = rows(chain);
    expect(iso(row(1).earliestStart)).toBe("2026-10-01");
    expect(iso(row(1).earliestFinish)).toBe("2026-10-04");
    expect(iso(row(2).earliestStart)).toBe("2026-10-04");
    expect(iso(row(2).earliestFinish)).toBe("2026-10-06");
    expect(iso(row(3).earliestStart)).toBe("2026-10-06");
    expect(iso(row(3).earliestFinish)).toBe("2026-10-10");
  });

  it("leaves every link on the critical path with zero float", () => {
    const { row, schedule } = rows(chain);
    expect(schedule.perTask.map((r) => r.floatDays)).toEqual([0, 0, 0]);
    expect(schedule.perTask.every((r) => r.onCriticalPath)).toBe(true);
    // Latest == earliest all the way along, by definition of zero float.
    for (const id of [1, 2, 3]) {
      expect(row(id).latestStart.getTime()).toBe(row(id).earliestStart.getTime());
      expect(row(id).latestFinish.getTime()).toBe(row(id).earliestFinish.getTime());
    }
    expect(schedule.spanDays).toBe(9);
  });

  it("reports the plan's own start and finish", () => {
    const { schedule, iso } = rows(chain);
    expect(iso(schedule.projectStart)).toBe("2026-10-01");
    expect(iso(schedule.projectFinish)).toBe("2026-10-10");
  });
});

describe("computeCpmSchedule — a diamond", () => {
  //        ┌─ 2 (5d) ─┐
  // 1 (2d) ┤          ├▶ 4 (1d)
  //        └─ 3 (2d) ─┘
  const diamond = [
    task(1, { estimatedDuration: 2 }),
    task(2, { estimatedDuration: 5, dependencies: [1] }),
    task(3, { estimatedDuration: 2, dependencies: [1] }),
    task(4, { estimatedDuration: 1, dependencies: [2, 3] }),
  ];

  it("takes the long arm of the diamond as the critical one", () => {
    const { row } = rows(diamond);
    expect(row(1).onCriticalPath).toBe(true);
    expect(row(2).onCriticalPath).toBe(true);
    expect(row(4).onCriticalPath).toBe(true);
    expect(row(3).onCriticalPath).toBe(false);
  });

  it("gives the short arm exactly the slack the long arm eats", () => {
    const { row } = rows(diamond);
    // 3 could start three days later (5d arm − 2d arm) and still not move 4.
    expect(row(3).floatDays).toBe(3);
    expect(between(row(3).earliestStart, row(3).latestStart)).toBe(3);
    expect(between(row(3).earliestFinish, row(3).latestFinish)).toBe(3);
    // The join still waits for the long arm.
    expect(between(row(1).earliestStart, row(4).earliestStart)).toBe(7);
  });

  it("finishes the diamond in 8 days", () => {
    const { schedule } = rows(diamond);
    expect(schedule.spanDays).toBe(8);
    // The legacy longest-chain reading agrees on the length of that chain.
    expect(computeCriticalPath(diamond).length).toBe(8);
  });
});

describe("computeCpmSchedule — dated cards", () => {
  it("holds a card's own start date, even one in the past", () => {
    const all = [
      task(1, { startDate: day("2026-09-20"), estimatedDuration: 4 }),
      task(2, { estimatedDuration: 2, dependencies: [1] }),
    ];
    const { row, iso } = rows(all);
    expect(iso(row(1).earliestStart)).toBe("2026-09-20");
    expect(iso(row(1).earliestFinish)).toBe("2026-09-24");
    // #1 already finished, so #2 is pulled forward to today rather than to it.
    expect(iso(row(2).earliestStart)).toBe("2026-10-01");
    // …and #1 now has the slack between its finish and #2's latest start.
    expect(row(1).floatDays).toBe(7);
    expect(row(2).floatDays).toBe(0);
  });

  it("pushes a card whose own start is earlier than its dependency's finish", () => {
    const all = [
      task(1, { startDate: day("2026-10-05"), estimatedDuration: 3 }),
      task(2, { startDate: day("2026-10-06"), estimatedDuration: 2, dependencies: [1] }),
    ];
    const { row, iso } = rows(all);
    // The board shows #2 starting on the 6th; the plan cannot honour that.
    expect(iso(row(2).earliestStart)).toBe("2026-10-08");
    expect(row(1).onCriticalPath).toBe(true);
    expect(row(2).onCriticalPath).toBe(true);
  });

  it("never reports negative float", () => {
    const all = [
      task(1, { startDate: day("2026-10-10"), estimatedDuration: 5 }),
      task(2, { startDate: day("2026-10-02"), dueDate: day("2026-10-03"), estimatedDuration: 1, dependencies: [1] }),
      task(3, { startDate: day("2026-09-01"), estimatedDuration: 1 }),
    ];
    const { schedule } = rows(all);
    for (const entry of schedule.perTask) expect(entry.floatDays).toBeGreaterThanOrEqual(0);
  });
});

describe("computeCpmSchedule — edge cases", () => {
  it("returns nothing for an empty org", () => {
    const schedule = computeCpmSchedule([], NOW);
    expect(schedule.perTask).toEqual([]);
    expect(schedule.spanDays).toBe(0);
    expect(schedule.projectFinish.toISOString()).toBe(NOW.toISOString());
  });

  it("ignores a dependency on a task from outside the set", () => {
    const { row, iso } = rows([task(7, { estimatedDuration: 2, dependencies: [999] })]);
    expect(iso(row(7).earliestStart)).toBe("2026-10-01");
    expect(row(7).onCriticalPath).toBe(true);
  });

  it("still schedules every row when a legacy cycle exists", () => {
    const cyclic = [
      task(1, { estimatedDuration: 2, dependencies: [2] }),
      task(2, { estimatedDuration: 2, dependencies: [1] }),
      task(3, { estimatedDuration: 1 }),
    ];
    const { schedule } = rows(cyclic);
    expect(schedule.perTask.map((r) => r.taskId)).toEqual([1, 2, 3]);
    for (const entry of schedule.perTask) expect(entry.floatDays).toBeGreaterThanOrEqual(0);
  });

  it("orders perTask by task id whatever order the rows arrive in", () => {
    const { schedule } = rows([
      task(9, { estimatedDuration: 1, dependencies: [4] }),
      task(4, { estimatedDuration: 1 }),
      task(6, { estimatedDuration: 1, dependencies: [4] }),
    ]);
    expect(schedule.perTask.map((r) => r.taskId)).toEqual([4, 6, 9]);
  });
});
