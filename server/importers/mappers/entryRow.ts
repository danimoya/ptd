/**
 * One row → one NormalisedEntry, for every time-tracker source.
 *
 * The three formats give us the same interval in three shapes: Toggl and
 * Clockify split it into date + time columns at both ends plus a duration,
 * Harvest gives a date and a decimal hour count and no clock times at all. This
 * builder resolves all of that to a concrete `checkIn`/`checkOut` pair and
 * refuses the rows PTD would not accept:
 *
 *   - end before start (a timezone-mangled export, or a typo);
 *   - longer than 24 hours, which is `MAX_ENTRY_MS` in the Track surface;
 *   - no usable start at all.
 *
 * A refused row is skipped with a reason rather than clamped, because an
 * imported ledger that silently invents an interval is worse than a short one.
 */

import type { NormalisedEntry, RowResult } from "../types";
import { extractEmail, ok, parseDateAndTime, parseDay, parseDurationMs, pick, skip } from "./shared";

/** Same ceiling the Track surface enforces (server/track/entries.ts). */
export const MAX_ENTRY_MS = 24 * 60 * 60 * 1000;

/** Where a date-only row (Harvest) is placed on its day. */
export const DEFAULT_START_HOUR = 9;

/**
 * No per-source options: `parseDurationMs` reads both shapes these files use —
 * Clockify's `Duration (h)` clock string and Harvest's decimal `Hours` — so the
 * three time mappers differ only in their header dictionaries.
 */
export function buildEntry(
  row: Record<string, string>,
  mapping: Record<string, string>,
  index: number
): RowResult<NormalisedEntry> {
  const warnings: string[] = [];

  const startDateRaw = pick(row, mapping, "startDate") || pick(row, mapping, "date");
  const endDateRaw = pick(row, mapping, "endDate") || startDateRaw;
  const startTimeRaw = pick(row, mapping, "startTime");
  const endTimeRaw = pick(row, mapping, "endTime");

  const durationRaw = pick(row, mapping, "duration");
  const hoursRaw = pick(row, mapping, "hours");
  let durationMs = durationRaw ? parseDurationMs(durationRaw) : null;
  if (durationMs === null && hoursRaw) {
    const hours = Number(hoursRaw.replace(",", "."));
    durationMs = Number.isFinite(hours) ? Math.round(hours * 3_600_000) : null;
  }

  if (!startDateRaw) return skip(index, "no start date");

  let checkIn = parseDateAndTime(startDateRaw, startTimeRaw);
  if (!checkIn) return skip(index, `start "${`${startDateRaw} ${startTimeRaw}`.trim()}" is not a date`);

  // Harvest-style rows carry a day and an hour count; put them at a plausible
  // hour so the ledger reads as a working day rather than a stack at midnight.
  if (!startTimeRaw && durationMs !== null) {
    const day = parseDay(startDateRaw)!;
    checkIn = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DEFAULT_START_HOUR);
    warnings.push(`no clock time in the file — placed at ${DEFAULT_START_HOUR}:00 on ${day.toISOString().slice(0, 10)}`);
  }

  const hasExplicitEnd = Boolean(endTimeRaw) || (Boolean(endDateRaw) && endDateRaw !== startDateRaw);
  let checkOut = hasExplicitEnd ? parseDateAndTime(endDateRaw, endTimeRaw) : null;

  if (!checkOut && durationMs !== null) checkOut = new Date(checkIn.getTime() + durationMs);
  if (!checkOut) return skip(index, "neither an end time nor a duration");

  // Toggl and Clockify write a local end time; a session crossing midnight then
  // has an end date one day later. When the file omitted the end date entirely
  // the interval comes out negative, and the duration column is the truth.
  if (checkOut.getTime() < checkIn.getTime() && durationMs !== null && durationMs > 0) {
    checkOut = new Date(checkIn.getTime() + durationMs);
    warnings.push("end was before start — the duration column was used instead");
  }

  if (checkOut.getTime() < checkIn.getTime()) {
    return skip(index, `end ${checkOut.toISOString()} is before start ${checkIn.toISOString()}`, warnings);
  }
  const span = checkOut.getTime() - checkIn.getTime();
  if (span > MAX_ENTRY_MS) {
    return skip(index, `${(span / 3_600_000).toFixed(1)}h is longer than the 24h an entry may span`, warnings);
  }
  if (span === 0) warnings.push("zero-length entry");

  const notes = pick(row, mapping, "notes") || null;
  const entry: NormalisedEntry = {
    userEmail: extractEmail(pick(row, mapping, "userEmail")),
    userName: pick(row, mapping, "userName") || null,
    customerName: pick(row, mapping, "customer") || null,
    streamName: pick(row, mapping, "stream") || null,
    notes: notes ? notes.slice(0, 2000) : null,
    taskRef: pick(row, mapping, "taskRef") || notes || null,
    checkIn,
    checkOut,
  };
  return ok(index, entry, warnings);
}
