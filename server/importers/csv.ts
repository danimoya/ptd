/**
 * A small RFC 4180 CSV reader/writer.
 *
 * Hand-written on purpose: PTD adds no dependency for this, and real exports
 * break the spec in predictable ways that a strict parser would reject —
 *
 *   - a UTF-8 BOM in front of the header (Excel, Jira, Harvest);
 *   - CRLF, LF or bare-CR record separators, mixed inside one file;
 *   - `;` (European Excel) or TAB delimiters instead of `,`;
 *   - a stray `"` in the middle of an unquoted field (Trello descriptions);
 *   - ragged rows — fewer or more cells than the header has columns;
 *   - repeated header names (Jira emits one `Labels` column per label).
 *
 * The grid parser is therefore lenient; `parseCsv` is the part that decides
 * what a malformed row means and reports it as a warning rather than throwing.
 * Nothing here knows about tasks, time or PTD: it returns columns and string
 * cells, and the mappers in ./mappers do the interpreting.
 */

export const BOM = "﻿";

/** Delimiters we will auto-detect, in preference order. */
const DELIMITERS = [",", ";", "\t", "|"] as const;
export type Delimiter = (typeof DELIMITERS)[number];

export interface ParsedCsv {
  /** Header cells, in file order, de-duplicated (see `duplicates`). */
  columns: string[];
  /** One object per data record, keyed by the (de-duplicated) column name. */
  rows: Record<string, string>[];
  /** The raw grid including the header row — useful for diagnostics. */
  grid: string[][];
  delimiter: Delimiter;
  /** Base name → every column key that came from it, when a header repeated. */
  duplicates: Record<string, string[]>;
  warnings: string[];
}

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * Split CSV text into a grid of raw string cells.
 *
 * Quoting follows RFC 4180 — a field that opens with `"` runs until the next
 * lone `"`, and `""` inside it is a literal quote, so delimiters and newlines
 * are carried through untouched. A `"` that appears after the field already has
 * content is kept verbatim instead of being treated as an opening quote, which
 * is the only sane reading of `3" pipe, 4" pipe`.
 */
export function parseGrid(input: string, delimiter: string = ","): string[][] {
  const text = stripBom(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false; // this field opened with a quote
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
    quoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === "" && !quoted) {
      inQuotes = true;
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      endRow();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // A file that does not end in a newline still has one record pending; one
  // that does end in a newline must not produce a phantom empty record.
  if (field !== "" || quoted || row.length > 0) endRow();

  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/**
 * Guess the delimiter from the header line: the candidate that splits it into
 * the most fields wins, counting only separators outside quotes.
 */
export function detectDelimiter(input: string): Delimiter {
  const text = stripBom(input);
  const header = firstLogicalLine(text);
  let best: Delimiter = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const count = countOutsideQuotes(header, d);
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** The header record, which may itself span physical lines if a cell is quoted. */
function firstLogicalLine(text: string): string {
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) return text.slice(0, i);
  }
  return text;
}

function countOutsideQuotes(line: string, needle: string): number {
  let inQuotes = false;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === needle) n += 1;
  }
  return n;
}

export interface ParseOptions {
  delimiter?: Delimiter;
  /** Hard cap on data records; anything beyond is dropped with a warning. */
  maxRows?: number;
}

export const MAX_ROWS = 5_000;

/**
 * Parse CSV text into `{ columns, rows }`.
 *
 * Header cells are trimmed; an empty one becomes `column N` so it can still be
 * mapped, and a repeated one is suffixed (`Labels`, `Labels (2)`, …) so the row
 * object keeps every value. `duplicates` records the grouping so a mapper can
 * fan a multi-valued field like tags back out across all of them.
 */
export function parseCsv(input: string, options: ParseOptions = {}): ParsedCsv {
  const delimiter = options.delimiter ?? detectDelimiter(input);
  const maxRows = options.maxRows ?? MAX_ROWS;
  const grid = parseGrid(input, delimiter);
  const warnings: string[] = [];

  if (grid.length === 0) {
    return { columns: [], rows: [], grid, delimiter, duplicates: {}, warnings: ["The file is empty."] };
  }

  const seen = new Map<string, number>();
  const duplicates: Record<string, string[]> = {};
  const columns = grid[0].map((raw, index) => {
    const base = raw.trim() || `column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const key = count === 1 ? base : `${base} (${count})`;
    (duplicates[base] ??= []).push(key);
    return key;
  });
  for (const [base, keys] of Object.entries(duplicates)) {
    if (keys.length === 1) delete duplicates[base];
    else warnings.push(`Column "${base}" appears ${keys.length} times; all copies are read.`);
  }

  const body = grid.slice(1);
  if (body.length > maxRows) warnings.push(`Only the first ${maxRows} rows were read (the file has ${body.length}).`);

  let ragged = 0;
  const rows: Record<string, string>[] = [];
  for (const cells of body.slice(0, maxRows)) {
    if (cells.every((c) => c.trim() === "")) continue; // blank separator line
    if (cells.length !== columns.length) ragged += 1;
    const row: Record<string, string> = {};
    columns.forEach((name, i) => {
      row[name] = (cells[i] ?? "").trim();
    });
    rows.push(row);
  }
  if (ragged > 0) {
    warnings.push(`${ragged} row${ragged === 1 ? "" : "s"} did not have ${columns.length} cells; missing cells were read as empty.`);
  }

  return { columns, rows, grid, delimiter, duplicates, warnings };
}

/* ── Writing ─────────────────────────────────────────────────────────── */

/** Quote a cell only when it has to be: delimiter, quote, or a line break in it. */
export function csvCell(value: unknown, delimiter: string = ","): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (s === "") return "";
  const needsQuotes = s.includes(delimiter) || s.includes('"') || s.includes("\n") || s.includes("\r");
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise a grid with CRLF separators, as RFC 4180 asks for. */
export function toCsv(grid: unknown[][], delimiter: string = ","): string {
  return grid.map((row) => row.map((c) => csvCell(c, delimiter)).join(delimiter)).join("\r\n") + "\r\n";
}
