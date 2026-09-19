/**
 * The Track surface's read/write vocabulary.
 *
 * Every call goes through the action registry (`callAction`), which is the same
 * entry point an agent uses over MCP — so anything the UI can do, an agent can
 * do, with the same validation and the same role gate. The one exception is the
 * picker feed, a plain GET that hands back streams + open tasks + customers in
 * one round trip (see server/track/routes.ts for why it is not an action).
 *
 * Nothing here sends `entrySource`, `agentLabel` or an agent's tokens: the
 * server derives attribution from the credential, and this client is always a
 * human session.
 */

import { api, callAction } from "@/lib/api";

export type EntrySource = "human" | "agent";

export interface EntryView {
  id: number;
  userId: number;
  userName: string | null;
  userIsAgentSeat: boolean | null;
  customerId: number | null;
  customerName: string | null;
  streamId: number | null;
  streamName: string | null;
  streamColor: string | null;
  taskId: number | null;
  taskTitle: string | null;
  checkIn: string;
  checkOut: string | null;
  isBreak: boolean;
  notes: string | null;
  entrySource: EntrySource;
  agentLabel: string | null;
  tokensUsed: number | null;
  apiCostUsd: number | null;
}

export interface OpenEntry extends EntryView {
  elapsedMinutes: number;
}

export interface Cut {
  id: number;
  isBreak: boolean;
  minutes: number;
}

export interface BySource {
  human: { minutes: number };
  agent: { minutes: number; tokens: number; costUsd: number };
}

export interface TodaySummary {
  date: string;
  minutes: number;
  breakMinutes: number;
  bySource: BySource;
  byStream: { streamId: number | null; streamName: string | null; streamColor: string | null; minutes: number; bySource: BySource }[];
  open: OpenEntry | null;
}

export interface TemplateRow {
  id: number;
  name: string;
  icon: string | null;
  notes: string | null;
  streamId: number | null;
  customerId: number | null;
  isBreak: boolean;
}

export interface StreamPick {
  id: number;
  name: string;
  color: string | null;
  customerId: number | null;
  archived: boolean;
  agentBudgetUsd: number | null;
}

export interface TaskPick {
  id: number;
  title: string;
  streamId: number | null;
  status: string;
  assignedTo: number | null;
  priorityScore: number;
  mine: boolean;
}

export interface CustomerPick {
  id: number;
  name: string;
  weeklyGoalHours: number | null;
}

export interface PickerFeed {
  streams: StreamPick[];
  tasks: TaskPick[];
  customers: CustomerPick[];
}

export interface StartArgs {
  taskId?: number;
  streamId?: number;
  customerId?: number;
  notes?: string;
  isBreak?: boolean;
}

export interface StopResult {
  entry: EntryView;
  minutes: number;
  ignored: string[];
  ignoredReason?: string;
}

export interface ListArgs {
  from?: string;
  to?: string;
  taskId?: number;
  streamId?: number;
  userId?: number | "all";
  limit?: number;
}

/* ── Query keys ──────────────────────────────────────────────────────── */

export const trackKeys = {
  all: ["track"] as const,
  current: ["track", "current"] as const,
  today: ["track", "today"] as const,
  templates: ["track", "templates"] as const,
  pickers: ["track", "pickers"] as const,
  entries: (scope: ListArgs) => ["track", "entries", scope] as const,
};

/* ── Reads ───────────────────────────────────────────────────────────── */

export const getCurrentEntry = () => callAction<OpenEntry | null>("time_entry.current");
export const getTodaySummary = () => callAction<TodaySummary>("today_summary");
export const listEntries = (args: ListArgs = {}) => callAction<EntryView[]>("time_entry.list", args as Record<string, unknown>);
export const listTemplates = () => callAction<TemplateRow[]>("template.list");
export const getPickers = () => api<PickerFeed>("/track/pickers");

/* ── Writes ──────────────────────────────────────────────────────────── */

export const startEntry = (args: StartArgs) => callAction<{ entry: EntryView; cut: Cut | null }>("time_entry.start", args as Record<string, unknown>);
export const stopEntry = (args: { notes?: string } = {}) => callAction<StopResult>("time_entry.stop", args);
export const switchBreak = (args: { templateId?: number; label?: string }) =>
  callAction<{ entry: EntryView; cut: Cut | null }>("time_entry.switch_break", args);
export const deleteEntry = (entryId: number) => callAction<{ deleted: boolean; entryId: number }>("time_entry.delete", { entryId });
export const updateEntry = (args: { entryId: number; checkIn?: string; checkOut?: string; taskId?: number; streamId?: number; customerId?: number; notes?: string }) =>
  callAction<{ entry: EntryView }>("time_entry.update", args as Record<string, unknown>);
export const logPast = (args: { checkIn: string; checkOut: string; taskId?: number; streamId?: number; customerId?: number; notes?: string; isBreak?: boolean }) =>
  callAction<{ entry: EntryView; minutes: number }>("time_entry.log_past", args as Record<string, unknown>);
export const createTemplate = (args: { name: string; icon?: string; notes?: string; streamId?: number; customerId?: number; isBreak?: boolean }) =>
  callAction<TemplateRow>("template.create", args as Record<string, unknown>);
export const deleteTemplate = (templateId: number) => callAction<{ deleted: boolean }>("template.delete", { templateId });
