import { describe, expect, it } from "vitest";
import type { MemberRow } from "../../client/src/lib/api";
import {
  buildForest,
  buildLanes,
  dayKey,
  dayOf,
  flattenForest,
  formulaScore,
  groupAndOrder,
  groupKeyFor,
  isBlockedNow,
  laneColor,
  orderTasks,
  packSlots,
  priorityBand,
  slackOf,
  slipPreview,
  sourceOf,
  tasksInWindow,
  toDayString,
} from "../../client/src/features/plan/logic";
import type { PlanApp, PlanStream, PlanTask } from "../../client/src/features/plan/types";

const ISO = (d: string) => `${d}T00:00:00.000Z`;

function task(id: number, over: Partial<PlanTask> = {}): PlanTask {
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
    createdAt: ISO("2026-09-01"),
    updatedAt: ISO("2026-09-01"),
    end: null,
    slackDays: null,
    ...over,
  };
}

const stream = (id: number, over: Partial<PlanStream> = {}): PlanStream => ({
  id,
  name: `Stream ${id}`,
  color: null,
  customerId: null,
  archived: false,
  position: id,
  agentBudgetUsd: null,
  apps: [],
  taskCount: 0,
  openCount: 0,
  completedCount: 0,
  scheduledCount: 0,
  ...over,
});

const member = (userId: number, over: Partial<MemberRow> = {}): MemberRow => ({
  userId,
  role: "member",
  email: `user${userId}@ptd.test`,
  displayName: `User ${userId}`,
  isAgent: false,
  joinedAt: ISO("2026-01-01"),
  ...over,
});

describe("priorityBand", () => {
  it("splits at 25 / 50 / 75", () => {
    expect(priorityBand(0).key).toBe("muted");
    expect(priorityBand(24).key).toBe("muted");
    expect(priorityBand(25).key).toBe("ink");
    expect(priorityBand(49).key).toBe("ink");
    expect(priorityBand(50).key).toBe("ochre");
    expect(priorityBand(74).key).toBe("ochre");
    expect(priorityBand(75).key).toBe("vermilion");
    expect(priorityBand(100).key).toBe("vermilion");
  });
});

describe("formulaScore", () => {
  it("mirrors the schema helper, including the clamp and the effort floor", () => {
    expect(formulaScore(8, 9, 3)).toBe(24);
    expect(formulaScore(10, 10, 0)).toBe(100);
    expect(formulaScore(0, 10, 5)).toBe(0);
    expect(formulaScore(10, 10, 1)).toBe(100);
  });
});

describe("calendar-day helpers", () => {
  it("reads a UTC-midnight timestamp as that calendar day, locally", () => {
    const d = dayOf(ISO("2026-10-05"))!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(5);
    expect(toDayString(d)).toBe("2026-10-05");
    expect(dayKey(ISO("2026-10-05"))).toBe("2026-10-05");
  });

  it("returns null for missing or unparseable values", () => {
    expect(dayOf(null)).toBeNull();
    expect(dayOf("not a date")).toBeNull();
    expect(dayKey(undefined)).toBeNull();
  });
});

describe("slackOf", () => {
  it("prefers the server-derived value", () => {
    expect(slackOf(task(1, { slackDays: -3 }))).toBe(-3);
  });

  it("computes dueDate − (start + duration)", () => {
    expect(slackOf(task(1, { startDate: ISO("2026-10-01"), dueDate: ISO("2026-10-10"), estimatedDuration: 4 }))).toBe(5);
  });

  it("is null without both ends", () => {
    expect(slackOf(task(1, { startDate: ISO("2026-10-01") }))).toBeNull();
  });
});

