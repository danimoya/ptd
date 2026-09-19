/**
 * Productivity insights: when the work happens, how it is broken up, and a
 * short plain-English reading of the numbers.
 *
 * Everything here is a pure function over the same `ReportRow` shape
 * `reports.ts` reads, for the same reason: the narrative is the part most
 * likely to drift, and a sentence generator is only trustworthy if it can be
 * asserted on in a test without a database.
 *
 * There is no model in this file. Every sentence is assembled from figures
 * computed in `foldPatterns`, so the summary can never invent a number, and the
 * same window always produces the same words.
 */

import { format } from "date-fns";
import { minutesFrom, num, usd, type AgentBucket, type HumanBucket } from "./aggregate";
import { customerOf, dayKey, isAgentRow, rowSeconds, type ReportRow, type StreamSplit } from "./reports";

/** Two work sessions closer than this read as one unbroken stretch of attention. */
export const FOCUS_GAP_MINUTES = 10;

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/* ── Shapes ──────────────────────────────────────────────────────────── */

export interface Cell {
  minutes: number;
  sessions: number;
  humanSessions: number;
  agentSessions: number;
  human: HumanBucket;
  agent: AgentBucket;
}

export interface HourCell extends Cell {
  hour: number;
  /** "09:00" — printed straight onto the heat strip's axis. */
  label: string;
}

export interface WeekdayCell extends Cell {
  weekday: number;
  name: string;
  /** Days in the window that fell on this weekday and carried work. */
  activeDays: number;
}

export interface BreakStats {
  count: number;
  minutes: number;
  avgMinutes: number;
  /** Breaks per day on which work was logged — TTM's "break frequency". */
  perActiveDay: number;
  longestMinutes: number;
}

export interface FocusBlock {
  minutes: number;
  startedAt: string;
  endedAt: string;
  sessions: number;
  entryIds: number[];
  userId: number;
  userName: string | null;
  streamId: number | null;
  streamName: string | null;
  taskTitle: string | null;
  entrySource: "human" | "agent" | "mixed";
}

export interface Patterns {
  from: string;
  to: string;
  minutes: number;
  breakMinutes: number;
  sessions: number;
  humanSessions: number;
  agentSessions: number;
  activeDays: number;
  avgSessionMinutes: number;
  human: HumanBucket;
  agent: AgentBucket;
  byHour: HourCell[];
  byWeekday: WeekdayCell[];
  /** [weekday][hour] work minutes — the hour × weekday heat strip. */
  heat: number[][];
  /** The agent share of the same matrix, so a cell can be coloured by source. */
  heatAgent: number[][];
  heatMax: number;
  breaks: BreakStats;
  longestFocus: FocusBlock | null;
  peakHour: number | null;
  peakWeekday: number | null;
  byStream: StreamSplit[];
  /** Streams carrying agent work, busiest first — what the narrative names. */
  agentStreams: { streamId: number | null; streamName: string | null; minutes: number; totalMinutes: number; costUsd: number; tokens: number; sharePct: number }[];
  customersTouched: number;
}

/* ── Fold ────────────────────────────────────────────────────────────── */

interface Bin {
  workSeconds: number;
  humanSeconds: number;
  agentSeconds: number;
  tokens: number;
  cost: number;
  sessions: number;
  humanSessions: number;
  agentSessions: number;
}

const newBin = (): Bin => ({ workSeconds: 0, humanSeconds: 0, agentSeconds: 0, tokens: 0, cost: 0, sessions: 0, humanSessions: 0, agentSessions: 0 });

function addWork(bin: Bin, row: ReportRow, seconds: number) {
  bin.workSeconds += seconds;
  bin.sessions += 1;
  if (isAgentRow(row)) {
    bin.agentSeconds += seconds;
    bin.agentSessions += 1;
    bin.tokens += num(row.tokensUsed);
    bin.cost += num(row.apiCostUsd);
  } else {
    bin.humanSeconds += seconds;
    bin.humanSessions += 1;
  }
}

