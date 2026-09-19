import { describe, expect, it, vi } from "vitest";
import { cascadeFrom as serverCascadeFrom, wouldCreateCycle as serverWouldCreateCycle } from "../../server/cascade";
import { cascadeFrom as clientCascadeFrom, wouldCreateCycle as clientWouldCreateCycle } from "../../client/src/features/plan/cascade";

// server/cascade.ts is pure, but anything else it might drag in must not open a
// database connection during the test run.
vi.mock("../../db", () => ({ db: {} }));

type Fixture = {
  id: number;
  startDate: Date | null;
  dueDate: Date | null;
  estimatedDuration: number | null;
  dependencies: number[];
};

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function task(id: number, opts: Partial<Fixture> = {}): Fixture {
  return {
    id,
    startDate: opts.startDate ?? null,
    dueDate: opts.dueDate ?? null,
    estimatedDuration: opts.estimatedDuration ?? null,
    dependencies: opts.dependencies ?? [],
  };
}

/** The server signature wants a full Task row; the algorithm only reads these five fields. */
const asTasks = (rows: Fixture[]) => rows as unknown as Parameters<typeof serverCascadeFrom>[0];
const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe("cascadeFrom", () => {
  it("pushes a dependent that starts before its dependency ends", () => {
    const rows = [
      task(1, { startDate: day("2026-10-05"), estimatedDuration: 5 }),
      task(2, { startDate: day("2026-10-06"), estimatedDuration: 2, dependencies: [1] }),
    ];
    const changes = serverCascadeFrom(asTasks(rows), 1);
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe(2);
    expect(iso(changes[0].startDate)).toBe(day("2026-10-10").toISOString());
    // No dueDate was set, so none is invented.
    expect(changes[0].dueDate).toBeNull();
  });

  it("leaves a dependent alone when it already starts after every dependency ends", () => {
    const rows = [
      task(1, { startDate: day("2026-10-01"), estimatedDuration: 2 }),
      task(2, { startDate: day("2026-10-20"), estimatedDuration: 2, dependencies: [1] }),
    ];
    expect(serverCascadeFrom(asTasks(rows), 1)).toEqual([]);
  });

  it("never pulls a dependent earlier", () => {
    const rows = [
      task(1, { startDate: day("2026-10-01"), estimatedDuration: 1 }),
      task(2, { startDate: day("2026-10-15"), estimatedDuration: 1, dependencies: [1] }),
    ];
    expect(serverCascadeFrom(asTasks(rows), 1)).toEqual([]);
  });

  it("compounds through a multi-hop chain", () => {
    const rows = [
      task(1, { startDate: day("2026-10-01"), estimatedDuration: 5 }),
      task(2, { startDate: day("2026-10-02"), estimatedDuration: 3, dependencies: [1] }),
      task(3, { startDate: day("2026-10-03"), estimatedDuration: 1, dependencies: [2] }),
    ];
    const changes = serverCascadeFrom(asTasks(rows), 1);
    const byId = new Map(changes.map((c) => [c.id, c]));
    expect(iso(byId.get(2)!.startDate)).toBe(day("2026-10-06").toISOString());
    // 2 now ends on the 9th, so 3 follows it rather than stopping at the 6th.
    expect(iso(byId.get(3)!.startDate)).toBe(day("2026-10-09").toISOString());
  });

  it("takes the latest of several dependencies", () => {
    const rows = [
      task(1, { startDate: day("2026-10-01"), estimatedDuration: 2 }),
      task(2, { startDate: day("2026-10-01"), estimatedDuration: 9 }),
      task(3, { startDate: day("2026-10-02"), estimatedDuration: 1, dependencies: [1, 2] }),
    ];
    const changes = serverCascadeFrom(asTasks(rows), 1);
    expect(iso(changes[0].startDate)).toBe(day("2026-10-10").toISOString());
  });

  it("carries an explicit dueDate forward but only when one exists", () => {
    const rows = [
      task(1, { startDate: day("2026-10-01"), estimatedDuration: 4 }),
      task(2, { startDate: day("2026-10-02"), dueDate: day("2026-10-04"), estimatedDuration: 2, dependencies: [1] }),
    ];
    const changes = serverCascadeFrom(asTasks(rows), 1);
    expect(iso(changes[0].startDate)).toBe(day("2026-10-05").toISOString());
    expect(iso(changes[0].dueDate)).toBe(day("2026-10-07").toISOString());
  });

  it("ignores unscheduled dependents — only the timeline cascades", () => {
    const rows = [
      task(1, { startDate: day("2026-10-01"), estimatedDuration: 4 }),
      task(2, { dependencies: [1] }),
    ];
    expect(serverCascadeFrom(asTasks(rows), 1)).toEqual([]);
  });

  it("returns nothing for a root with no dependents", () => {
    expect(serverCascadeFrom(asTasks([task(1, { startDate: day("2026-10-01") })]), 1)).toEqual([]);
  });
});

