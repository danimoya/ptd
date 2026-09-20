/**
 * Fixtures for the hybrid fold.
 *
 * Rows are shaped exactly as `server/overview/hybrid.ts` reads them back from the
 * engine — seconds, tokens and cost arrive as strings through postgres.js, so the
 * fixtures hand back strings too. A fold that only survives numbers is a fold
 * that breaks the first time it meets the database.
 */

import type { CompletionRow, HybridEntryRow, StreamRef, TaskCostRow } from "../../server/overview/hybrid";

export const AT = (day: number, hour = 9) => new Date(2026, 8, day, hour, 0, 0); // September 2026, local

export interface EntrySpec {
  day: number;
  hour?: number;
  minutes: number;
  agent?: boolean;
  userId?: number;
  name?: string;
  streamId?: number | null;
  appId?: number | null;
  taskId?: number | null;
  tokens?: number;
  cost?: number;
}

export function entry(spec: EntrySpec): HybridEntryRow {
  return {
    userId: spec.userId ?? (spec.agent ? 90 : 10),
    displayName: spec.name ?? (spec.agent ? "Claude Code" : "Elena Draftworks"),
    streamId: spec.streamId === undefined ? 1 : spec.streamId,
    taskId: spec.taskId === undefined ? 100 : spec.taskId,
    appId: spec.appId === undefined ? 1 : spec.appId,
    checkIn: AT(spec.day, spec.hour),
    entrySource: spec.agent ? "agent" : "human",
    agentLabel: spec.agent ? (spec.name ?? "Claude Code") : null,
    // Strings, as postgres.js hands them over.
    seconds: String(spec.minutes * 60),
    tokens: spec.agent ? String(spec.tokens ?? 0) : null,
    cost: spec.agent ? String(spec.cost ?? 0) : null,
  };
}

export const STREAMS: StreamRef[] = [
  { id: 1, name: "Security audit", agentBudgetUsd: 25, archived: false },
  { id: 2, name: "Checkout redesign", agentBudgetUsd: null, archived: false },
  { id: 3, name: "API v2", agentBudgetUsd: 4, archived: false },
  { id: 9, name: "Retired lane", agentBudgetUsd: 100, archived: true },
];

export const APPS = [
  { id: 1, key: "web", name: "Atelier Web" },
  { id: 2, key: "api", name: "Atelier API" },
];

export const completion = (taskId: number | null, actorUserId: number | null = null): CompletionRow => ({ taskId, actorUserId });

export const taskCost = (taskId: number, agentMinutes: number, tokens: number, cost: number): TaskCostRow => ({
  taskId,
  agentSeconds: String(agentMinutes * 60),
  humanSeconds: "0",
  tokens: String(tokens),
  cost: String(cost),
});

export const BASE = {
  from: AT(14, 0),
  to: new Date(2026, 8, 20, 23, 59, 59, 999),
  groupBy: "day" as const,
  streams: STREAMS,
  apps: APPS,
  completions: [] as CompletionRow[],
  taskCosts: [] as TaskCostRow[],
};
