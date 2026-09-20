import { api, callAction, getAuthHeader } from "@/lib/api";

/* ── Server shapes (server/importers/*, server/actions/import.ts) ─────── */

export type ImportKind = "task" | "time";
export type SourceArg = "auto" | Source;
export type Source = "jira" | "trello" | "asana" | "linear" | "notion" | "generic" | "toggl" | "clockify" | "harvest";

export interface SourceInfo {
  source: Source;
  kind: ImportKind;
  label: string;
  hint: string;
  template: string;
}

export interface SourceScore {
  source: Source;
  kind: ImportKind;
  label: string;
  score: number;
  matched: string[];
}

export interface FieldChoice {
  field: string;
  label: string;
}

export interface PreviewRow {
  row: number;
  action: "create" | "update" | "skip";
  reason: string | null;
  values: Record<string, unknown>;
  warnings: string[];
}

export interface PreviewResult {
  source: Source;
  kind: ImportKind;
  label: string;
  confidence: number;
  columns: string[];
  mapping: Record<string, string>;
  rows: PreviewRow[];
  totalRows: number;
  counts: { create: number; update: number; skip: number };
  creates: { streams: string[]; customers: string[] };
  warnings: string[];
  /** Why this source won, per candidate — the picker shows the matched headers. */
  scores: SourceScore[];
  fields: FieldChoice[];
  /** Only on the upload route. */
  filename?: string | null;
  bytes?: number;
}

export interface CommitResult {
  source: Source;
  kind: ImportKind;
  created: number;
  updated: number;
  skipped: number;
  streamsCreated?: string[];
  customersCreated?: string[];
  tasksLinked?: number;
  errors: string[];
  warnings: string[];
  at: string;
}

export interface ImportRun {
  at: string;
  source: Source;
  kind: ImportKind;
  by: string;
  created: number;
  updated: number;
  skipped: number;
  streamsCreated?: string[];
  customersCreated?: string[];
  errors: number;
}

export interface HistoryResult {
  runs: ImportRun[];
  note?: string;
  taskEventsViaImport: number;
  sources: { source: Source; kind: ImportKind; label: string; hint: string }[];
}

export interface FeedResult {
  scope: "me" | "org";
  path: string;
  url: string | null;
  tokenName: string;
  reused: boolean;
  rotated: number;
  note?: string;
  instructions: { google: string; apple: string; outlook: string };
  error?: string;
  message?: string;
}

export interface ImportRequest {
  source?: SourceArg;
  csv: string;
  mapping?: Record<string, string>;
  streamId?: number;
  defaultStreamName?: string;
}

/* ── Calls ───────────────────────────────────────────────────────────── */

export const IGNORE_FIELD = "-";

export const previewImport = (input: ImportRequest) => callAction<PreviewResult>("import.preview", { ...input });
export const commitImport = (input: ImportRequest) => callAction<CommitResult>("import.commit", { ...input });
export const importHistory = () => callAction<HistoryResult>("import.history", {});
export const calendarFeed = (scope: "me" | "org") => callAction<FeedResult>("ical.url", { scope });
export const listSources = () => api<SourceInfo[]>("/import/sources");

/**
 * Upload a dropped file through the multipart route rather than reading it into a
 * JSON body: a 5 MB export becomes ~6.7 MB once it is JSON-escaped, and the
 * browser streams a FormData body without holding a second copy of the text.
 */
export async function uploadCsv(file: File, source: SourceArg = "auto"): Promise<PreviewResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  // FormData sets its own multipart Content-Type with the boundary — the
  // application/json header from getAuthHeader() would break the upload.
  const { "Content-Type": _drop, ...headers } = getAuthHeader();
  const res = await fetch("/api/import/upload" + (source === "auto" ? "" : `?source=${source}`), {
    method: "POST",
    headers,
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `Upload failed (${res.status})`);
  return body as PreviewResult;
}

export const templateUrl = (source: Source) => `/api/import/template/${source}.csv`;

/** Absolute feed URL: the server only knows its own address when PTD_PUBLIC_URL is set. */
export function absoluteFeedUrl(feed: FeedResult): string {
  return feed.url ?? `${window.location.origin}${feed.path}`;
}
