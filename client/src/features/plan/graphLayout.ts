import { groupAndOrder, orderTasks, type GroupContext } from "./logic";
import type { CascadeGroup, CascadeOrder, PlanTask } from "./types";

/**
 * Layered layout for the Cascade graph — written out by hand, because
 * package.json is frozen and a dependency graph of a few hundred cards does not
 * need a graph library.
 *
 * Three passes, the classic Sugiyama shape minus the dummy-node machinery:
 *
 *   1. Layering. `layer(card) = 1 + max(layer(of its dependencies))`, so a card
 *      sits one column right of its last dependency — longest-path layering,
 *      which puts every edge left→right and keeps the columns as narrow as the
 *      dependency depth allows.
 *   2. Ordering. Rows inside a column start in the order the Cascade controls
 *      ask for (group by → band, order by → rank inside the band), then a few
 *      barycentre sweeps pull each card towards the average row of its
 *      neighbours — down-sweeps look at dependencies, up-sweeps at dependents.
 *      A sweep may only reorder cards *within* a band, so the grouping the user
 *      chose survives the crossing reduction, and the arrangement with the
 *      fewest crossings wins.
 *   3. Geometry. Columns are fixed-pitch; bands stack vertically, each as tall
 *      as its widest column, with its cards centred in it.
 *
 * Long edges (a card that depends on something two or more columns back) are
 * drawn straight through the intervening column rather than routed around it —
 * no dummy nodes — so they pass behind the opaque cards. That is the one
 * deliberate simplification against a textbook implementation.
 */

export const NODE_W = 198;
export const NODE_H = 62;
const GAP_X = 76;
const GAP_Y = 16;
const BAND_LABEL_H = 26;
const BAND_PAD_BOTTOM = 14;
const BAND_GAP = 10;
export const PAD = 28;

/** Above this many edges the barycentre sweeps are skipped — O(E²) crossing counting. */
const SWEEP_EDGE_LIMIT = 600;
/** Above this many cards the hover cones fall back to immediate neighbours. */
const CLOSURE_NODE_LIMIT = 400;
const SWEEPS = 4;

export interface GraphNode {
  task: PlanTask;
  layer: number;
  /** Index into `GraphLayout.bands`. */
  band: number;
  /** Row inside the band, top to bottom. */
  row: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  key: string;
  /** The dependency (left end). */
  fromId: number;
  /** The card that depends on it (right end). */
  toId: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Columns the edge spans; >1 means it passes behind a column of cards. */
  span: number;
}

export interface GraphBand {
  key: string;
  label: string;
  index: number;
  top: number;
  height: number;
  count: number;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  bands: GraphBand[];
  nodeById: Map<number, GraphNode>;
  /** Everything a card (transitively) depends on, and everything that depends on it. */
  upstream: Map<number, Set<number>>;
  downstream: Map<number, Set<number>>;
  width: number;
  height: number;
  layerCount: number;
  crossings: number;
  /** True when the hover cones are only one hop deep (very large graph). */
  shallowCones: boolean;
}

export interface LayoutOptions {
  order: CascadeOrder;
  /** null draws one unlabelled band — the plain DAG. */
  group: CascadeGroup | null;
  ctx: GroupContext;
}

const EMPTY_LAYOUT: GraphLayout = {
  nodes: [],
  edges: [],
  bands: [],
  nodeById: new Map(),
  upstream: new Map(),
  downstream: new Map(),
  width: 0,
  height: 0,
  layerCount: 0,
  crossings: 0,
  shallowCones: false,
};

/** Dependencies that actually exist in this set, de-duplicated, self-links dropped. */
function depsWithin(task: PlanTask, byId: Map<number, PlanTask>): number[] {
  const raw = Array.isArray(task.dependencies) ? task.dependencies : [];
  const out: number[] = [];
  for (const id of raw) {
    if (id === task.id || !byId.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * Longest-path layering. The `visiting` set breaks a dependency cycle by
 * treating the back-edge as weightless, so a legacy loop lays out as a column
 * of cards instead of blowing the stack.
 */
function assignLayers(tasks: PlanTask[], deps: Map<number, number[]>): Map<number, number> {
  const layer = new Map<number, number>();
  const visiting = new Set<number>();

  const resolve = (id: number): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    for (const dep of deps.get(id) ?? []) best = Math.max(best, resolve(dep) + 1);
    visiting.delete(id);
    layer.set(id, best);
    return best;
  };

  for (const task of tasks) resolve(task.id);
  return layer;
}

/** Edge crossings, counted only between edges whose two ends share both columns. */
function countCrossings(edges: { fromId: number; toId: number }[], layerOf: Map<number, number>, position: Map<number, number>): number {
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i];
      const b = edges[j];
      if (layerOf.get(a.fromId) !== layerOf.get(b.fromId)) continue;
      if (layerOf.get(a.toId) !== layerOf.get(b.toId)) continue;
      const fromDelta = (position.get(a.fromId) ?? 0) - (position.get(b.fromId) ?? 0);
      const toDelta = (position.get(a.toId) ?? 0) - (position.get(b.toId) ?? 0);
      if (fromDelta * toDelta < 0) crossings++;
    }
  }
  return crossings;
}

