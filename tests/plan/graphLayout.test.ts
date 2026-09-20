import { describe, expect, it } from "vitest";

import { NODE_W, ellipsize, layoutGraph } from "../../client/src/features/plan/graphLayout";
import type { PlanApp, PlanStream, PlanTask } from "../../client/src/features/plan/types";
import type { MemberRow } from "../../client/src/lib/api";

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
    priorityScore: 50,
    prioritySource: "formula",
    priorityNote: null,
    tags: [],
    completed: false,
    createdBy: 1,
    createdAt: null,
    updatedAt: null,
    end: null,
    slackDays: null,
    ...over,
  };
}

const stream = (id: number, name: string): PlanStream => ({
  id,
  name,
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
});

const ctx = { streams: [stream(1, "Alpha"), stream(2, "Beta")], apps: [] as PlanApp[], members: [] as MemberRow[] };
const plain = { order: "priority_score" as const, group: null, ctx };

describe("layoutGraph — layering", () => {
  it("puts each card one column right of its last dependency", () => {
    const layout = layoutGraph([task(1), task(2, { dependencies: [1] }), task(3, { dependencies: [2] })], plain);
    expect(layout.layerCount).toBe(3);
    expect(layout.nodeById.get(1)!.layer).toBe(0);
    expect(layout.nodeById.get(2)!.layer).toBe(1);
    expect(layout.nodeById.get(3)!.layer).toBe(2);
    // Longest path, not shortest: every edge points right.
    for (const edge of layout.edges) expect(edge.x2).toBeGreaterThan(edge.x1);
  });

  it("uses the longest path when a card has two dependency depths", () => {
    // 1 → 2 → 3 and 1 → 3: card 3 belongs in column 2, not column 1.
    const layout = layoutGraph([task(1), task(2, { dependencies: [1] }), task(3, { dependencies: [1, 2] })], plain);
    expect(layout.nodeById.get(3)!.layer).toBe(2);
    const long = layout.edges.find((e) => e.fromId === 1 && e.toId === 3)!;
    expect(long.span).toBe(2);
  });

  it("lays the two arms of a diamond in one column", () => {
    const layout = layoutGraph(
      [task(1), task(2, { dependencies: [1] }), task(3, { dependencies: [1] }), task(4, { dependencies: [2, 3] })],
      plain
    );
    expect(layout.nodeById.get(2)!.layer).toBe(1);
    expect(layout.nodeById.get(3)!.layer).toBe(1);
    expect(layout.nodeById.get(2)!.x).toBe(layout.nodeById.get(3)!.x);
    expect(layout.nodeById.get(2)!.y).not.toBe(layout.nodeById.get(3)!.y);
    expect(layout.nodeById.get(4)!.layer).toBe(2);
    expect(layout.width).toBeGreaterThan(3 * NODE_W);
  });

  it("ignores a dependency on a card that is not drawn", () => {
    const layout = layoutGraph([task(9, { dependencies: [404] })], plain);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
    expect(layout.nodeById.get(9)!.layer).toBe(0);
  });

  it("lays out a legacy dependency cycle instead of hanging", () => {
    const layout = layoutGraph([task(1, { dependencies: [2] }), task(2, { dependencies: [1] })], plain);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("returns an empty layout for an empty board", () => {
    const layout = layoutGraph([], plain);
    expect(layout.nodes).toEqual([]);
    expect(layout.width).toBe(0);
  });
});

describe("layoutGraph — ordering", () => {
  it("unpicks a crossing the order-by would otherwise leave", () => {
    // Priority order puts 1 above 2 and 4 above 3, but 4 depends on 2 and 3 on 1
    // — barycentre ordering has to swap the second column.
    const tasks = [
      task(1, { priorityScore: 90 }),
      task(2, { priorityScore: 10 }),
      task(3, { priorityScore: 20, dependencies: [1] }),
      task(4, { priorityScore: 80, dependencies: [2] }),
    ];
    expect(layoutGraph(tasks, plain).crossings).toBe(0);
    const ordered = layoutGraph(tasks, plain);
    // 1 is still the top card of its own column: order-by decides the roots.
    expect(ordered.nodeById.get(1)!.y).toBeLessThan(ordered.nodeById.get(2)!.y);
    // …and its dependant followed it up.
    expect(ordered.nodeById.get(3)!.y).toBeLessThan(ordered.nodeById.get(4)!.y);
  });

  it("keeps the order-by ranking inside a column when nothing crosses", () => {
    const layout = layoutGraph(
      [task(1), task(2, { priorityScore: 90, dependencies: [1] }), task(3, { priorityScore: 10, dependencies: [1] })],
      plain
    );
    expect(layout.nodeById.get(2)!.y).toBeLessThan(layout.nodeById.get(3)!.y);
  });
});

describe("layoutGraph — bands", () => {
  const tasks = [
    task(1, { streamId: 1, priorityScore: 80 }),
    task(2, { streamId: 1, dependencies: [1] }),
    task(3, { streamId: 2, priorityScore: 70 }),
    task(4, { streamId: 2, dependencies: [3] }),
  ];

  it("draws one band per group, stacked and never overlapping", () => {
    const layout = layoutGraph(tasks, { order: "priority_score", group: "stream", ctx });
    expect(layout.bands.map((b) => b.label)).toEqual(["Alpha", "Beta"]);
    expect(layout.bands[0].top).toBe(0);
    expect(layout.bands[1].top).toBeGreaterThanOrEqual(layout.bands[0].top + layout.bands[0].height);
    expect(layout.bands.every((b) => b.count === 2)).toBe(true);
  });

  it("keeps a band's cards inside its own rows", () => {
    const layout = layoutGraph(tasks, { order: "priority_score", group: "stream", ctx });
    for (const node of layout.nodes) {
      const band = layout.bands[node.band];
      expect(node.y).toBeGreaterThanOrEqual(band.top);
      expect(node.y).toBeLessThan(band.top + band.height + 28);
    }
    expect(layout.nodeById.get(1)!.band).toBe(0);
    expect(layout.nodeById.get(4)!.band).toBe(1);
  });

  it("is taller banded than plain, and no wider", () => {
    const banded = layoutGraph(tasks, { order: "priority_score", group: "stream", ctx });
    const flat = layoutGraph(tasks, plain);
    expect(banded.height).toBeGreaterThan(flat.height);
    expect(banded.width).toBe(flat.width);
  });

  it("never reorders across a band to reduce crossings", () => {
    // 4 depends on 1 (a different band): honouring it would mean interleaving
    // the bands, so the band wins and the crossing stays.
    const crossed = [
      task(1, { streamId: 1 }),
      task(2, { streamId: 1, dependencies: [1] }),
      task(3, { streamId: 2 }),
      task(4, { streamId: 2, dependencies: [1] }),
    ];
    const layout = layoutGraph(crossed, { order: "priority_score", group: "stream", ctx });
    expect(layout.nodeById.get(2)!.band).toBe(0);
    expect(layout.nodeById.get(4)!.band).toBe(1);
    expect(layout.nodeById.get(2)!.y).toBeLessThan(layout.nodeById.get(4)!.y);
  });
});

describe("layoutGraph — hover cones", () => {
  it("collects the whole upstream and downstream, transitively", () => {
    const layout = layoutGraph(
      [task(1), task(2, { dependencies: [1] }), task(3, { dependencies: [2] }), task(4)],
      plain
    );
    expect([...layout.upstream.get(3)!].sort()).toEqual([1, 2]);
    expect([...layout.downstream.get(1)!].sort()).toEqual([2, 3]);
    expect([...layout.upstream.get(4)!]).toEqual([]);
    expect(layout.shallowCones).toBe(false);
  });
});

describe("ellipsize", () => {
  it("leaves a short title alone", () => {
    expect(ellipsize("Short", 200, 12)).toBe("Short");
  });

  it("clips a long one with an ellipsis", () => {
    const clipped = ellipsize("A title far too long for the card it has to sit inside", 60, 12);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped.length).toBeLessThan(20);
  });
});
