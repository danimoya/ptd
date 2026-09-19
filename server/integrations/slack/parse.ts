/**
 * Slash-command text parsing. Pure functions, no I/O — this is the part with the
 * most edge cases (`45m`, `1h30m`, `tokens=1200 cost=0.12`, `PTD-12` vs `#42`) and
 * therefore the part worth unit-testing hardest.
 */

/** Slack HTML-escapes &, < and > in command text. Undo that before parsing. */
export function unescapeSlackText(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/**
 * Flatten Slack's auto-links so notes read like the person typed them:
 * `<http://x|label>` → label, `<@U1|bob>` → @bob, `<#C1|general>` → #general.
 */
export function flattenSlackLinks(text: string): string {
  return text
    .replace(/<([@#!])([A-Z0-9]+)(?:\|([^>]*))?>/gi, (_m, sigil: string, id: string, label?: string) => {
      const shown = label && label.length > 0 ? label : id;
      return sigil === "!" ? `@${shown}` : `${sigil === "#" ? "#" : "@"}${shown}`;
    })
    .replace(/<((?:https?|mailto):[^|>]+)(?:\|([^>]*))?>/gi, (_m, url: string, label?: string) => (label && label.length > 0 ? label : url));
}

export function cleanCommandText(text: string): string {
  return flattenSlackLinks(unescapeSlackText(text ?? "")).replace(/\s+/g, " ").trim();
}

export interface ParsedCommand {
  /** Lower-cased first word, "" when the command was bare. */
  sub: string;
  /** Remaining whitespace-separated words. */
  args: string[];
  /** Everything after the subcommand, verbatim (used for free-text notes). */
  rest: string;
}

export function parseCommandText(text: string): ParsedCommand {
  const cleaned = cleanCommandText(text);
  if (!cleaned) return { sub: "", args: [], rest: "" };
  const [first, ...others] = cleaned.split(" ");
  return { sub: first.toLowerCase(), args: others, rest: others.join(" ") };
}

const DURATION = /^(?:(\d{1,3})\s*(?:h|hr|hrs|hour|hours))?(?:(\d{1,4})\s*(?:m|min|mins|minute|minutes))?$/i;

/** `45m`, `1h30m`, `2h`, `90` (bare minutes) → minutes. Null when it is not a duration. */
export function parseDuration(raw: string): number | null {
  const token = (raw ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!token) return null;
  if (/^\d{1,4}$/.test(token)) {
    const minutes = Number(token);
    return minutes > 0 ? minutes : null;
  }
  const m = DURATION.exec(token);
  if (!m || (!m[1] && !m[2])) return null;
  const minutes = (m[1] ? Number(m[1]) * 60 : 0) + (m[2] ? Number(m[2]) : 0);
  return minutes > 0 ? minutes : null;
}

export function formatMinutes(total: number): string {
  const minutes = Math.max(0, Math.round(total));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Pull `key=value` pairs out of a token list and hand back what is left, so
 * `/ptd stop tokens=1200 cost=0.12 shipped the adapter` yields both the metrics and
 * the note. Only the keys asked for are consumed; anything else stays in the note.
 */
export function extractKeyValues(tokens: string[], keys: readonly string[]): { values: Record<string, string>; rest: string[] } {
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (const token of tokens) {
    const eq = token.indexOf("=");
    const key = eq > 0 ? token.slice(0, eq).toLowerCase() : "";
    if (eq > 0 && wanted.has(key)) values[key] = token.slice(eq + 1);
    else rest.push(token);
  }
  return { values, rest };
}

export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** A task reference as typed: `PTD-12`, `#42`, `42`, or `ptd-12`. Trailing punctuation is dropped. */
export function normaliseTaskRef(raw: string): string {
  return (raw ?? "").trim().replace(/^#/, "").replace(/[.,;:]+$/, "");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD only — an unambiguous date is the one thing worth being strict about. */
export function parseIsoDate(raw: string): string | null {
  const token = (raw ?? "").trim();
  if (!ISO_DATE.test(token)) return null;
  const date = new Date(`${token}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === token ? token : null;
}

export function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d{1,5}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value > 0 ? value : null;
}