describe("wouldCreateCycle", () => {
  const rows = [task(1), task(2, { dependencies: [1] }), task(3, { dependencies: [2] })];

  it("rejects a self dependency", () => {
    expect(serverWouldCreateCycle(asTasks(rows), 1, [1])).toBe(true);
  });

  it("rejects a direct back-edge", () => {
    expect(serverWouldCreateCycle(asTasks(rows), 1, [2])).toBe(true);
  });

  it("rejects a transitive back-edge", () => {
    expect(serverWouldCreateCycle(asTasks(rows), 1, [3])).toBe(true);
  });

  it("allows an unrelated edge", () => {
    const extra = [...rows, task(4)];
    expect(serverWouldCreateCycle(asTasks(extra), 4, [3])).toBe(false);
    expect(serverWouldCreateCycle(asTasks(extra), 1, [4])).toBe(false);
  });

  it("allows clearing the list", () => {
    expect(serverWouldCreateCycle(asTasks(rows), 3, [])).toBe(false);
  });
});

/**
 * The Cascade view's slip preview runs a copy of this algorithm in the browser.
 * If the two ever drift, the preview lies about what a save would do — so the
 * copy is pinned to the original here, including on ISO-string input.
 */
describe("client copy stays identical to the server implementation", () => {
  const graphs: Fixture[][] = [
    [
      task(1, { startDate: day("2026-10-01"), estimatedDuration: 3 }),
      task(2, { startDate: day("2026-10-02"), estimatedDuration: 2, dependencies: [1] }),
      task(3, { startDate: day("2026-10-03"), dueDate: day("2026-10-06"), estimatedDuration: 1, dependencies: [1, 2] }),
      task(4, { dependencies: [3] }),
    ],
    [
      task(10, { startDate: day("2026-01-05"), estimatedDuration: 10 }),
      task(11, { startDate: day("2026-01-06"), estimatedDuration: 1, dependencies: [10] }),
      task(12, { startDate: day("2026-02-01"), estimatedDuration: 4, dependencies: [11] }),
    ],
  ];

  for (const [index, graph] of graphs.entries()) {
    for (const root of graph.map((t) => t.id)) {
      it(`graph ${index} root ${root}`, () => {
        const serverOut = serverCascadeFrom(asTasks(graph), root).map((c) => ({ id: c.id, start: iso(c.startDate), due: iso(c.dueDate) }));
        // The browser holds ISO strings, not Date objects.
        const wire = graph.map((t) => ({ ...t, startDate: iso(t.startDate), dueDate: iso(t.dueDate) }));
        const clientOut = clientCascadeFrom(wire, root).map((c) => ({ id: c.id, start: iso(c.startDate), due: iso(c.dueDate) }));
        expect(clientOut).toEqual(serverOut);
      });
    }
  }

  it("agrees on cycles too", () => {
    const graph = graphs[0];
    const wire = graph.map((t) => ({ ...t, startDate: iso(t.startDate), dueDate: iso(t.dueDate) }));
    for (const id of graph.map((t) => t.id)) {
      for (const dep of graph.map((t) => t.id)) {
        expect(clientWouldCreateCycle(wire, id, [dep])).toBe(serverWouldCreateCycle(asTasks(graph), id, [dep]));
      }
    }
  });
});
