import { api, callAction } from "@/lib/api";
import type { AppRow, NextTaskResult, OrgStats, StreamOption, StreamTotals, SystemicStream, TaskFilters, TaskPage } from "./types";

/**
 * The KPI strip and the backlog table read through the two bespoke GETs so the
 * browser can cache them and a URL can be shared; everything else goes through
 * the action registry, which is the same code path an agent's MCP call takes.
 */

export const fetchStats = () => api<OrgStats>("/org/stats");

/** Serialise filters into the querystring `GET /api/tasks/query` parses. */
export function taskQueryString(f: TaskFilters): string {
  const q = new URLSearchParams();
  if (f.search) q.set("search", f.search);
  if (f.streamId !== undefined) q.set("streamId", String(f.streamId));
  if (f.appId !== undefined) q.set("appId", String(f.appId));
  if (f.status && f.status.length > 0) for (const s of f.status) q.append("status", s);
  if (f.assignedTo !== undefined) q.set("assignedTo", String(f.assignedTo));
  if (f.priorityMin !== undefined) q.set("priorityMin", String(f.priorityMin));
  if (f.priorityMax !== undefined) q.set("priorityMax", String(f.priorityMax));
  if (f.effortMax !== undefined) q.set("effortMax", String(f.effortMax));
  if (f.tags && f.tags.length > 0) q.set("tags", f.tags.join(","));
  if (f.includeCompleted) q.set("includeCompleted", "1");
  if (f.sort) q.set("sort", f.sort);
  if (f.order) q.set("order", f.order);
  if (f.limit !== undefined) q.set("limit", String(f.limit));
  if (f.offset !== undefined) q.set("offset", String(f.offset));
  return q.toString();
}

export const fetchTasks = (f: TaskFilters) => {
  const qs = taskQueryString(f);
  return api<TaskPage>(`/tasks/query${qs ? `?${qs}` : ""}`);
};

export const fetchApps = (includeArchived = false) => callAction<unknown>("app.list", { includeArchived }).then((r) => asArray<AppRow>(r, "apps"));
export const fetchApp = (appId: number) => callAction<AppRow>("app.get", { appId });
export const fetchSystemic = (minApps = 2) => callAction<SystemicStream[]>("stream.systemic", { minApps });
export const fetchNextTask = (args: { streamId?: number; appId?: number; assignee?: "me" | "any" | "none" | number } = {}) =>
  callAction<NextTaskResult>("next_task", args);

export const createApp = (input: { key: string; name: string; urls?: string[]; repo?: string; stack?: string[] }) =>
  callAction<AppRow>("app.create", input);
export const updateApp = (input: { appId: number; name?: string; urls?: string[]; repo?: string | null; stack?: string[]; archived?: boolean }) =>
  callAction<AppRow>("app.update", input);

/**
 * `stream.list` and `stream.totals` are owned by the Plan and Track surfaces, so
 * their envelopes are theirs to change. Both readers accept either a bare array or
 * an object wrapping one, and neither can throw a shape error into a render: the
 * filter bar degrades to "all streams" and the Agents tab to "not available yet".
 */
function asArray<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const nested = (value as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return nested as T[];
  }
  return [];
}

export const fetchStreams = () => callAction<unknown>("stream.list", {}).then((r) => asArray<StreamOption>(r, "streams"));
export const fetchStreamTotals = () => callAction<unknown>("stream.totals", {}).then((r) => asArray<StreamTotals>(r, "totals"));
export { asArray };
