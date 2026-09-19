import { addDays } from "date-fns";
import type { MemberRow } from "@/lib/api";
import { cascadeFrom } from "./cascade";
import type { CascadeGroup, CascadeOrder, PlanApp, PlanStream, PlanTask } from "./types";

/**
 * Pure view logic for the Plan surface: priority bands, ordering, grouping,
 * the dependency forest the Cascade view renders, and the slip preview. All of
 * it lives outside the components so tests/plan can exercise it directly.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* ─────────── priority ─────────── */

export type BandKey = "muted" | "ink" | "ochre" | "vermilion";

/**
 * 0–24 muted · 25–49 ink · 50–74 ochre · 75–100 vermilion.
 * The ochre step is spelled out as an arbitrary HSL value because the PTD
 * palette aliases `ochre` onto vermilion, and the band has to read as its own
 * step between ink and the alarm colour.
 */
export function priorityBand(score: number): { key: BandKey; text: string; dot: string; label: string } {
  if (score >= 75) return { key: "vermilion", text: "text-vermilion", dot: "bg-vermilion", label: "critical" };
  if (score >= 50) return { key: "ochre", text: "text-[hsl(36_72%_36%)] dark:text-[hsl(38_78%_60%)]", dot: "bg-[hsl(36_72%_40%)]", label: "high" };
  if (score >= 25) return { key: "ink", text: "text-ink", dot: "bg-ink", label: "normal" };
  return { key: "muted", text: "text-ink-muted", dot: "bg-ink-muted/50", label: "low" };
}

/* ─────────── dates ─────────── */

export function endOf(task: Pick<PlanTask, "startDate" | "dueDate" | "estimatedDuration">): Date | null {
  if (!task.startDate) return null;
  const start = new Date(task.startDate);
  if (task.dueDate) {
    const due = new Date(task.dueDate);
    return due > start ? due : start;
  }
  return addDays(start, task.estimatedDuration ?? 0);
}

/** Slack in days. Uses the server-derived value when present so the two never disagree. */
export function slackOf(task: PlanTask): number | null {
  if (typeof task.slackDays === "number") return task.slackDays;
  if (!task.startDate || !task.dueDate) return null;
  const work = new Date(task.startDate).getTime() + (task.estimatedDuration ?? 0) * MS_PER_DAY;
  return Math.round((new Date(task.dueDate).getTime() - work) / MS_PER_DAY);
}

/* ─────────── ordering ─────────── */

/**
 * Sort for the Cascade view. Every mode pushes rows with nothing to sort on to
 * the bottom rather than letting them float to the top as zeroes/epoch dates.
 */
export function orderTasks(tasks: PlanTask[], order: CascadeOrder): PlanTask[] {
  const keyed = tasks.map((task) => ({ task, key: orderKey(task, order) }));
  keyed.sort((a, b) => {
    if (a.key === null && b.key === null) return a.task.id - b.task.id;
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    if (a.key !== b.key) return order === "priority_score" ? b.key - a.key : a.key - b.key;
    return a.task.id - b.task.id;
  });
  return keyed.map((k) => k.task);
}

function orderKey(task: PlanTask, order: CascadeOrder): number | null {
  switch (order) {
    case "priority_score":
      return task.priorityScore;
    case "due_date":
      return task.dueDate ? new Date(task.dueDate).getTime() : null;
    case "start_date":
      return task.startDate ? new Date(task.startDate).getTime() : null;
    case "float":
      return slackOf(task);
  }
}

export const ORDER_LABELS: Record<CascadeOrder, string> = {
  priority_score: "Priority",
  due_date: "Due date",
  start_date: "Start date",
  float: "Float",
};

export const GROUP_LABELS: Record<CascadeGroup, string> = {
  stream: "Stream",
  app: "App",
  assignee: "Assignee",
  source: "Source",
};

/* ─────────── grouping ─────────── */

export interface GroupContext {
  streams: PlanStream[];
  apps: PlanApp[];
  members: MemberRow[];
}

