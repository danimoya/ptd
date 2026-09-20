import { format, subDays } from "date-fns";
import type { HybridGroupBy } from "./api";

/**
 * The three windows this dashboard opens on, and the bucket each one defaults to.
 *
 * Ninety daily bars are unreadable on a phone and barely readable on a laptop, so
 * the 90-day preset bins by week; the toggle is still there for anyone who wants
 * the detail. Dates go over the wire as bare `YYYY-MM-DD`, which the action reads
 * as local midnight — the same convention every other report here uses.
 */

export type PresetKey = "7d" | "30d" | "90d";

export interface Preset {
  key: PresetKey;
  label: string;
  short: string;
  days: number;
  groupBy: HybridGroupBy;
}

export const PRESETS: Preset[] = [
  { key: "7d", label: "Last 7 days", short: "7d", days: 7, groupBy: "day" },
  { key: "30d", label: "Last 30 days", short: "30d", days: 30, groupBy: "day" },
  { key: "90d", label: "Last 90 days", short: "90d", days: 90, groupBy: "week" },
];

export const presetFor = (key: PresetKey): Preset => PRESETS.find((p) => p.key === key) ?? PRESETS[1];

export interface Range {
  from: string;
  to: string;
}

/** The window a preset means, counting today as the last day. */
export function rangeFor(key: PresetKey, now = new Date()): Range {
  const preset = presetFor(key);
  return { from: format(subDays(now, preset.days - 1), "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") };
}

/** "22 Aug – 20 Sep 2026" — the year stated once, at the end. */
export function describeRange(from: string, to: string): string {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${from} – ${to}`;
  const sameYear = a.getFullYear() === b.getFullYear();
  return `${format(a, sameYear ? "d MMM" : "d MMM yyyy")} – ${format(b, "d MMM yyyy")}`;
}