function cellOf(bin: Bin): Cell {
  return {
    minutes: minutesFrom(bin.workSeconds),
    sessions: bin.sessions,
    humanSessions: bin.humanSessions,
    agentSessions: bin.agentSessions,
    human: { minutes: minutesFrom(bin.humanSeconds) },
    agent: { minutes: minutesFrom(bin.agentSeconds), tokens: Math.round(bin.tokens), costUsd: usd(bin.cost) },
  };
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/**
 * The longest unbroken stretch of attention in the window: consecutive work
 * sessions by one member, each starting no more than FOCUS_GAP_MINUTES after
 * the previous one ended. A logged break always ends the stretch, which is the
 * whole point of recording breaks.
 */
export function longestFocusBlock(rows: ReportRow[]): FocusBlock | null {
  const ordered = rows.filter((r) => rowSeconds(r) > 0).sort((a, b) => +asDate(a.checkIn) - +asDate(b.checkIn));
  const runs = new Map<number, { rows: ReportRow[]; seconds: number; end: number }>();
  let best: { rows: ReportRow[]; seconds: number } | null = null;

  const consider = (run: { rows: ReportRow[]; seconds: number }) => {
    if (!best || run.seconds > best.seconds) best = { rows: [...run.rows], seconds: run.seconds };
  };

  for (const row of ordered) {
    const start = +asDate(row.checkIn);
    const end = +asDate(row.checkOut!);
    const run = runs.get(row.userId);
    if (row.isBreak) {
      // A break closes whatever the member had going.
      if (run) {
        consider(run);
        runs.delete(row.userId);
      }
      continue;
    }
    if (run && start - run.end <= FOCUS_GAP_MINUTES * 60_000) {
      run.rows.push(row);
      run.seconds += rowSeconds(row);
      run.end = Math.max(run.end, end);
      continue;
    }
    if (run) consider(run);
    runs.set(row.userId, { rows: [row], seconds: rowSeconds(row), end });
  }
  for (const run of runs.values()) consider(run);
  if (!best) return null;

  const blockRows = (best as { rows: ReportRow[]; seconds: number }).rows;
  const seconds = (best as { rows: ReportRow[]; seconds: number }).seconds;
  const first = blockRows[0];
  const last = blockRows[blockRows.length - 1];
  const sources = new Set(blockRows.map((r) => (isAgentRow(r) ? "agent" : "human")));
  const streamIds = new Set(blockRows.map((r) => r.streamId));
  return {
    minutes: minutesFrom(seconds),
    startedAt: asDate(first.checkIn).toISOString(),
    endedAt: asDate(last.checkOut!).toISOString(),
    sessions: blockRows.length,
    entryIds: blockRows.map((r) => r.id),
    userId: first.userId,
    userName: first.userName,
    streamId: streamIds.size === 1 ? first.streamId : null,
    streamName: streamIds.size === 1 ? first.streamName : null,
    taskTitle: blockRows.length === 1 ? first.taskTitle : null,
    entrySource: sources.size === 1 ? (sources.has("agent") ? "agent" : "human") : "mixed",
  };
}

/** Hour-of-day and weekday shape of the window, plus breaks and focus. */
export function foldPatterns(rows: ReportRow[], from: Date, to: Date): Patterns {
  const hours = Array.from({ length: 24 }, newBin);
  const weekdays = Array.from({ length: 7 }, newBin);
  const weekdayDays = Array.from({ length: 7 }, () => new Set<string>());
  const heatSeconds = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const heatAgentSeconds = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const streams = new Map<number | null, Bin & { streamId: number | null; streamName: string | null; streamColor: string | null }>();
  const total = newBin();
  const activeDays = new Set<string>();
  const customersTouched = new Set<number>();

  let breakCount = 0;
  let breakSeconds = 0;
  let longestBreakSeconds = 0;

  for (const row of rows) {
    const seconds = rowSeconds(row);
    if (seconds <= 0) continue;
    const at = asDate(row.checkIn);
    if (row.isBreak) {
      breakCount += 1;
      breakSeconds += seconds;
      longestBreakSeconds = Math.max(longestBreakSeconds, seconds);
      continue;
    }
    const hour = at.getHours();
    const weekday = at.getDay();
    addWork(hours[hour], row, seconds);
    addWork(weekdays[weekday], row, seconds);
    addWork(total, row, seconds);
    heatSeconds[weekday][hour] += seconds;
    if (isAgentRow(row)) heatAgentSeconds[weekday][hour] += seconds;
    const day = dayKey(at);
    activeDays.add(day);
    weekdayDays[weekday].add(day);
    const customerId = customerOf(row);
    if (customerId !== null) customersTouched.add(customerId);

    const bin =
      streams.get(row.streamId) ??
      (() => {
        const fresh = { ...newBin(), streamId: row.streamId, streamName: row.streamName, streamColor: row.streamColor };
        streams.set(row.streamId, fresh);
        return fresh;
      })();
    addWork(bin, row, seconds);
  }

  const heat = heatSeconds.map((byHour) => byHour.map(minutesFrom));
  const heatAgent = heatAgentSeconds.map((byHour) => byHour.map(minutesFrom));
  const heatMax = heat.reduce((max, r) => Math.max(max, ...r), 0);

  const byHour: HourCell[] = hours.map((bin, hour) => ({ hour, label: `${String(hour).padStart(2, "0")}:00`, ...cellOf(bin) }));
  const byWeekday: WeekdayCell[] = weekdays.map((bin, weekday) => ({
    weekday,
    name: WEEKDAY_NAMES[weekday],
    activeDays: weekdayDays[weekday].size,
    ...cellOf(bin),
  }));

  const peakOf = <T extends { minutes: number }>(cells: T[], pick: (c: T) => number): number | null => {
    const best = cells.reduce<T | null>((acc, c) => (acc === null || c.minutes > acc.minutes ? c : acc), null);
    return best && best.minutes > 0 ? pick(best) : null;
  };

  const byStream: StreamSplit[] = Array.from(streams.values())
    .map((b) => {
      const cell = cellOf(b);
      return {
        streamId: b.streamId,
        streamName: b.streamName,
        streamColor: b.streamColor,
        sessions: cell.sessions,
        minutes: cell.minutes,
        human: cell.human,
        agent: cell.agent,
      };
    })
    .sort((a, b) => b.minutes - a.minutes || (a.streamName ?? "").localeCompare(b.streamName ?? ""));

  const totalCell = cellOf(total);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    minutes: totalCell.minutes,
    breakMinutes: minutesFrom(breakSeconds),
    sessions: total.sessions,
    humanSessions: total.humanSessions,
    agentSessions: total.agentSessions,
    activeDays: activeDays.size,
    avgSessionMinutes: total.sessions > 0 ? Math.round(totalCell.minutes / total.sessions) : 0,
    human: totalCell.human,
    agent: totalCell.agent,
    byHour,
    byWeekday,
    heat,
    heatAgent,
    heatMax,
    breaks: {
      count: breakCount,
      minutes: minutesFrom(breakSeconds),
      avgMinutes: breakCount > 0 ? Math.round(minutesFrom(breakSeconds) / breakCount) : 0,
      perActiveDay: activeDays.size > 0 ? Math.round((breakCount / activeDays.size) * 10) / 10 : 0,
      longestMinutes: minutesFrom(longestBreakSeconds),
    },
    longestFocus: longestFocusBlock(rows),
    peakHour: peakOf(byHour, (c) => c.hour),
    peakWeekday: peakOf(byWeekday, (c) => c.weekday),
    byStream,
    agentStreams: byStream
      .filter((s) => s.agent.minutes > 0)
      .map((s) => ({
        streamId: s.streamId,
        streamName: s.streamName,
        minutes: s.agent.minutes,
        totalMinutes: s.minutes,
        costUsd: s.agent.costUsd,
        tokens: s.agent.tokens,
        sharePct: s.minutes > 0 ? Math.round((s.agent.minutes / s.minutes) * 100) : 0,
      }))
      .sort((a, b) => b.minutes - a.minutes),
    customersTouched: customersTouched.size,
  };
}