/** Agent vs human, decided by the assignee's seat — not by who typed the edit. */
export function sourceOf(task: PlanTask, members: MemberRow[]): "agent" | "human" | "unassigned" {
  if (!task.assignedTo) return "unassigned";
  const member = members.find((m) => m.userId === task.assignedTo);
  if (!member) return "human";
  return member.isAgent ? "agent" : "human";
}

export function groupKeyFor(task: PlanTask, group: CascadeGroup, ctx: GroupContext): { key: string; label: string } {
  switch (group) {
    case "stream": {
      const stream = ctx.streams.find((s) => s.id === task.streamId);
      return { key: `stream:${task.streamId ?? "none"}`, label: stream?.name ?? "No stream" };
    }
    case "app": {
      const app = ctx.apps.find((a) => a.id === task.appId);
      return { key: `app:${task.appId ?? "none"}`, label: app ? app.name : "No app" };
    }
    case "assignee": {
      const member = ctx.members.find((m) => m.userId === task.assignedTo);
      return { key: `user:${task.assignedTo ?? "none"}`, label: member?.displayName ?? "Unassigned" };
    }
    case "source": {
      const source = sourceOf(task, ctx.members);
      return { key: `source:${source}`, label: source === "agent" ? "Agent work" : source === "human" ? "Human work" : "Unassigned" };
    }
  }
}

export interface TaskGroup {
  key: string;
  label: string;
  tasks: PlanTask[];
}

