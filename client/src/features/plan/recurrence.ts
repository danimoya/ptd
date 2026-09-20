/**
 * Client-side copy of server/plan/recurrence.ts — kept deliberately identical
 * so the preview under the dialog's recurrence field is the same sentence the
 * scheduler acts on, and a rule the field accepts is a rule the server accepts.
 * tests/workflow/recurrence.test.ts asserts the two agree, rule by rule; if you
 * change one, change the other.
 *
 *   daily                 every day
 *   weekdays              Monday–Friday
 *   weekly:mon,wed        those weekdays
 *   monthly:15            the 15th (clamped to the last day of a short month)
 *   every:3d | every:2w   a fixed cadence anchored on the day the rule was set
 *
 * Any of them may carry `at:09:00`. **Times are UTC in v1** — an org-local
 * clock needs a timezone on the organization, which the frozen schema has no
 * column for, so the preview says "UTC" out loud rather than implying local.
 */

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** 09:00 UTC: early enough to be "this morning's card" in Europe, late enough not to land on yesterday in the Americas. */
export const DEFAULT_HOUR = 9;
export const DEFAULT_MINUTE = 0;

export interface ParsedRule {
  kind: "daily" | "weekdays" | "weekly" | "monthly" | "every";
  /** weekly: 0 (Sunday) – 6, ascending, de-duplicated. */
  days?: number[];
  /** monthly: 1–31, clamped to the month's length when it runs. */
  day?: number;
  /** every: the count, with `unit`. */
  every?: number;
  unit?: "d" | "w";
  hour: number;
  minute: number;
}

export type ParseResult = { ok: true; rule: ParsedRule; canonical: string } | { ok: false; error: string };

