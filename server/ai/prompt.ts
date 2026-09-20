/**
 * Prompt construction for priority suggestions — the pure half of the feature.
 *
 * Nothing here touches the network or the database, which is the point: the
 * brief a card produces is the thing most worth unit-testing, and the thing most
 * worth keeping small. A suggestion is scored from ~300 tokens of context, so
 * the description is trimmed hard and the org context is four numbers and five
 * titles rather than the backlog.
 */
import { z } from "zod";
import { band } from "../overview/schema";
import type { JsonSpec } from "./provider";

/** How much of a card's description the model gets. Long specs do not improve a 0–10 score. */
export const DESCRIPTION_LIMIT = 1200;
export const RATIONALE_LIMIT = 280;

/* ───────────────────────────── HTML → text ───────────────────────────── */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

/**
 * Descriptions arrive as TipTap HTML from the Plan editor and as plain text from
 * the importers, so the prompt gets whichever it was, flattened. Block ends
 * become newlines (a list of acceptance criteria must not run into one line) and
 * script/style content is dropped outright rather than tag-stripped.
 */
export function stripHtml(input: string | null | undefined): string {
  if (!input) return "";
  let text = String(input);
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)\s*>/gi, "\n");
  text = text.replace(/<li\b[^>]*>/gi, "• ");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)));
  text = text.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
  // Collapse runs of spaces/tabs, keep paragraph breaks, drop the rest.
  text = text.replace(/[ \t ]+/g, " ");
  text = text.replace(/\s*\n\s*/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/* ─────────────────────────── org distribution ─────────────────────────── */

/** Linearly interpolated percentile over an ascending array, rounded. Empty in, null out. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (rank - low));
}

export interface OpenTaskRow {
  id: number;
  title: string;
  priorityScore: number;
}

export interface OrgPriorityContext {
  openTasks: number;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  top: { id: number; title: string; priorityScore: number }[];
}

/**
 * What "high priority" means in *this* backlog. Without it a model anchors on
 * its own idea of a 0–10 scale and every card comes back an 8.
 */
export function buildOrgContext(open: OpenTaskRow[]): OrgPriorityContext {
  const scores = open.map((t) => t.priorityScore).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const top = open
    .slice()
    .sort((a, b) => b.priorityScore - a.priorityScore || a.id - b.id)
    .slice(0, 5)
    .map((t) => ({ id: t.id, title: t.title, priorityScore: t.priorityScore }));
  return {
    openTasks: open.length,
    p25: percentile(scores, 25),
    p50: percentile(scores, 50),
    p75: percentile(scores, 75),
    top,
  };
}

/* ──────────────────────────── the card's brief ──────────────────────────── */

/** The shape `task.get` returns, narrowed to what the prompt reads. */
export interface TaskDetail {
  task: {
    id: number;
    title: string;
    description: string | null;
    status: string;
    startDate: string | null;
    dueDate: string | null;
    estimatedDuration: number | null;
    tags: string[];
    urgency: number;
    impact: number;
    effort: number;
    priorityScore: number;
    prioritySource: string;
    priorityNote: string | null;
    completed: boolean;
  };
  stream: { id: number; name: string } | null;
  app: { id: number; key: string; name: string } | null;
  assignee: { displayName: string; isAgent: boolean } | null;
  dependencies: { id: number; title: string }[];
  dependents: { id: number }[];
  blocked?: boolean;
}

export interface TaskContext {
  id: number;
  title: string;
  description: string;
  status: string;
  stream: string | null;
  app: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  dependencyCount: number;
  dependencyTitles: string[];
  dependentCount: number;
  assignee: "human" | "agent" | "nobody";
  tags: string[];
  blocked: boolean;
  current: { urgency: number; impact: number; effort: number; priorityScore: number; prioritySource: string; priorityNote: string | null };
}

const day = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

export function buildTaskContext(detail: TaskDetail): TaskContext {
  const t = detail.task;
  return {
    id: t.id,
    title: t.title,
    description: truncate(stripHtml(t.description), DESCRIPTION_LIMIT),
    status: t.status,
    stream: detail.stream?.name ?? null,
    app: detail.app ? `${detail.app.key} (${detail.app.name})` : null,
    startDate: day(t.startDate),
    dueDate: day(t.dueDate),
    estimateMinutes: t.estimatedDuration ?? null,
    dependencyCount: detail.dependencies.length,
    // Five titles is enough to see "blocked on a migration"; the count carries the rest.
    dependencyTitles: detail.dependencies.slice(0, 5).map((d) => truncate(d.title, 80)),
    dependentCount: detail.dependents.length,
    assignee: detail.assignee ? (detail.assignee.isAgent ? "agent" : "human") : "nobody",
    tags: Array.isArray(t.tags) ? t.tags.slice(0, 12) : [],
    blocked: !!detail.blocked,
    current: {
      urgency: t.urgency,
      impact: t.impact,
      effort: t.effort,
      priorityScore: t.priorityScore,
      prioritySource: t.prioritySource,
      priorityNote: t.priorityNote,
    },
  };
}

/* ────────────────────────────── the contract ────────────────────────────── */

export interface PrioritySuggestion {
  urgency: number;
  impact: number;
  effort: number;
  rationale: string;
  confidence: number;
}

const int0to10 = z
  .number()
  .finite()
  // A model that answers 7.5 on a 0–10 scale is not wrong, just imprecise —
  // round it rather than burn a retry. A string or a null still fails.
  .transform((n) => Math.max(0, Math.min(10, Math.round(n))));

export const suggestionSchema = z.object({
  urgency: int0to10,
  impact: int0to10,
  effort: int0to10,
  rationale: z.string().min(1).transform((s) => truncate(s.trim(), RATIONALE_LIMIT)),
  confidence: z.number().finite().transform((n) => Math.max(0, Math.min(1, n))),
});

/** JSON Schema for the same contract — strict, so a forced tool call validates. */
export const SUGGESTION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["urgency", "impact", "effort", "rationale", "confidence"],
  properties: {
    urgency: { type: "integer", minimum: 0, maximum: 10, description: "How much the cost of this work rises if it waits. 0 = no deadline pressure, 10 = already late." },
    impact: { type: "integer", minimum: 0, maximum: 10, description: "How much doing it improves things for users or for the team. 0 = nobody notices, 10 = unblocks everyone." },
    effort: { type: "integer", minimum: 0, maximum: 10, description: "Size of the work. 1 = under an hour, 5 = a couple of days, 10 = weeks." },
    rationale: { type: "string", maxLength: RATIONALE_LIMIT, description: `One or two sentences, at most ${RATIONALE_LIMIT} characters, naming the evidence you used.` },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure you are, 0–1. Be honest: a one-line card with no description deserves a low number." },
  },
};

