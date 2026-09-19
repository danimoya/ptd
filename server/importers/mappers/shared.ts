/**
 * The interpretation layer every mapper leans on.
 *
 * A mapper's own file should read as a description of one export format — which
 * header means which PTD field — and nothing else. Everything that is genuinely
 * shared lives here: matching a header by shape rather than by exact spelling,
 * the date formats these tools actually emit, the status vocabularies, and the
 * two priority scales the brief pins down (Jira's five words, Linear's 1–4).
 */

import { createHash } from "crypto";
import type { TaskStatus } from "../../../db/schema";
import { IGNORE, type RowResult } from "../types";

/* ── Header matching ─────────────────────────────────────────────────── */

/**
 * Compare headers on letters and digits only, so `Due Date`, `due_date`,
 * `DueDate` and `Due date ` are one name, and Jira's `Labels (2)`
 * de-duplication suffix collapses into `labels2`.
 */
export function norm(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Strip the `(2)`/`(3)` suffix parseCsv adds to repeated headers. */
export function baseName(column: string): string {
  return column.replace(/\s*\(\d+\)\s*$/, "");
}

/** First column whose normalised name is exactly one of `names`. */
export function findColumn(columns: string[], names: string[]): string | null {
  const wanted = names.map(norm);
  for (const want of wanted) {
    const hit = columns.find((c) => norm(baseName(c)) === want);
    if (hit) return hit;
  }
  return null;
}

/** Every column whose normalised base name is exactly one of `names`, in file order. */
export function findColumns(columns: string[], names: string[]): string[] {
  const wanted = new Set(names.map(norm));
  return columns.filter((c) => wanted.has(norm(baseName(c))));
}

/** First column whose normalised name *contains* one of `fragments`. Last resort. */
export function findLike(columns: string[], fragments: string[]): string | null {
  for (const fragment of fragments.map(norm)) {
    const hit = columns.find((c) => norm(baseName(c)).includes(fragment));
    if (hit) return hit;
  }
  return null;
}

export function hasColumn(columns: string[], names: string[]): boolean {
  return findColumn(columns, names) !== null;
}

/** Assign `field` to the first of `names` that exists. Returns the column used. */
export function assign(
  map: Record<string, string>,
  columns: string[],
  field: string,
  names: string[]
): string | null {
  const column = findColumn(columns, names);
  if (column) map[column] = field;
  return column;
}

/** Assign `field` to *every* matching column (tags, which Jira repeats). */
export function assignAll(map: Record<string, string>, columns: string[], field: string, names: string[]): string[] {
  const hits = findColumns(columns, names);
  for (const c of hits) map[c] = field;
  return hits;
}

/** Leave every still-unmapped column explicitly ignored, so the UI shows intent. */
export function ignoreRest(map: Record<string, string>, columns: string[]): Record<string, string> {
  for (const c of columns) if (!map[c]) map[c] = IGNORE;
  return map;
}

/* ── Reading a row through a mapping ─────────────────────────────────── */

/** Columns mapped to `field`, in file order. */
export function columnsFor(mapping: Record<string, string>, field: string): string[] {
  return Object.keys(mapping).filter((c) => mapping[c] === field);
}

/** First non-empty value among the columns mapped to `field`. */
export function pick(row: Record<string, string>, mapping: Record<string, string>, field: string): string {
  for (const column of columnsFor(mapping, field)) {
    const v = (row[column] ?? "").trim();
    if (v) return v;
  }
  return "";
}

/** Every non-empty value among the columns mapped to `field`. */
export function pickAll(row: Record<string, string>, mapping: Record<string, string>, field: string): string[] {
  const out: string[] = [];
  for (const column of columnsFor(mapping, field)) {
    const v = (row[column] ?? "").trim();
    if (v) out.push(v);
  }
  return out;
}

/* ── Dates ───────────────────────────────────────────────────────────── */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * Parse the date shapes these exports actually contain.
 *
 * Handled, in order: ISO `2026-03-01[T…]`; Jira's `12/Mar/26 3:04 PM` and
 * `12/Mar/2026`; Notion's `March 1, 2026`; `01 Mar 2026`. Anything left over
 * goes to `Date.parse`, which reads `MM/DD/YYYY` — the slash forms are
 * genuinely ambiguous and every tool in this list writes US order there, so
 * that is the reading we document rather than guess per row.
 *
 * A date-only value becomes local midnight, matching how the Plan surface
 * parses `2026-03-01` (server/track/entries.ts parseWhen).
 */
export function parseDateish(raw: string): Date | null {
  const value = raw.trim();
  if (!value) return null;

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const [, y, m, d, hh, mm, ss] = iso;
    // Keep an explicit zone (Trello, Linear) exact; treat a bare stamp as local.
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return new Date(Number(y), Number(m) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0), Number(ss ?? 0));
  }

  // 12/Mar/26 3:04 PM · 12/Mar/2026 · 1 March 2026 · March 1, 2026
  const named = value.match(
    /^(?:(\d{1,2})[\/\s-]([A-Za-z]{3,9})[\/\s-](\d{2,4})|([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4}))(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/
  );
  if (named) {
    const [, d1, mon1, y1, mon2, d2, y2, hh, mm, ss, ampm] = named;
    const monthKey = (mon1 ?? mon2 ?? "").toLowerCase();
    const month = MONTHS[monthKey];
    if (month !== undefined) {
      const day = Number(d1 ?? d2);
      let year = Number(y1 ?? y2);
      if (year < 100) year += year < 70 ? 2000 : 1900;
      let hours = Number(hh ?? 0);
      if (ampm) {
        const pm = ampm.toLowerCase() === "pm";
        if (hours === 12) hours = pm ? 12 : 0;
        else if (pm) hours += 12;
      }
      return new Date(year, month, day, hours, Number(mm ?? 0), Number(ss ?? 0));
    }
  }

  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** Local midnight of whatever day `raw` denotes — the shape a task date wants. */
export function parseDay(raw: string): Date | null {
  const d = parseDateish(raw);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Combine a date cell and a time cell, the way every time tracker splits them.
 * A missing time means midnight; a missing date means no timestamp at all.
 */
export function parseDateAndTime(dateRaw: string, timeRaw: string): Date | null {
  const day = parseDay(dateRaw);
  if (!day) return null;
  const time = timeRaw.trim();
  if (!time) {
    const both = parseDateish(dateRaw);
    return both ?? day;
  }
  const m = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (!m) return day;
  let hours = Number(m[1]);
  if (m[4]) {
    const pm = m[4].toLowerCase() === "pm";
    if (hours === 12) hours = pm ? 12 : 0;
    else if (pm) hours += 12;
  }
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, Number(m[2]), Number(m[3] ?? 0));
}

/** `hh:mm:ss`, `hh:mm`, `1.5`, `1,5`, `90m`, `1h 30m` → milliseconds. */
export function parseDurationMs(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;

  const clock = value.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (clock) {
    return ((Number(clock[1]) * 60 + Number(clock[2])) * 60 + Number(clock[3] ?? 0)) * 1000;
  }

  const composite = value.match(/^(?:(\d+(?:[.,]\d+)?)\s*h)?\s*(?:(\d+(?:[.,]\d+)?)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?$/i);
  if (composite && (composite[1] || composite[2] || composite[3])) {
    const h = Number((composite[1] ?? "0").replace(",", "."));
    const m = Number((composite[2] ?? "0").replace(",", "."));
    const s = Number(composite[3] ?? "0");
    return Math.round((h * 3600 + m * 60 + s) * 1000);
  }

  const decimal = Number(value.replace(",", "."));
  return Number.isFinite(decimal) ? Math.round(decimal * 3_600_000) : null;
}

/* ── Numbers, lists, text ────────────────────────────────────────────── */

export function parseNumber(raw: string): number | null {
  const value = raw.trim().replace(/,/g, ".");
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Split a multi-value cell on `,` `;` `|` or newlines; trim, drop blanks, de-dupe. */
export function splitList(values: string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    for (const part of raw.split(/[,;|\n]/)) {
      const v = part.trim();
      if (v && !out.some((existing) => existing.toLowerCase() === v.toLowerCase())) out.push(v);
    }
  }
  return out;
}

const EMAIL = /[^\s<>,;"]+@[^\s<>,;"]+\.[^\s<>,;"]+/;

/** The first thing in the cell that looks like an address — `Ada <ada@x.io>` included. */
export function extractEmail(raw: string): string | null {
  const m = raw.match(EMAIL);
  return m ? m[0].toLowerCase().replace(/[.,;]+$/, "") : null;
}

/** Truthy spellings these exports use for a boolean column. */
export function isTruthy(raw: string): boolean {
  return ["true", "yes", "y", "1", "x", "done", "complete", "completed"].includes(raw.trim().toLowerCase());
}

const MAX_TITLE = 500;
const MAX_DESCRIPTION = 20_000;

export function clampTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

export function clampDescription(raw: string): string | null {
  const v = raw.trim();
  return v ? v.slice(0, MAX_DESCRIPTION) : null;
}

/* ── Status vocabularies ─────────────────────────────────────────────── */

/**
 * Words that mean the same thing wherever they turn up. A source adds its own
 * table on top (Linear's `Canceled`, Trello's list names) and wins on conflict.
 */
const BASE_STATUS: Record<string, TaskStatus> = {
  backlog: "backlog",
  icebox: "backlog",
  ideas: "backlog",
  notstarted: "backlog",
  new: "backlog",
  open: "triaged",
  todo: "triaged",
  todoo: "triaged",
  next: "triaged",
  upnext: "triaged",
  ready: "triaged",
  triage: "triaged",
  triaged: "triaged",
  selectedfordevelopment: "triaged",
  planned: "triaged",
  inprogress: "in-progress",
  progress: "in-progress",
  doing: "in-progress",
  started: "in-progress",
  active: "in-progress",
  inreview: "in-progress",
  review: "in-progress",
  codereview: "in-progress",
  inderdevelopment: "in-progress",
  indevelopment: "in-progress",
  blocked: "in-progress",
  testing: "in-progress",
  done: "completed",
  complete: "completed",
  completed: "completed",
  closed: "completed",
  resolved: "completed",
  shipped: "completed",
  released: "completed",
  deployed: "completed",
  archived: "wontfix",
  cancelled: "wontfix",
  canceled: "wontfix",
  wontfix: "wontfix",
  wontdo: "wontfix",
  duplicate: "wontfix",
  rejected: "wontfix",
  declined: "wontfix",
  obsolete: "wontfix",
};

/**
 * Map a source status onto PTD's five. Unknown words fall back to `fallback`
 * (backlog for most sources) and the caller adds the warning — a status the
 * importer silently guessed is exactly the sort of thing a preview exists for.
 */
export function mapStatus(
  raw: string,
  extra: Record<string, TaskStatus> = {},
  fallback: TaskStatus = "backlog"
): { status: TaskStatus; matched: boolean } {
  const key = norm(raw);
  if (!key) return { status: fallback, matched: true };
  const hit = extra[key] ?? BASE_STATUS[key];
  if (hit) return { status: hit, matched: true };
  // A compound name like "In Progress (dev)" or "Done ✅" still reads clearly.
  for (const [word, status] of Object.entries({ ...BASE_STATUS, ...extra })) {
    if (word.length >= 4 && key.includes(word)) return { status, matched: true };
  }
  return { status: fallback, matched: false };
}

/* ── Priority ────────────────────────────────────────────────────────── */

export interface Priority {
  urgency: number;
  impact: number;
  effort: number;
}

export const DEFAULT_PRIORITY: Priority = { urgency: 5, impact: 5, effort: 5 };

/** Jira: Highest/High/Medium/Low/Lowest → urgency 9/7/5/3/1, impact 5. */
const JIRA_URGENCY: Record<string, number> = {
  highest: 9, blocker: 9, critical: 9, urgent: 9,
  high: 7, major: 7,
  medium: 5, normal: 5, moderate: 5,
  low: 3, minor: 3,
  lowest: 1, trivial: 1, none: 5, nopriority: 5,
};

/** Linear: 1 Urgent, 2 High, 3 Medium, 4 Low → urgency 9/7/5/3. */
const LINEAR_URGENCY: Record<string, number> = { "1": 9, "2": 7, "3": 5, "4": 3, "0": 5 };

export function jiraPriority(raw: string): Priority | null {
  const u = JIRA_URGENCY[norm(raw)];
  return u === undefined ? null : { urgency: u, impact: 5, effort: 5 };
}

export function linearPriority(raw: string): Priority | null {
  const value = raw.trim();
  if (!value) return null;
  const numeric = LINEAR_URGENCY[value];
  if (numeric !== undefined) return { urgency: numeric, impact: 5, effort: 5 };
  // Linear also exports the words; they line up with Jira's scale.
  return jiraPriority(value);
}

export function clampScore(n: number): number {
  return Math.max(0, Math.min(10, Math.round(n)));
}

/* ── Estimates ───────────────────────────────────────────────────────── */

export const HOURS_PER_DAY = 8;

/** Story points read as days: 3 points → 3 days. Rounded up, at least 1. */
export function pointsToDays(points: number): number {
  return Math.max(1, Math.ceil(points));
}

/** Jira's `Original Estimate` is seconds; PTD's estimatedDuration is days. */
export function secondsToDays(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 3600 / HOURS_PER_DAY));
}

export function hoursToDays(hours: number): number {
  return Math.max(1, Math.ceil(hours / HOURS_PER_DAY));
}

/* ── Stable synthetic keys ───────────────────────────────────────────── */

/**
 * When the file carries no id of its own, the external key has to be derived
 * from the row itself — and it has to come out the same on a re-import, or the
 * second upload duplicates everything. Title plus creation date is the most
 * stable pair available across these formats.
 */
export function synthKey(source: string, title: string, created: string): string {
  const digest = createHash("sha1").update(`${source}\u0000${title.trim().toLowerCase()}\u0000${created.trim()}`).digest("hex");
  return `${source}-${digest.slice(0, 16)}`;
}

/* ── Row result helpers ──────────────────────────────────────────────── */

export function ok<T>(index: number, value: T, warnings: string[] = []): RowResult<T> {
  return { index, value, skip: null, warnings };
}

export function skip<T>(index: number, reason: string, warnings: string[] = []): RowResult<T> {
  return { index, value: null, skip: reason, warnings };
}