const GRAMMAR = "daily · weekdays · weekly:mon,wed · monthly:15 · every:3d · every:2w, with an optional at:09:00";

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `at:09:00` → {hour, minute}; anything else is a caller error. */
function parseTime(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Parse a rule string. Never throws: callers turn `{ok:false}` into whatever
 * their surface wants (an ActionError on the server, red text in the dialog).
 */
export function parseRule(raw: string): ParseResult {
  // "weekly:mon, wed" is what a person types; that comma list is one word.
  const text = (raw ?? "").trim().toLowerCase().replace(/\s*,\s*/g, ",");
  if (!text) return { ok: false, error: `Empty rule. Use one of: ${GRAMMAR}` };

  let hour = DEFAULT_HOUR;
  let minute = DEFAULT_MINUTE;
  const words: string[] = [];
  for (const word of text.split(/[\s;]+/).filter(Boolean)) {
    if (word.startsWith("at:")) {
      const time = parseTime(word.slice(3));
      if (!time) return { ok: false, error: `"${word}" is not a time — write it as at:09:00 (UTC)` };
      hour = time.hour;
      minute = time.minute;
      continue;
    }
    words.push(word);
  }
  if (words.length === 0) return { ok: false, error: `A rule needs a cadence as well as a time: ${GRAMMAR}` };
  if (words.length > 1) return { ok: false, error: `"${words.join(" ")}" is more than one cadence — pick one of: ${GRAMMAR}` };

  const head = words[0];
  const at = `at:${two(hour)}:${two(minute)}`;

  if (head === "daily") return { ok: true, rule: { kind: "daily", hour, minute }, canonical: `daily ${at}` };
  if (head === "weekdays") return { ok: true, rule: { kind: "weekdays", hour, minute }, canonical: `weekdays ${at}` };

  const [name, arg] = splitOnce(head, ":");
  if (name === "weekly") {
    if (!arg) return { ok: false, error: "weekly needs the days: weekly:mon,wed" };
    const days: number[] = [];
    for (const part of arg.split(",").filter(Boolean)) {
      const index = (WEEKDAYS as readonly string[]).indexOf(part.slice(0, 3));
      if (index < 0) return { ok: false, error: `"${part}" is not a weekday — use ${WEEKDAYS.join(", ")}` };
      if (!days.includes(index)) days.push(index);
    }
    if (days.length === 0) return { ok: false, error: "weekly needs at least one day: weekly:mon,wed" };
    days.sort((a, b) => a - b);
    return { ok: true, rule: { kind: "weekly", days, hour, minute }, canonical: `weekly:${days.map((d) => WEEKDAYS[d]).join(",")} ${at}` };
  }

  if (name === "monthly") {
    const day = arg ? parseInt(arg, 10) : NaN;
    if (!Number.isInteger(day) || day < 1 || day > 31) return { ok: false, error: "monthly needs a day of the month between 1 and 31: monthly:15" };
    return { ok: true, rule: { kind: "monthly", day, hour, minute }, canonical: `monthly:${day} ${at}` };
  }

  if (name === "every") {
    const m = /^(\d+)([dw])$/.exec(arg ?? "");
    if (!m) return { ok: false, error: "every needs a count and a unit: every:3d (days) or every:2w (weeks)" };
    const count = parseInt(m[1], 10);
    if (count < 1 || count > 365) return { ok: false, error: "every:N must be between 1 and 365" };
    return { ok: true, rule: { kind: "every", every: count, unit: m[2] as "d" | "w", hour, minute }, canonical: `every:${count}${m[2]} ${at}` };
  }

  return { ok: false, error: `"${head}" is not a recurrence rule. Use one of: ${GRAMMAR}` };
}

function splitOnce(value: string, sep: string): [string, string | undefined] {
  const i = value.indexOf(sep);
  return i < 0 ? [value, undefined] : [value.slice(0, i), value.slice(i + 1)];
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function atOn(date: Date, hour: number, minute: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, 0, 0));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/**
 * The first firing strictly after `from`, in UTC. Strictly, so feeding a run's
 * own scheduled time back in advances the cadence instead of repeating it.
 */
export function nextRunAfter(rule: ParsedRule, from: Date): Date {
  const { hour, minute } = rule;

  if (rule.kind === "daily") {
    let candidate = atOn(from, hour, minute);
    if (candidate <= from) candidate = atOn(addDays(from, 1), hour, minute);
    return candidate;
  }

  if (rule.kind === "weekdays") {
    let candidate = atOn(from, hour, minute);
    if (candidate <= from) candidate = atOn(addDays(candidate, 1), hour, minute);
    for (let i = 0; i < 7 && (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6); i++) {
      candidate = atOn(addDays(candidate, 1), hour, minute);
    }
    return candidate;
  }

  if (rule.kind === "weekly") {
    const days = rule.days ?? [];
    let candidate = atOn(from, hour, minute);
    if (candidate <= from) candidate = atOn(addDays(candidate, 1), hour, minute);
    for (let i = 0; i < 7 && !days.includes(candidate.getUTCDay()); i++) {
      candidate = atOn(addDays(candidate, 1), hour, minute);
    }
    return candidate;
  }

  if (rule.kind === "monthly") {
    const wanted = rule.day ?? 1;
    let year = from.getUTCFullYear();
    let month = from.getUTCMonth();
    for (let i = 0; i < 24; i++) {
      const day = Math.min(wanted, daysInMonth(year, month));
      const candidate = new Date(Date.UTC(year, month, day, hour, minute, 0, 0));
      if (candidate > from) return candidate;
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
    // Unreachable: 24 months always contains a later date.
    return new Date(Date.UTC(year + 1, 0, 1, hour, minute, 0, 0));
  }

  const step = (rule.every ?? 1) * (rule.unit === "w" ? 7 : 1);
  let candidate = atOn(from, hour, minute);
  if (candidate <= from) candidate = atOn(addDays(candidate, step), hour, minute);
  return candidate;
}

/** The first firing strictly after `from` that is also in the future — a rule left paused does not fire its whole backlog. */
export function catchUp(rule: ParsedRule, from: Date, now: Date): Date {
  let next = nextRunAfter(rule, from);
  for (let i = 0; i < 4000 && next <= now; i++) next = nextRunAfter(rule, next);
  return next;
}

/** "every Monday and Wednesday at 09:00 UTC" — the preview under the dialog field. */
export function describeRule(rule: ParsedRule): string {
  const time = `at ${two(rule.hour)}:${two(rule.minute)} UTC`;
  switch (rule.kind) {
    case "daily":
      return `every day ${time}`;
    case "weekdays":
      return `every weekday ${time}`;
    case "weekly":
      return `every ${listOf((rule.days ?? []).map((d) => WEEKDAY_LABELS[d]))} ${time}`;
    case "monthly":
      return `on the ${ordinal(rule.day ?? 1)} of each month ${time}`;
    default: {
      const n = rule.every ?? 1;
      if (rule.unit === "w") return n === 1 ? `every week ${time}` : `every ${n} weeks ${time}`;
      return n === 1 ? `every day ${time}` : `every ${n} days ${time}`;
    }
  }
}

/** Parse and describe in one go, for a live-typed field. */
export function describe(raw: string): string | null {
  const parsed = parseRule(raw);
  return parsed.ok ? describeRule(parsed.rule) : null;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** `PTD-12` + 2026-09-20 → `PTD-12-20260920`, the instance's externalKey. */
export function instanceKey(templateKey: string, when: Date): string {
  const stamp = `${when.getUTCFullYear()}${two(when.getUTCMonth() + 1)}${two(when.getUTCDate())}`;
  return `${templateKey}-${stamp}`;
}