function positionsOf(columns: number[][]): Map<number, number> {
  const position = new Map<number, number>();
  for (const column of columns) column.forEach((id, index) => position.set(id, index));
  return position;
}

/**
 * The plan as a layered DAG. `tasks` is whatever the caller wants drawn (the
 * Cascade view passes the open cards); ids outside that set are ignored, so a
 * dependency on a completed card simply has no edge.
 */
export function layoutGraph(tasks: PlanTask[], options: LayoutOptions): GraphLayout {
  if (tasks.length === 0) return EMPTY_LAYOUT;

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const deps = new Map<number, number[]>();
  const successors = new Map<number, number[]>();
  for (const task of tasks) {
    const list = depsWithin(task, byId);
    deps.set(task.id, list);
    for (const dep of list) {
      const arr = successors.get(dep) ?? [];
      arr.push(task.id);
      successors.set(dep, arr);
    }
  }

  /* ─── 1. layering ─── */
  const layerOf = assignLayers(tasks, deps);
  const layerCount = Math.max(...tasks.map((t) => layerOf.get(t.id) ?? 0)) + 1;

  /* ─── bands and the initial rank inside them ─── */
  const bandOf = new Map<number, number>();
  const rankOf = new Map<number, number>();
  const bandMeta: { key: string; label: string }[] = [];
  if (options.group) {
    const groups = groupAndOrder(tasks, options.group, options.order, options.ctx);
    groups.forEach((group, index) => {
      bandMeta.push({ key: group.key, label: group.label });
      group.tasks.forEach((task, rank) => {
        bandOf.set(task.id, index);
        rankOf.set(task.id, rank);
      });
    });
  } else {
    bandMeta.push({ key: "all", label: "" });
    orderTasks(tasks, options.order).forEach((task, rank) => {
      bandOf.set(task.id, 0);
      rankOf.set(task.id, rank);
    });
  }

  /* ─── 2. ordering inside each column ─── */
  const compare = (a: number, b: number) =>
    (bandOf.get(a) ?? 0) - (bandOf.get(b) ?? 0) || (rankOf.get(a) ?? 0) - (rankOf.get(b) ?? 0) || a - b;

  let columns: number[][] = Array.from({ length: layerCount }, () => []);
  for (const task of tasks) columns[layerOf.get(task.id) ?? 0].push(task.id);
  columns = columns.map((column) => column.sort(compare));

  const edgeList = tasks.flatMap((task) => (deps.get(task.id) ?? []).map((dep) => ({ fromId: dep, toId: task.id })));
  let crossings = countCrossings(edgeList, layerOf, positionsOf(columns));

  if (edgeList.length <= SWEEP_EDGE_LIMIT && layerCount > 1) {
    const barycentre = (id: number, neighbours: Map<number, number[]>, position: Map<number, number>): number | null => {
      const list = neighbours.get(id) ?? [];
      if (list.length === 0) return null;
      let total = 0;
      let seen = 0;
      for (const other of list) {
        const at = position.get(other);
        if (at === undefined) continue;
        total += at;
        seen++;
      }
      return seen ? total / seen : null;
    };

    // Sort a column by barycentre, but never across a band boundary: the
    // grouping the user picked outranks crossing reduction.
    const sweep = (current: number[][], neighbours: Map<number, number[]>, descending: boolean): number[][] => {
      const next = current.map((column) => column.slice());
      const indices = next.map((_, index) => index);
      for (const index of descending ? indices.slice().reverse() : indices) {
        const position = positionsOf(next);
        const column = next[index];
        const keyed = column.map((id, at) => ({ id, at, bary: barycentre(id, neighbours, position) }));
        keyed.sort(
          (a, b) =>
            (bandOf.get(a.id) ?? 0) - (bandOf.get(b.id) ?? 0) ||
            (a.bary ?? a.at) - (b.bary ?? b.at) ||
            (rankOf.get(a.id) ?? 0) - (rankOf.get(b.id) ?? 0) ||
            a.id - b.id
        );
        next[index] = keyed.map((k) => k.id);
      }
      return next;
    };

    let best = columns.map((column) => column.slice());
    let working = columns;
    for (let pass = 0; pass < SWEEPS; pass++) {
      working = sweep(working, deps, false);
      working = sweep(working, successors, true);
      const score = countCrossings(edgeList, layerOf, positionsOf(working));
      if (score < crossings) {
        crossings = score;
        best = working.map((column) => column.slice());
      }
      if (crossings === 0) break;
    }
    columns = best;
  }

  /* ─── 3. geometry ─── */
  const labelHeight = options.group ? BAND_LABEL_H : 0;
  // A band is as tall as its busiest column.
  const rowsPerBand = bandMeta.map((_, band) =>
    Math.max(1, ...columns.map((column) => column.filter((id) => bandOf.get(id) === band).length))
  );
  const bands: GraphBand[] = [];
  let cursor = 0;
  bandMeta.forEach((meta, index) => {
    const rows = rowsPerBand[index];
    const height = labelHeight + rows * NODE_H + (rows - 1) * GAP_Y + BAND_PAD_BOTTOM;
    bands.push({
      ...meta,
      index,
      top: cursor,
      height,
      count: tasks.filter((task) => bandOf.get(task.id) === index).length,
    });
    cursor += height + (options.group ? BAND_GAP : 0);
  });
  const totalHeight = Math.max(0, cursor - (options.group ? BAND_GAP : 0));

  const nodes: GraphNode[] = [];
  columns.forEach((column, layer) => {
    // Cards of one band inside one column are centred against the band's height,
    // so a sparse column reads as a run through the middle of its band.
    const perBand = new Map<number, number[]>();
    for (const id of column) {
      const band = bandOf.get(id) ?? 0;
      const list = perBand.get(band) ?? [];
      list.push(id);
      perBand.set(band, list);
    }
    for (const [band, ids] of perBand) {
      const offset = Math.floor((rowsPerBand[band] - ids.length) / 2);
      ids.forEach((id, index) => {
        const row = offset + index;
        nodes.push({
          task: byId.get(id)!,
          layer,
          band,
          row,
          x: PAD + layer * (NODE_W + GAP_X),
          y: PAD + bands[band].top + labelHeight + row * (NODE_H + GAP_Y),
        });
      });
    }
  });

  const nodeById = new Map(nodes.map((node) => [node.task.id, node]));
  const edges: GraphEdge[] = [];
  for (const edge of edgeList) {
    const from = nodeById.get(edge.fromId);
    const to = nodeById.get(edge.toId);
    if (!from || !to) continue;
    edges.push({
      key: `${edge.fromId}-${edge.toId}`,
      fromId: edge.fromId,
      toId: edge.toId,
      x1: from.x + NODE_W,
      y1: from.y + NODE_H / 2,
      x2: to.x,
      y2: to.y + NODE_H / 2,
      span: Math.max(1, to.layer - from.layer),
    });
  }

  /* ─── hover cones ─── */
  const shallowCones = tasks.length > CLOSURE_NODE_LIMIT;
  const closure = (adjacency: Map<number, number[]>): Map<number, Set<number>> => {
    const out = new Map<number, Set<number>>();
    for (const task of tasks) {
      const reached = new Set<number>();
      const stack = [...(adjacency.get(task.id) ?? [])];
      while (stack.length) {
        const id = stack.pop()!;
        if (reached.has(id) || id === task.id) continue;
        reached.add(id);
        if (!shallowCones) stack.push(...(adjacency.get(id) ?? []));
      }
      out.set(task.id, reached);
    }
    return out;
  };

  return {
    nodes,
    edges,
    bands,
    nodeById,
    upstream: closure(deps),
    downstream: closure(successors),
    width: PAD * 2 + layerCount * NODE_W + (layerCount - 1) * GAP_X,
    height: PAD * 2 + totalHeight,
    layerCount,
    crossings,
    shallowCones,
  };
}

/**
 * A cubic that leaves the dependency horizontally and arrives at the dependent
 * horizontally, so every edge reads left→right however far it has to travel.
 */
export function edgePath(edge: GraphEdge): string {
  const dx = Math.max(28, (edge.x2 - edge.x1) / 2);
  return `M ${edge.x1} ${edge.y1} C ${edge.x1 + dx} ${edge.y1}, ${edge.x2 - dx} ${edge.y2}, ${edge.x2} ${edge.y2}`;
}

/**
 * SVG has no text-overflow, so a title is clipped by character count against an
 * average glyph width. Deliberately conservative — a clipped word reads better
 * than one that spills over the card's rule.
 */
export function ellipsize(text: string, maxWidth: number, fontSize: number, widthFactor = 0.5): string {
  const perChar = fontSize * widthFactor;
  const fits = Math.floor(maxWidth / perChar);
  if (text.length <= fits) return text;
  return `${text.slice(0, Math.max(1, fits - 1)).trimEnd()}…`;
}