/* ── Narrative ───────────────────────────────────────────────────────── */

/** "1h 30m" — the same reading as the ledger's duration column. */
export function sayMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  if (h === 0) return `${m}m`;
  const rest = m % 60;
  return rest === 0 ? `${h}h` : `${h}h ${String(rest).padStart(2, "0")}m`;
}

export function sayTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function sayUsd(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface SummaryScope {
  /** "your ledger" / "Priya Indigo" / "the organization" — who the window covers. */
  who: string;
}

/**
 * Three to six sentences, every figure of which comes out of `patterns`.
 *
 * One sentence always accounts for agent spend, because that is the number this
 * product exists to surface: a manager reading a summary that omits what the
 * agents cost is reading the wrong summary.
 */
export function narrate(p: Patterns, scope: SummaryScope = { who: "this ledger" }): string[] {
  const window = `${format(new Date(p.from), "d MMM")} and ${format(new Date(p.to), "d MMM yyyy")}`;
  const sentences: string[] = [];

  if (p.sessions === 0) {
    return [
      `Nothing was logged to ${scope.who} between ${window}.`,
      "With no sessions on the page there is no pattern to read yet — start a timer, or let an agent log its work over MCP.",
      "Agents have booked no time and no API cost in this window, so there is nothing to pass through.",
    ];
  }

  // 1 — the volume.
  const share = p.minutes > 0 ? Math.round((p.agent.minutes / p.minutes) * 100) : 0;
  sentences.push(
    `Between ${window}, ${scope.who} recorded ${sayMinutes(p.minutes)} across ${plural(p.sessions, "session")} on ${plural(p.activeDays, "day")}, averaging ${sayMinutes(p.avgSessionMinutes)} a session.`
  );

  // 2 — agent cost. Always present, even at zero, so the line is never missing.
  if (p.agentSessions > 0 || p.agent.costUsd > 0) {
    const top = p.agentStreams[0];
    const tail = top
      ? ` — ${top.sharePct}% of the hours on ${top.streamName ?? "unassigned work"}, where most of their time went`
      : ` — ${share}% of the hours logged`;
    sentences.push(
      `Agents logged ${sayMinutes(p.agent.minutes)} across ${plural(p.agentSessions, "session")} for ${sayUsd(p.agent.costUsd)}${tail}.`
    );
    sentences.push(
      `That is ${sayTokens(p.agent.tokens)} tokens and ${share}% of all recorded hours, against ${sayMinutes(p.human.minutes)} of human work.`
    );
  } else {
    sentences.push(`No agent logged against ${scope.who} in this window, so agent API cost for the period is ${sayUsd(0)}.`);
    sentences.push(`All ${sayMinutes(p.human.minutes)} on the page is human work.`);
  }

  // 3 — when the work lands.
  if (p.peakHour !== null && p.peakWeekday !== null) {
    const hourCell = p.byHour[p.peakHour];
    const dayCell = p.byWeekday[p.peakWeekday];
    sentences.push(
      `Work clusters at ${hourCell.label} (${sayMinutes(hourCell.minutes)}), and ${dayCell.name} is the heaviest weekday at ${sayMinutes(dayCell.minutes)}.`
    );
  }

  // 4 — focus.
  if (p.longestFocus) {
    const f = p.longestFocus;
    const whose = f.userName ? `${f.userName}'s` : "the";
    const where = f.streamName ? ` on ${f.streamName}` : "";
    sentences.push(
      `The longest unbroken stretch was ${whose} ${sayMinutes(f.minutes)}${where} on ${format(new Date(f.startedAt), "d MMM")}, ${f.sessions === 1 ? "in a single session" : `over ${plural(f.sessions, "back-to-back session")}`}.`
    );
  }

  // 5 — breaks.
  sentences.push(
    p.breaks.count === 0
      ? `No breaks were logged at all, so the ledger cannot tell rest from unrecorded time.`
      : `${plural(p.breaks.count, "break")} ${p.breaks.count === 1 ? "was" : "were"} logged — ${p.breaks.perActiveDay} a day, averaging ${sayMinutes(p.breaks.avgMinutes)}, ${sayMinutes(p.breaks.minutes)} of recess in total.`
  );

  return sentences.slice(0, 6);
}