describe("orderTasks", () => {
  const a = task(1, { priorityScore: 10, startDate: ISO("2026-10-03"), dueDate: ISO("2026-10-09"), estimatedDuration: 2 });
  const b = task(2, { priorityScore: 90, startDate: ISO("2026-10-01"), dueDate: ISO("2026-10-02"), estimatedDuration: 1 });
  const c = task(3, { priorityScore: 50 });

  it("sorts priority descending", () => {
    expect(orderTasks([a, b, c], "priority_score").map((t) => t.id)).toEqual([2, 3, 1]);
  });

  it("sorts dates ascending and pushes undated rows last", () => {
    expect(orderTasks([a, b, c], "due_date").map((t) => t.id)).toEqual([2, 1, 3]);
    expect(orderTasks([a, b, c], "start_date").map((t) => t.id)).toEqual([2, 1, 3]);
  });

  it("sorts float ascending — least slack first", () => {
    expect(orderTasks([a, b, c], "float").map((t) => t.id)).toEqual([2, 1, 3]);
  });

  it("breaks ties by id", () => {
    const x = task(7, { priorityScore: 40 });
    const y = task(4, { priorityScore: 40 });
    expect(orderTasks([x, y], "priority_score").map((t) => t.id)).toEqual([4, 7]);
  });
});

describe("sourceOf / groupKeyFor", () => {
  const members = [member(1), member(2, { isAgent: true, displayName: "planner-bot" })];
  const ctx = { streams: [stream(1, { name: "Engine" })], apps: [{ id: 3, key: "web", name: "Web", repo: null, archived: false, streamIds: [1] }] as PlanApp[], members };

  it("classifies by the assignee's seat", () => {
    expect(sourceOf(task(1, { assignedTo: 1 }), members)).toBe("human");
    expect(sourceOf(task(1, { assignedTo: 2 }), members)).toBe("agent");
    expect(sourceOf(task(1), members)).toBe("unassigned");
  });

  it("labels each grouping dimension", () => {
    const t = task(1, { streamId: 1, appId: 3, assignedTo: 2 });
    expect(groupKeyFor(t, "stream", ctx).label).toBe("Engine");
    expect(groupKeyFor(t, "app", ctx).label).toBe("Web");
    expect(groupKeyFor(t, "assignee", ctx).label).toBe("planner-bot");
    expect(groupKeyFor(t, "source", ctx).label).toBe("Agent work");
    expect(groupKeyFor(task(2), "stream", ctx).label).toBe("No stream");
    expect(groupKeyFor(task(2), "app", ctx).label).toBe("No app");
    expect(groupKeyFor(task(2), "assignee", ctx).label).toBe("Unassigned");
  });
});

describe("groupAndOrder", () => {
  const ctx = { streams: [stream(1, { name: "Alpha" }), stream(2, { name: "Beta" })], apps: [] as PlanApp[], members: [member(1)] };

  it("groups, then orders inside each group", () => {
    const rows = [
      task(1, { streamId: 1, priorityScore: 10 }),
      task(2, { streamId: 1, priorityScore: 80 }),
      task(3, { streamId: 2, priorityScore: 40 }),
    ];
    const groups = groupAndOrder(rows, "stream", "priority_score", ctx);
    expect(groups.map((g) => g.label)).toEqual(["Alpha", "Beta"]);
    expect(groups[0].tasks.map((t) => t.id)).toEqual([2, 1]);
  });

  it("orders the groups by their strongest row", () => {
    const rows = [task(1, { streamId: 1, priorityScore: 10 }), task(2, { streamId: 2, priorityScore: 95 })];
    expect(groupAndOrder(rows, "stream", "priority_score", ctx).map((g) => g.label)).toEqual(["Beta", "Alpha"]);
  });
});

