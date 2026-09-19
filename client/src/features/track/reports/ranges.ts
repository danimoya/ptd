/**
 * Date-range presets for the reports header.
 *
 * Pure on purpose: the arithmetic of "last week", "the month before this one"
 * and "the period immediately before this one" is the sort of thing that is
 * quietly wrong for a fortnight before anyone notices, so it lives here where a
 * test can pin it, rather than inline in the page.
 *
 * Everything is a local `YYYY-MM-DD`, which is what the actions accept and what
 * the server treats as local midnight — the same convention the ledger's
 * calendar uses.
 */

import {
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from "date-fns";
import type { GroupBy } from "./api";

/** Monday-first, matching the server's week buckets. */
const WEEK = { weekStartsOn: 1 } as const;

export const PRESET_KEYS = ["this-week", "last-week", "this-month", "last-month", "last-30", "custom"] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

export const PRESET_LABELS: Record<PresetKey, string> = {
  "this-week": "This week",
  "last-week": "Last week",
  "this-month": "This month",
  "last-month": "Last month",
  "last-30": "Last 30 days",
  custom: "Custom",
};

export interface Range {
  from: string;
  to: string;
}

export const toKey = (d: Date): string => format(d, "yyyy-MM-dd");

export function presetRange(key: PresetKey, now: Date = new Date()): Range {
  switch (key) {
    case "this-week":
      return { from: toKey(startOfWeek(now, WEEK)), to: toKey(endOfWeek(now, WEEK)) };
    case "last-week": {
      const ref = subWeeks(now, 1);
      return { from: toKey(startOfWeek(ref, WEEK)), to: toKey(endOfWeek(ref, WEEK)) };
    }
    case "this-month":
      return { from: toKey(startOfMonth(now)), to: toKey(endOfMonth(now)) };
    case "last-month": {
      const ref = subMonths(now, 1);
      return { from: toKey(startOfMonth(ref)), to: toKey(endOfMonth(ref)) };
    }
    case "last-30":
      return { from: toKey(subDays(now, 29)), to: toKey(now) };
    case "custom":
      return { from: toKey(startOfWeek(now, WEEK)), to: toKey(endOfWeek(now, WEEK)) };
  }
}

/** Inclusive day count of a range; 1 for a single day. */
export function rangeDays(r: Range): number {
  return Math.max(1, differenceInCalendarDays(new Date(`${r.to}T00:00:00`), new Date(`${r.from}T00:00:00`)) + 1);
}

/**
 * What to compare a range against.
 *
 * A month preset compares against the previous *calendar* month, because "31
 * days before September" is not August and a reader would rightly object.
 * Everything else compares against the same number of days immediately before.
 */
export function previousRange(key: PresetKey, r: Range, now: Date = new Date()): Range {
  if (key === "this-month") return presetRange("last-month", now);
  if (key === "last-month") {
    const ref = subMonths(now, 2);
    return { from: toKey(startOfMonth(ref)), to: toKey(endOfMonth(ref)) };
  }
  const days = rangeDays(r);
  const to = subDays(new Date(`${r.from}T00:00:00`), 1);
  return { from: toKey(subDays(to, days - 1)), to: toKey(to) };
}

/** Bucket size that keeps a chart readable: days for a month, then weeks, then months. */
export function suggestedGroupBy(r: Range): GroupBy {
  const days = rangeDays(r);
  if (days <= 31) return "day";
  if (days <= 180) return "week";
  return "month";
}

/** "5 – 19 Sep 2026" / "1 Aug – 19 Sep 2026" — the header's caption. */
export function describeRange(r: Range): string {
  const from = new Date(`${r.from}T00:00:00`);
  const to = new Date(`${r.to}T00:00:00`);
  if (r.from === r.to) return format(from, "d MMMM yyyy");
  const sameYear = from.getFullYear() === to.getFullYear();
  const sameMonth = sameYear && from.getMonth() === to.getMonth();
  if (sameMonth) return `${format(from, "d")} – ${format(to, "d MMMM yyyy")}`;
  if (sameYear) return `${format(from, "d MMM")} – ${format(to, "d MMM yyyy")}`;
  return `${format(from, "d MMM yyyy")} – ${format(to, "d MMM yyyy")}`;
}

/** The last five years, newest first — the invoice dialog's year list. */
export function invoiceYears(now: Date = new Date()): number[] {
  return Array.from({ length: 5 }, (_, i) => now.getFullYear() - i);
}

export const MONTH_NAMES = Array.from({ length: 12 }, (_, i) => format(new Date(2000, i, 1), "MMMM"));
