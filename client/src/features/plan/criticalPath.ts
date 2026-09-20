import type { CriticalPathEntry, CriticalPathResponse } from "./types";

/**
 * The read side of the `critical_path` action.
 *
 * Nothing here computes a schedule — the forward/backward pass lives on the
 * server (server/plan/taskOps.ts `computeCpmSchedule`) precisely so the
 * Timeline's float numbers, the Cascade graph's red chain and an agent asking
 * over MCP cannot drift apart. This module only indexes the answer and decides
 * which *edges* of the dependency graph the chain actually runs along, which is
 * a question the wire shape leaves to the reader.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CpIndex {
  /** True once a CPM schedule is in hand — otherwise every lookup is empty. */
  ready: boolean;
  onPath: (taskId: number) => boolean;
  /** Slack in days, or null for a card the schedule does not cover. */
  floatOf: (taskId: number) => number | null;
  entry: (taskId: number) => CriticalPathEntry | null;
  /** True when the chain runs through this dependency edge (`from` → `to`). */
  isCriticalEdge: (fromId: number, toId: number) => boolean;
  /** Longest-chain length in days, as the action's original fields report it. */
  totalDays: number;
  projectFinish: string | null;
  count: number;
}

const EMPTY: CpIndex = {
  ready: false,
  onPath: () => false,
  floatOf: () => null,
  entry: () => null,
  isCriticalEdge: () => false,
  totalDays: 0,
  projectFinish: null,
  count: 0,
};

function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * Index one `critical_path` response.
 *
 * Two shapes are tolerated on purpose. With `perTask` (the CPM passes) an edge
 * is critical when both ends have zero float *and* the hand-off is tight — the
 * dependent starts the very day its dependency finishes; a zero-float card that
 * happens to sit above another one is not a link in the chain. Without it — an
 * older server, or a response that predates the change — the legacy `tasks[]`
 * array is the chain in dependency order, so consecutive pairs are its edges.
 */
export function buildCpIndex(response?: CriticalPathResponse | null): CpIndex {
  if (!response) return EMPTY;

  const rows = Array.isArray(response.perTask) ? response.perTask : [];
  const byId = new Map(rows.map((row) => [row.taskId, row]));
  const chain = Array.isArray(response.tasks) ? response.tasks.map((t) => t.id) : [];
  const legacy = new Set(chain);
  const legacyEdges = new Set<string>();
  for (let i = 1; i < chain.length; i++) legacyEdges.add(`${chain[i - 1]}>${chain[i]}`);

  // A response with neither reading is not worth an overlay.
  if (rows.length === 0 && chain.length === 0) return EMPTY;

  const onPath = (taskId: number) => (rows.length ? byId.get(taskId)?.onCriticalPath === true : legacy.has(taskId));

  return {
    ready: true,
    onPath,
    floatOf: (taskId) => {
      const row = byId.get(taskId);
      return row ? row.floatDays : null;
    },
    entry: (taskId) => byId.get(taskId) ?? null,
    isCriticalEdge: (fromId, toId) => {
      if (!onPath(fromId) || !onPath(toId)) return false;
      if (rows.length === 0) return legacyEdges.has(`${fromId}>${toId}`);
      const from = byId.get(fromId);
      const to = byId.get(toId);
      if (!from || !to) return false;
      return daysBetween(from.earliestFinish, to.earliestStart) === 0;
    },
    totalDays: response.totalDays ?? 0,
    projectFinish: response.projectFinish ?? null,
    count: rows.length ? rows.filter((row) => row.onCriticalPath).length : chain.length,
  };
}

/** Prose for the float tooltip — the same sentence everywhere the number shows. */
export function floatExplainer(days: number | null): string {
  if (days === null) return "Float unknown — the plan has no schedule for this card yet.";
  if (days === 0) return "No float: this card is on the critical path. A day late here is a day late for the whole plan.";
  return `Float ${days} day${days === 1 ? "" : "s"}: this card can slip that far before it pushes anything downstream, and the plan's finish with it.`;
}
