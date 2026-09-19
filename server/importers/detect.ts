/**
 * Which tool wrote this file?
 *
 * Scored on the header row alone — the first line is the only part of a CSV that
 * is reliably about the format rather than about the data. Each mapper declares
 * `strong` headers that only it emits (`Issue key`, `Card Short Link`,
 * `Duration (h)`), worth 3 points, and `weak` ones that merely fit, worth 1. A
 * mapper that declares an `absent` header sits out entirely when that header is
 * present, which is how Toggl steps aside for Clockify: their layouts are
 * near-identical apart from Clockify's two duration columns.
 *
 * Nothing here reads a data row, so a detection is cheap, order-independent and
 * explainable — `scores` goes back to the client so the UI can say *why* it
 * guessed Linear, and the user can override it.
 */

import { parseCsv, type ParsedCsv } from "./csv";
import { MAPPERS, mapperFor } from "./mappers";
import { norm } from "./mappers/shared";
import type { AnyMapper, ImportKind, Source } from "./types";

export interface SourceScore {
  source: Source;
  kind: ImportKind;
  label: string;
  score: number;
  /** Which of the mapper's distinctive headers were found. */
  matched: string[];
}

export interface Detection {
  source: Source;
  kind: ImportKind;
  label: string;
  /** 0–1. Below ~0.4 the UI should ask the user to confirm the source. */
  confidence: number;
  scores: SourceScore[];
}

const STRONG_WEIGHT = 3;

export function scoreMapper(mapper: AnyMapper, columns: string[]): SourceScore {
  const present = new Set(columns.map((c) => norm(c.replace(/\s*\(\d+\)\s*$/, ""))));
  // `Duration (h)` normalises to `durationh`, so a declared absent/strong header
  // with punctuation still compares cleanly against the file's own columns.
  const blocked = (mapper.signature.absent ?? []).some((h) => present.has(norm(h)));
  if (blocked) return { source: mapper.source, kind: mapper.kind, label: mapper.label, score: 0, matched: [] };

  const matched: string[] = [];
  let score = 0;
  for (const header of mapper.signature.strong) {
    if (present.has(norm(header))) {
      score += STRONG_WEIGHT;
      matched.push(header);
    }
  }
  for (const header of mapper.signature.weak ?? []) {
    if (present.has(norm(header))) score += 1;
  }
  return { source: mapper.source, kind: mapper.kind, label: mapper.label, score, matched };
}

/**
 * Best source for a header row. `generic` is the floor: it always scores above
 * zero for a file with a title-ish column, and it is last in MAPPERS so a tie
 * never takes it over a real format.
 */
export function detectSource(columns: string[]): Detection {
  const scores = MAPPERS.map((m) => scoreMapper(m, columns)).sort((a, b) => b.score - a.score);
  const best = scores[0];
  const runnerUp = scores[1];

  if (!best || best.score === 0) {
    const fallback = mapperFor("generic");
    return {
      source: "generic",
      kind: "task",
      label: fallback.label,
      confidence: 0,
      scores,
    };
  }

  // Confidence is how far ahead of the next candidate the winner is, tempered by
  // how much of its own signature it actually found. A lone `generic` match is
  // deliberately low: the point is to make the UI ask rather than to be right.
  const own = mapperSignature(best.source);
  const coverage = own === 0 ? 0 : Math.min(1, best.score / own);
  const margin = runnerUp && runnerUp.score > 0 ? (best.score - runnerUp.score) / best.score : 1;
  const confidence = Math.round(Math.max(0, Math.min(1, coverage * 0.7 + margin * 0.3)) * 100) / 100;

  return { source: best.source, kind: best.kind, label: best.label, confidence, scores };
}

/** The score a mapper would get if every header in its signature were present. */
function mapperSignature(source: Source): number {
  const m = mapperFor(source);
  return m.signature.strong.length * STRONG_WEIGHT + (m.signature.weak?.length ?? 0);
}

export interface DetectedFile extends Detection {
  parsed: ParsedCsv;
  /** Default column → field mapping for the detected source. */
  mapping: Record<string, string>;
}

/** Parse + detect + default mapping in one step, which is what every caller wants. */
export function detectFile(csv: string, forced?: Source): DetectedFile {
  const parsed = parseCsv(csv);
  const detection = forced
    ? { ...detectSource(parsed.columns), source: forced, kind: mapperFor(forced).kind, label: mapperFor(forced).label, confidence: 1 }
    : detectSource(parsed.columns);
  const mapping = mapperFor(detection.source).mapping(parsed.columns);
  return { ...detection, parsed, mapping };
}