export const SUGGESTION_SPEC: JsonSpec<PrioritySuggestion> = {
  name: "score_priority",
  description: "Score one backlog card's urgency, impact and effort on PTD's 0–10 scales.",
  schema: SUGGESTION_JSON_SCHEMA,
  parse: (value) => {
    const parsed = suggestionSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; "));
    }
    return parsed.data;
  },
};

/* ─────────────────────────────── the prompt ─────────────────────────────── */

/**
 * The system half is fixed text, which is what makes it the stable prefix if
 * caching is ever switched on: the card and the org context both live in the
 * user half.
 */
export const SUGGESTION_SYSTEM = [
  "You are a delivery-lead triaging a software backlog in PTD.",
  "",
  "PTD scores each card on three 0–10 integers and derives a priority from them:",
  "  priority = clamp(round(urgency × impact / max(effort, 1)), 0, 100)",
  "",
  "  urgency — how fast the cost of NOT doing this rises. Deadlines, overdue dates,",
  "            cards waiting on this one, and outages push it up. No date and nobody",
  "            waiting means low, whatever the work is worth.",
  "  impact  — how much finishing it improves things for users or the team.",
  "  effort  — the size of the work, not its importance. 1 = under an hour,",
  "            5 = a couple of days, 10 = weeks. Effort DIVIDES the score, so",
  "            inflating it quietly buries the card.",
  "",
  "Judge only from the evidence given. Say so in the rationale when the card is thin,",
  "and lower your confidence rather than inventing context. Never restate the formula",
  "in the rationale — name the evidence you actually used.",
  "Answer as JSON only.",
].join("\n");

function line(label: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  return `${label}: ${Array.isArray(value) ? value.join(", ") : String(value)}`;
}

export function buildSuggestionPrompt(task: TaskContext, org: OrgPriorityContext): { system: string; user: string } {
  const today = new Date().toISOString().slice(0, 10);
  const cardLines = [
    line("id", `#${task.id}`),
    line("title", task.title),
    line("status", task.status),
    line("stream", task.stream ?? "none"),
    line("app", task.app ?? "none"),
    line("assignee", task.assignee),
    line("starts", task.startDate),
    line("due", task.dueDate),
    line("estimate (minutes)", task.estimateMinutes),
    line("tags", task.tags),
    line(
      "depends on",
      task.dependencyCount === 0
        ? null
        : `${task.dependencyCount} card${task.dependencyCount === 1 ? "" : "s"}${
            task.dependencyTitles.length > 0 ? ` — ${task.dependencyTitles.join("; ")}` : ""
          }`,
    ),
    line("blocked right now", task.blocked ? "yes" : null),
    line("cards waiting on this one", task.dependentCount === 0 ? null : task.dependentCount),
    line(
      "current score",
      `urgency ${task.current.urgency} × impact ${task.current.impact} ÷ effort ${Math.max(task.current.effort, 1)} = ${task.current.priorityScore} (${task.current.prioritySource})`,
    ),
    line("current note", task.current.priorityNote),
  ].filter((l): l is string => l !== null);

  const orgLines = [
    line("open cards", org.openTasks),
    line(
      "priority spread across open cards",
      org.p50 === null ? null : `p25 ${org.p25} · p50 ${org.p50} · p75 ${org.p75}`,
    ),
    org.top.length === 0
      ? null
      : `highest-scored open cards:\n${org.top.map((t) => `  ${t.priorityScore} — ${truncate(t.title, 90)}`).join("\n")}`,
  ].filter((l): l is string => l !== null);

  const user = [
    `Today is ${today}.`,
    "",
    "CARD",
    ...cardLines,
    "",
    "DESCRIPTION",
    task.description || "(empty)",
    "",
    "THIS ORGANIZATION'S BACKLOG, for calibration",
    ...orgLines,
    "",
    `Score card #${task.id}. Use the spread above so the number means the same thing as the rest of this backlog:`,
    "a card you would not schedule this quarter belongs below p25, not at 8 × 8 ÷ 2.",
  ].join("\n");

  return { system: SUGGESTION_SYSTEM, user };
}

/** Same thresholds as the client and the KPI strip: 75+ critical, 50+ high, 25+ medium. */
export const scoreBand = band;
