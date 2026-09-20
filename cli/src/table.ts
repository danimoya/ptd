/**
 * Output rendering: aligned tables and key/value blocks.
 *
 * Column widths are measured in characters after the value has been flattened to
 * one line, numbers are right-aligned and long cells are truncated with an
 * ellipsis so a wide backlog still lines up in an 80-column terminal.
 */
import { bold, dim } from "./color.ts";

export interface Column {
  key: string;
  header?: string;
  /** Right-align. Inferred from the values when omitted. */
  numeric?: boolean;
  max?: number;
}

const DEFAULT_MAX = 60;
const GAP = "  ";

export function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(renderCell).join(", ");
  return JSON.stringify(value);
}

function clip(text: string, max: number): string {
  if (max <= 1 || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** `[{id:1,title:"x"}]` → two aligned columns with a header rule. */
export function table(rows: Record<string, unknown>[], columns?: (Column | string)[]): string {
  if (rows.length === 0) return "";
  const cols: Column[] = (columns ?? inferColumns(rows)).map((c) => (typeof c === "string" ? { key: c } : c));
  const cells = rows.map((row) => cols.map((c) => clip(renderCell(row[c.key]), c.max ?? DEFAULT_MAX)));
  const headers = cols.map((c) => c.header ?? c.key);
  const numeric = cols.map((c, i) => {
    if (c.numeric !== undefined) return c.numeric;
    const allNumbers = rows.every((row) => row[c.key] === null || row[c.key] === undefined || typeof row[c.key] === "number");
    return allNumbers && cells.some((r) => r[i] !== "");
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i].length)));

  const line = (values: string[], decorate: (s: string) => string = (s) => s) =>
    values
      .map((v, i) => decorate(numeric[i] ? v.padStart(widths[i]) : v.padEnd(widths[i])))
      .join(GAP)
      .trimEnd();

  return [line(headers, bold), dim(widths.map((w) => "─".repeat(w)).join(GAP)), ...cells.map((r) => line(r))].join("\n");
}

function inferColumns(rows: Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  return keys;
}

/** `{a:1,b:"x"}` → two aligned `label  value` lines. */
export function keyValue(pairs: Record<string, unknown> | [string, unknown][], indent = ""): string {
  const entries = (Array.isArray(pairs) ? pairs : Object.entries(pairs)).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  const width = Math.max(...entries.map(([k]) => k.length));
  return entries.map(([k, v]) => `${indent}${dim(k.padEnd(width))}  ${renderCell(v)}`).join("\n");
}

/**
 * A whole action result when nothing better is known: scalars in a key/value
 * block, arrays of objects as their own tables, everything else as JSON. Used by
 * `ptd run` and `ptd stats`, so a new action added on the server renders usefully
 * without the CLI being taught about it.
 */
export function summarize(value: unknown, heading?: string): string {
  const out: string[] = [];
  if (heading) out.push(bold(heading));
  if (value === null || value === undefined) return [...out, dim("(no result)")].join("\n");
  if (typeof value !== "object") return [...out, renderCell(value)].join("\n");
  if (Array.isArray(value)) {
    if (value.length === 0) return [...out, dim("(empty)")].join("\n");
    if (value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
      return [...out, table((value as Record<string, unknown>[]).map((row) => flatten(row)))].join("\n");
    }
    return [...out, value.map(renderCell).join("\n")].join("\n");
  }

  const scalars: [string, unknown][] = [];
  const blocks: string[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (v === null || typeof v !== "object") {
      scalars.push([key, v]);
      continue;
    }
    if (Array.isArray(v) && v.length === 0) {
      scalars.push([key, "(empty)"]);
      continue;
    }
    if (Array.isArray(v) && v.every((item) => item === null || typeof item !== "object")) {
      scalars.push([key, v]);
      continue;
    }
    blocks.push(summarize(v, key));
  }
  if (scalars.length) out.push(keyValue(scalars));
  for (const block of blocks) out.push("", block);
  return out.join("\n");
}

/**
 * `{bySource:{agent:{minutes:78}}}` → `{"bySource.agent.minutes": 78}`, so a row
 * with nested buckets becomes real columns instead of one truncated JSON cell.
 */
export function flatten(row: Record<string, unknown>, prefix = "", depth = 3): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (depth > 0 && value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Record<string, unknown>, name, depth - 1));
      continue;
    }
    out[name] = value;
  }
  return out;
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/** `95` → `1h 35m`. */
export function minutes(total: number | null | undefined): string {
  const n = Math.round(Number(total ?? 0));
  if (!Number.isFinite(n) || n <= 0) return "0m";
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}