/** Group, then order inside each group, then order the groups by their best row. */
export function groupAndOrder(tasks: PlanTask[], group: CascadeGroup, order: CascadeOrder, ctx: GroupContext): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const task of tasks) {
    const { key, label } = groupKeyFor(task, group, ctx);
    const entry = groups.get(key) ?? { key, label, tasks: [] };
    entry.tasks.push(task);
    groups.set(key, entry);
  }
  const out = Array.from(groups.values()).map((g) => ({ ...g, tasks: orderTasks(g.tasks, order) }));
  out.sort((a, b) => {
    const rank = orderTasks([a.tasks[0], b.tasks[0]], order);
    if (rank[0] === a.tasks[0] && rank[1] === b.tasks[0]) return -1;
    if (rank[0] === b.tasks[0] && rank[1] === a.tasks[0]) return 1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

/* ─────────── dependency forest ─────────── */

export interface CascadeNode {
  task: PlanTask;
  /** Unique per position in the tree, so the same card can be expanded independently under each parent. */
  path: string;
  depth: number;
  children: CascadeNode[];
  /** Ids of the dependencies this card sits under; >1 means it is shown more than once. */
  parentIds: number[];
  duplicate: boolean;
  /** Reachable only through a dependency loop — shown as its own root so it never disappears. */
  orphan: boolean;
}

/**
 * Roots are the cards nothing has to happen before (no dependencies); each
 * card that depends on a root is nested underneath it, recursively. A card with
 * several dependencies appears under each of them and is flagged `duplicate`.
 *
 * `maxDepth` stops a pathological graph (a cycle that predates the server-side
 * cycle check) from recursing forever.
 */
export function buildForest(tasks: PlanTask[], maxDepth = 24): CascadeNode[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depsOf = (t: PlanTask) => (Array.isArray(t.dependencies) ? t.dependencies : []).filter((id) => byId.has(id));
  const childrenOf = new Map<number, PlanTask[]>();
  for (const task of tasks) {
    for (const depId of depsOf(task)) {
      const list = childrenOf.get(depId) ?? [];
      list.push(task);
      childrenOf.set(depId, list);
    }
  }
  const visited = new Set<number>();

  const build = (task: PlanTask, prefix: string, depth: number, ancestors: Set<number>): CascadeNode => {
    visited.add(task.id);
    const parentIds = depsOf(task);
    const path = `${prefix}/${task.id}`;
    const node: CascadeNode = {
      task,
      path,
      depth,
      children: [],
      parentIds,
      duplicate: parentIds.length > 1,
      orphan: false,
    };
    if (depth >= maxDepth) return node;
    const nextAncestors = new Set(ancestors).add(task.id);
    node.children = (childrenOf.get(task.id) ?? [])
      .filter((child) => !nextAncestors.has(child.id))
      .map((child) => build(child, path, depth + 1, nextAncestors));
    return node;
  };

  const roots = tasks.filter((t) => depsOf(t).length === 0).map((t) => build(t, "", 0, new Set()));
  // Anything only reachable through a loop still deserves a row.
  const stranded = tasks
    .filter((t) => !visited.has(t.id))
    .map((t) => ({ ...build(t, "#", 0, new Set()), orphan: true }));
  return [...roots, ...stranded];
}

/** Depth-first flatten, honouring the caller's collapsed set. */
export function flattenForest(
  nodes: CascadeNode[],
  isCollapsed: (path: string) => boolean,
  order: CascadeOrder
): CascadeNode[] {
  const out: CascadeNode[] = [];
  const walk = (list: CascadeNode[]) => {
    const ordered = orderTasks(list.map((n) => n.task), order);
    for (const task of ordered) {
      const node = list.find((n) => n.task.id === task.id)!;
      out.push(node);
      if (node.children.length && !isCollapsed(node.path)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/* ─────────── slip preview ─────────── */

export interface SlipRow {
  taskId: number;
  startDate: string;
  dueDate: string | null;
  /** True for the card the user pushed, false for everything the cascade dragged along. */
  root: boolean;
}

/**
 * "If I push this card N days, what else moves?" — applies the shift locally
 * and runs the same cascade the server would, so the preview and the write
 * agree. Returns one row per card whose dates would change.
 */
export function slipPreview(tasks: PlanTask[], rootId: number, days: number): SlipRow[] {
  const root = tasks.find((t) => t.id === rootId);
  if (!root || !root.startDate || days === 0) return [];
  const newStart = addDays(new Date(root.startDate), days);
  const newDue = root.dueDate ? addDays(new Date(root.dueDate), days) : null;

  const shifted = tasks.map((t) =>
    t.id === rootId ? { ...t, startDate: newStart.toISOString(), dueDate: newDue ? newDue.toISOString() : null } : t
  );
  const rows: SlipRow[] = [
    { taskId: rootId, startDate: newStart.toISOString(), dueDate: newDue ? newDue.toISOString() : null, root: true },
  ];
  for (const change of cascadeFrom(shifted, rootId)) {
    rows.push({
      taskId: change.id,
      startDate: change.startDate.toISOString(),
      dueDate: change.dueDate ? change.dueDate.toISOString() : null,
      root: false,
    });
  }
  return rows;
}

/* ─────────── lane colours ─────────── */

const LANE_PALETTE = ["#2f4858", "#8a3324", "#5b6b3a", "#9a6f10", "#5d4a6b", "#2d5b66", "#8c3f52", "#6b5637"];

/** A stream's own colour when it has one, otherwise a stable pick from the editorial palette. */
export function laneColor(seed: string | number, explicit?: string | null): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const text = String(seed);
  const hash = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return LANE_PALETTE[Math.abs(hash) % LANE_PALETTE.length];
}

export const pad4 = (n: number) => String(n).padStart(4, "0");

/* ─────────── calendar-day helpers ─────────── */

/**
 * Timestamps arrive as UTC midnight ("2026-10-05T00:00:00.000Z") because the
 * server parses date-only strings. Grid maths, the calendar widget and
 * date-fns all work in local time, so every date crossing that boundary goes
 * through here: UTC calendar day in, local midnight of the same day out. Doing
 * it any other way makes a card jump a day for anyone east or west of UTC.
 */
export function dayOf(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
}

/** "yyyy-MM-dd" of an ISO timestamp's UTC day — the comparable form. */
export function dayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/** "yyyy-MM-dd" of a local Date — what we send back to the server. */
export function toDayString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Live formula score, mirroring db/schema.ts priorityScore() for the sliders. */
export function formulaScore(urgency: number, impact: number, effort: number): number {
  return Math.max(0, Math.min(100, Math.round((urgency * impact) / Math.max(effort, 1))));
}

/* ─────────── timeline lanes ─────────── */

export interface Lane {
  key: string;
  label: string;
  color: string;
  streamId: number | null;
  assigneeId: number | null;
  isAgent: boolean;
  tasks: PlanTask[];
}

/**
 * Group the scheduled cards into swim-lanes. Streams keep their board order
 * (`position`), assignee lanes are alphabetical, and the catch-all lane is
 * always last so an unfiled card is visible but never on top.
 */
export function buildLanes(
  tasks: PlanTask[],
  groupBy: "stream" | "assignee",
  streams: PlanStream[],
  members: { userId: number; displayName: string; isAgent: boolean }[]
): Lane[] {
  const lanes = new Map<string, Lane>();
  const ensure = (key: string, init: () => Lane) => {
    const found = lanes.get(key);
    if (found) return found;
    const created = init();
    lanes.set(key, created);
    return created;
  };

  for (const task of tasks) {
    if (groupBy === "stream") {
      const stream = streams.find((s) => s.id === task.streamId) ?? null;
      const key = `stream:${stream?.id ?? "none"}`;
      ensure(key, () => ({
        key,
        label: stream?.name ?? "No stream",
        color: laneColor(stream?.id ?? "none", stream?.color),
        streamId: stream?.id ?? null,
        assigneeId: null,
        isAgent: false,
        tasks: [],
      })).tasks.push(task);
    } else {
      const member = members.find((m) => m.userId === task.assignedTo) ?? null;
      const key = `user:${member?.userId ?? "none"}`;
      ensure(key, () => ({
        key,
        label: member?.displayName ?? "Unassigned",
        color: laneColor(member?.userId ?? "none"),
        streamId: null,
        assigneeId: member?.userId ?? null,
        isAgent: !!member?.isAgent,
        tasks: [],
      })).tasks.push(task);
    }
  }

  const order = (lane: Lane): [number, number, string] => {
    if (groupBy === "stream") {
      const stream = streams.find((s) => s.id === lane.streamId);
      return [lane.streamId === null ? 1 : 0, stream?.position ?? 0, lane.label.toLowerCase()];
    }
    return [lane.assigneeId === null ? 1 : 0, 0, lane.label.toLowerCase()];
  };
  return Array.from(lanes.values()).sort((a, b) => {
    const [aLast, aPos, aLabel] = order(a);
    const [bLast, bPos, bLabel] = order(b);
    return aLast - bLast || aPos - bPos || aLabel.localeCompare(bLabel);
  });
}

/**
 * Greedy row packing inside a lane: walk the cards in start-date order and drop
 * each into the first row whose previous occupant has finished. Two cards that
 * start the same day deterministically land on different rows.
 */
export function packSlots(tasks: PlanTask[]): Map<number, number> {
  const slots = new Map<number, number>();
  const ends: number[] = [];
  const sorted = tasks
    .filter((t) => !!t.startDate)
    .sort((a, b) => {
      const at = new Date(a.startDate!).getTime();
      const bt = new Date(b.startDate!).getTime();
      return at - bt || a.id - b.id;
    });
  for (const task of sorted) {
    const start = new Date(task.startDate!).getTime();
    const end = start + (task.estimatedDuration ?? 0) * MS_PER_DAY;
    let placed = false;
    for (let i = 0; i < ends.length; i++) {
      if (ends[i] <= start) {
        ends[i] = end;
        slots.set(task.id, i);
        placed = true;
        break;
      }
    }
    if (!placed) {
      ends.push(end);
      slots.set(task.id, ends.length - 1);
    }
  }
  return slots;
}

/** Scheduled cards whose span overlaps [from, to] — i.e. what the month shows. */
export function tasksInWindow(tasks: PlanTask[], from: Date, to: Date): PlanTask[] {
  return tasks.filter((task) => {
    const start = dayOf(task.startDate);
    if (!start) return false;
    const due = dayOf(task.dueDate);
    const end = due && due > start ? due : addDays(start, task.estimatedDuration ?? 0);
    return start <= to && end >= from;
  });
}

/** Client-side mirror of the server's isBlocked, for the board's counters. */
export function isBlockedNow(task: PlanTask, all: PlanTask[], now = new Date()): boolean {
  const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
  if (deps.length === 0) return false;
  for (const depId of deps) {
    const dep = all.find((t) => t.id === depId);
    if (!dep || dep.completed) continue;
    const end = endOf(dep);
    if (!end || end > now) return true;
  }
  return false;
}
