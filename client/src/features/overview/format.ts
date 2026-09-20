import type { Band } from "./types";

/**
 * Priority bands, straight from the original backlog tracker: 75-100 critical, 50-74 high,
 * 25-49 medium, 0-24 low. The one place the thresholds live on the client.
 */
export function band(score: number): Band {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

/**
 * Ledger ink for each band. The palette has no amber token, so the high band
 * borrows a tuned ochre that sits between parchment and vermilion without
 * fighting either; everything else is a theme colour.
 */
const BAND_TEXT: Record<Band, string> = {
  critical: "text-vermilion",
  high: "text-[#9a6a12] dark:text-[#d6a243]",
  medium: "text-ink",
  low: "text-ink-muted",
};

const BAND_CHIP: Record<Band, string> = {
  critical: "border-vermilion/70 text-vermilion",
  high: "border-[#9a6a12]/60 text-[#9a6a12] dark:border-[#d6a243]/60 dark:text-[#d6a243]",
  medium: "border-ink/50 text-ink",
  low: "border-rule text-ink-muted",
};

export const bandTextClass = (score: number) => BAND_TEXT[band(score)];
export const bandChipClass = (score: number) => BAND_CHIP[band(score)];

export const BAND_LABEL: Record<Band, string> = {
  critical: "Critical · 75-100",
  high: "High · 50-74",
  medium: "Medium · 25-49",
  low: "Low · 0-24",
};

/** 1h 20m / 45m / — . Minutes only, because that is what the timer records. */
export function formatMinutes(total: number | null | undefined): string {
  if (!total || total <= 0) return "—";
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** $0.00 under ten dollars, $12.30 above, so small agent runs stay legible. */
export function formatUsd(value: number | null | undefined): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(n < 10 ? 2 : 2)}`;
}

/** 48k / 1.2M — token counts get long fast. */
export function formatTokens(value: number | null | undefined): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (n === 0) return "0";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const STATUS_LABEL: Record<string, string> = {
  backlog: "backlog",
  triaged: "triaged",
  "in-progress": "in progress",
  completed: "completed",
  wontfix: "won't fix",
};

const STATUS_CHIP: Record<string, string> = {
  backlog: "border-rule text-ink-muted",
  triaged: "border-ink/50 text-ink",
  "in-progress": "border-vermilion/70 text-vermilion",
  completed: "border-sage/60 text-sage",
  wontfix: "border-rule text-ink-muted line-through",
};

export const statusChipClass = (status: string) => STATUS_CHIP[status] ?? "border-rule text-ink-muted";

/** 9 Sep, or 9 Sep 2025 once it leaves the current year. Empty string for null. */
export function formatDay(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** "2h ago" / "3d ago" — for the agent activity feed. */
export function formatAgo(value: string | null | undefined): string {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDay(value);
}

export function isOverdue(dueDate: string | null | undefined, status: string): boolean {
  if (!dueDate) return false;
  if (status === "completed" || status === "wontfix") return false;
  const d = new Date(dueDate).getTime();
  return !Number.isNaN(d) && d < Date.now();
}

/* ───────────────────────── AI-assisted priority ───────────────────────── */

/**
 * Where a card's score came from, as a two-to-six character glyph for a table
 * row. `formula` is the default and gets nothing: a glyph on every row would say
 * nothing about any of them.
 */
export function prioritySourceLabel(source: string | null | undefined): string | null {
  if (source === "ai") return "AI";
  if (source === "manual") return "manual";
  return null;
}

/** The one sentence every AI control repeats, so the promise is stated the same way everywhere. */
export const AI_MANUAL_PROMISE = "A score you set by hand is never replaced by a suggestion without you confirming it.";

const PRIORITY_SOURCE_TITLE: Record<string, string> = {
  ai: `Scored from an AI suggestion a manager accepted. The note on the card is the model's rationale. ${AI_MANUAL_PROMISE}`,
  manual: `Scored by hand. ${AI_MANUAL_PROMISE}`,
  formula: "Scored by the formula: urgency × impact ÷ effort.",
};

/** Tooltip text for the glyph above (and for the drawer's score block). */
export function prioritySourceTitle(source: string | null | undefined): string {
  return PRIORITY_SOURCE_TITLE[source ?? "formula"] ?? PRIORITY_SOURCE_TITLE.formula;
}

const SOURCE_CHIP: Record<string, string> = {
  ai: "border-ink/50 text-ink",
  manual: "border-rule text-ink-muted",
};

export const prioritySourceChipClass = (source: string) => SOURCE_CHIP[source] ?? "border-rule text-ink-muted";

/** 0.72 → "72%". Confidence is a model's own hedge; showing two decimals would flatter it. */
export function formatConfidence(value: number | null | undefined): string {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return `${Math.round(n * 100)}%`;
}

/**
 * Money at the scale one suggestion actually costs. `formatUsd` rounds a
 * $0.0002 call to "<$0.01", which is true but useless when the question is
 * "what would this cost across the backlog?".
 */
export function formatAiCost(value: number | null | undefined): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (n <= 0) return "$0";
  if (n < 0.01) return `$${n.toPrecision(2)}`;
  return `$${n.toFixed(2)}`;
}

/** "+18" / "−4" / "0" — a delta reads wrong without its sign. */
export function formatDelta(value: number): string {
  if (value === 0) return "0";
  return value > 0 ? `+${value}` : `−${Math.abs(value)}`;
}