describe("buildForest", () => {
  it("roots the cards with no dependencies and nests their dependents", () => {
    const rows = [task(1), task(2, { dependencies: [1] }), task(3, { dependencies: [2] })];
    const forest = buildForest(rows);
    expect(forest.map((n) => n.task.id)).toEqual([1]);
    expect(forest[0].children.map((n) => n.task.id)).toEqual([2]);
    expect(forest[0].children[0].children.map((n) => n.task.id)).toEqual([3]);
    expect(forest[0].path).toBe("/1");
    expect(forest[0].children[0].path).toBe("/1/2");
  });

  it("shows a multi-dependency card under each parent and marks it", () => {
    const rows = [task(1), task(2), task(3, { dependencies: [1, 2] })];
    const forest = buildForest(rows);
    expect(forest.map((n) => n.task.id)).toEqual([1, 2]);
    const underOne = forest[0].children[0];
    const underTwo = forest[1].children[0];
    expect(underOne.task.id).toBe(3);
    expect(underTwo.task.id).toBe(3);
    expect(underOne.duplicate).toBe(true);
    expect(underOne.parentIds).toEqual([1, 2]);
    // Distinct paths, so the two copies expand and collapse independently.
    expect(underOne.path).not.toBe(underTwo.path);
  });

  it("ignores dependencies on cards that are not in the set", () => {
    const rows = [task(5, { dependencies: [999] })];
    const forest = buildForest(rows);
    expect(forest).toHaveLength(1);
    expect(forest[0].parentIds).toEqual([]);
  });

  it("surfaces a card that only exists inside a loop instead of dropping it", () => {
    const rows = [task(1, { dependencies: [2] }), task(2, { dependencies: [1] })];
    const forest = buildForest(rows);
    expect(forest).toHaveLength(2);
    expect(forest.every((n) => n.orphan)).toBe(true);
  });

  it("does not recurse forever on a loop", () => {
    const rows = [task(1), task(2, { dependencies: [1, 3] }), task(3, { dependencies: [2] })];
    const forest = buildForest(rows);
    expect(forest.map((n) => n.task.id)).toEqual([1]);
    expect(forest[0].children[0].task.id).toBe(2);
    expect(forest[0].children[0].children[0].task.id).toBe(3);
    // 2 is an ancestor of 3, so the chain stops rather than looping.
    expect(forest[0].children[0].children[0].children).toEqual([]);
  });
});

describe("flattenForest", () => {
  const rows = [task(1), task(2, { dependencies: [1], priorityScore: 10 }), task(3, { dependencies: [1], priorityScore: 90 })];

  it("walks depth-first in the requested order", () => {
    const forest = buildForest(rows);
    expect(flattenForest(forest, () => false, "priority_score").map((n) => n.task.id)).toEqual([1, 3, 2]);
  });

  it("omits the children of a collapsed node", () => {
    const forest = buildForest(rows);
    expect(flattenForest(forest, (path) => path === "/1", "priority_score").map((n) => n.task.id)).toEqual([1]);
  });
});

describe("slipPreview", () => {
  const rows = [
    task(1, { startDate: ISO("2026-10-01"), estimatedDuration: 3 }),
    task(2, { startDate: ISO("2026-10-02"), estimatedDuration: 2, dependencies: [1] }),
    task(3, { startDate: ISO("2026-11-20"), estimatedDuration: 1, dependencies: [2] }),
  ];

  it("reports the pushed card plus everything the cascade drags along", () => {
    const rows2 = slipPreview(rows, 1, 5);
    expect(rows2.map((r) => r.taskId)).toEqual([1, 2]);
    expect(rows2[0].root).toBe(true);
    expect(dayKey(rows2[0].startDate)).toBe("2026-10-06");
    expect(dayKey(rows2[1].startDate)).toBe("2026-10-09");
    // #3 has slack until late November, so it does not move.
    expect(rows2.some((r) => r.taskId === 3)).toBe(false);
  });

  it("shifts an explicit dueDate with the root", () => {
    const withDue = [task(1, { startDate: ISO("2026-10-01"), dueDate: ISO("2026-10-04"), estimatedDuration: 3 })];
    const [root] = slipPreview(withDue, 1, 2);
    expect(dayKey(root.startDate)).toBe("2026-10-03");
    expect(dayKey(root.dueDate)).toBe("2026-10-06");
  });

  it("is empty for zero days, an unscheduled root or an unknown id", () => {
    expect(slipPreview(rows, 1, 0)).toEqual([]);
    expect(slipPreview([task(9)], 9, 4)).toEqual([]);
    expect(slipPreview(rows, 404, 4)).toEqual([]);
  });
});

describe("buildLanes", () => {
  const streams = [stream(2, { name: "Beta", position: 1 }), stream(1, { name: "Alpha", position: 2 })];
  const members = [
    { userId: 1, displayName: "Dana", isAgent: false },
    { userId: 2, displayName: "planner-bot", isAgent: true },
  ];

  it("orders stream lanes by board position and puts the catch-all last", () => {
    const rows = [task(1, { streamId: 1 }), task(2, { streamId: 2 }), task(3)];
    const lanes = buildLanes(rows, "stream", streams, members);
    expect(lanes.map((l) => l.label)).toEqual(["Beta", "Alpha", "No stream"]);
    expect(lanes[0].streamId).toBe(2);
  });

  it("groups by assignee and flags agent lanes", () => {
    const rows = [task(1, { assignedTo: 2 }), task(2, { assignedTo: 1 }), task(3)];
    const lanes = buildLanes(rows, "assignee", streams, members);
    expect(lanes.map((l) => l.label)).toEqual(["Dana", "planner-bot", "Unassigned"]);
    expect(lanes.find((l) => l.label === "planner-bot")!.isAgent).toBe(true);
  });

  it("uses the stream's own colour when it has one", () => {
    const coloured = [stream(1, { color: "#123456" })];
    const lanes = buildLanes([task(1, { streamId: 1 })], "stream", coloured, members);
    expect(lanes[0].color).toBe("#123456");
    expect(laneColor(1, null)).toMatch(/^#/);
    expect(laneColor(1, null)).toBe(laneColor(1, null));
  });
});

describe("packSlots", () => {
  it("puts overlapping cards on separate rows and reuses a freed row", () => {
    const rows = [
      task(1, { startDate: ISO("2026-10-01"), estimatedDuration: 5 }),
      task(2, { startDate: ISO("2026-10-02"), estimatedDuration: 5 }),
      task(3, { startDate: ISO("2026-10-20"), estimatedDuration: 1 }),
    ];
    const slots = packSlots(rows);
    expect(slots.get(1)).toBe(0);
    expect(slots.get(2)).toBe(1);
    expect(slots.get(3)).toBe(0);
  });

  it("ignores unscheduled cards", () => {
    expect(packSlots([task(1)]).size).toBe(0);
  });
});

describe("tasksInWindow", () => {
  const from = new Date(2026, 9, 1);
  const to = new Date(2026, 9, 31);

  it("keeps a card that overlaps the window from either side", () => {
    const rows = [
      task(1, { startDate: ISO("2026-09-28"), estimatedDuration: 5 }),
      task(2, { startDate: ISO("2026-10-30"), estimatedDuration: 6 }),
      task(3, { startDate: ISO("2026-08-01"), estimatedDuration: 2 }),
      task(4),
    ];
    expect(tasksInWindow(rows, from, to).map((t) => t.id)).toEqual([1, 2]);
  });

  it("uses an explicit dueDate when it is later than the duration", () => {
    const rows = [task(1, { startDate: ISO("2026-09-01"), estimatedDuration: 1, dueDate: ISO("2026-10-15") })];
    expect(tasksInWindow(rows, from, to).map((t) => t.id)).toEqual([1]);
  });
});

describe("isBlockedNow", () => {
  const now = new Date("2026-10-10T00:00:00.000Z");

  it("is blocked by an open dependency that has not finished", () => {
    const rows = [task(1, { startDate: ISO("2026-10-09"), estimatedDuration: 5 }), task(2, { dependencies: [1] })];
    expect(isBlockedNow(rows[1], rows, now)).toBe(true);
  });

  it("is not blocked by a completed dependency", () => {
    const rows = [task(1, { completed: true }), task(2, { dependencies: [1] })];
    expect(isBlockedNow(rows[1], rows, now)).toBe(false);
  });

  it("is not blocked once the dependency's end has passed", () => {
    const rows = [task(1, { startDate: ISO("2026-10-01"), estimatedDuration: 2 }), task(2, { dependencies: [1] })];
    expect(isBlockedNow(rows[1], rows, now)).toBe(false);
  });

  it("treats an unscheduled dependency as blocking", () => {
    const rows = [task(1), task(2, { dependencies: [1] })];
    expect(isBlockedNow(rows[1], rows, now)).toBe(true);
  });
});
