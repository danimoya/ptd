/**
 * The read-only calendar feed.
 *
 * `GET /ical/:token.ics` — the token travels in the PATH, not in a header,
 * because that is the only credential a calendar client can carry: Google
 * Calendar, Apple Calendar and Outlook all subscribe by URL and none of them
 * can be told to send `Authorization`. The consequences are faced rather than
 * ignored:
 *
 *   - the URL *is* the secret, so it is minted as an ordinary `ptd_` API token
 *     (`ical.url` in server/actions/import.ts) and revoking that token kills the
 *     feed immediately — the same lever as for any other credential;
 *   - `verifyApiToken` does the whole check, so an expired or revoked token gets
 *     404, not 401: a 401 makes Google prompt the user for a password that does
 *     not exist, while a 404 shows up as "calendar unavailable";
 *   - the feed is read-only and scoped to the token's own org, and `?scope=org`
 *     is refused below manager — a member's feed shows only their own cards.
 *
 * Everything is emitted as an all-day VEVENT. A PTD card is a date range, not an
 * appointment, and `TRANSP:TRANSPARENT` keeps it out of free/busy so a week of
 * tasks does not make somebody look fully booked.
 */

import type { Express, Request, Response } from "express";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { db } from "../db";
import { apps, memberships, organizations, streams, tasks, users } from "../db/schema";
import { baseUrl } from "./discovery";
import { verifyApiToken } from "./tokens";
import { hasRole, isRole } from "./types";

const CRLF = "\r\n";
export const CACHE_SECONDS = 300;
const PRODID = "-//PTD//Plan Track Done//EN";

/* ── RFC 5545 primitives ─────────────────────────────────────────────── */

/**
 * Escape a TEXT value: backslash first (or it would double-escape the escapes
 * we add), then the two delimiters and the newline. Colons and quotes are legal
 * inside TEXT and are deliberately left alone.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold to 75 OCTETS per line with a leading space on continuations (RFC 5545
 * §3.1). Octets, not characters: a line of accented text is longer in UTF-8 than
 * it looks, and a multi-byte character must never be split across the fold or
 * the parser on the other side sees mojibake. The continuation space is part of
 * the 75, so 74 octets of payload go on each wrapped line.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let start = 0;
  let limit = 75; // first line has no continuation space
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Walk back off a UTF-8 continuation byte (10xxxxxx) so we cut on a boundary.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74;
  }
  return parts.join(`${CRLF} `);
}

/** `name:value`, escaped and folded. `params` go in unescaped, as RFC 5545 wants. */
export function contentLine(name: string, value: string, params: string = ""): string {
  return foldLine(`${name}${params}:${escapeText(value)}`);
}

/** UTC stamp for DTSTAMP / LAST-MODIFIED: `20260319T140000Z`. */
export function icalStamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/**
 * `VALUE=DATE` day, in LOCAL calendar terms. A due date of the 20th must read as
 * the 20th in the viewer's calendar, so the server's own date parts are used
 * rather than the UTC ones — `new Date("2026-03-20T00:00:00")` west of Greenwich
 * would otherwise be stamped as the 19th.
 */
export function icalDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/* ── Event model ─────────────────────────────────────────────────────── */

export interface IcalTask {
  id: number;
  title: string;
  status: string;
  externalKey: string | null;
  startDate: Date | null;
  dueDate: Date | null;
  estimatedDuration: number | null;
  priorityScore: number;
  tags: string[];
  streamName: string | null;
  appName: string | null;
  assigneeName: string | null;
  updatedAt: Date | null;
}

/** `[ATL-101] Rework the checkout summary`, or `[PTD-42]` when the card has no key. */
export function eventSummary(task: IcalTask): string {
  return `[${task.externalKey ?? `PTD-${task.id}`}] ${task.title}`;
}

export function eventDescription(task: IcalTask): string {
  const lines = [
    `Stream: ${task.streamName ?? "—"}`,
    `App: ${task.appName ?? "—"}`,
    `Assignee: ${task.assigneeName ?? "unassigned"}`,
    `Status: ${task.status}`,
    `Priority score: ${task.priorityScore}`,
  ];
  if (task.tags.length > 0) lines.push(`Tags: ${task.tags.join(", ")}`);
  return lines.join("\n");
}

/**
 * The card's span as an all-day event.
 *
 * DTEND on a `VALUE=DATE` event is EXCLUSIVE, so a one-day card ends on the
 * following day — get this wrong and every task shows up a day short. A card
 * with only a due date is one day long; one with only a start date runs for its
 * estimate, defaulting to a single day.
 */
export function eventRange(task: IcalTask): { start: Date; end: Date } {
  const start = task.startDate ?? task.dueDate!;
  const lastDay = task.dueDate ?? addDays(start, Math.max(1, task.estimatedDuration ?? 1) - 1);
  const end = lastDay >= start ? lastDay : start;
  return { start, end: addDays(end, 1) };
}

export interface CalendarOptions {
  orgName: string;
  base: string;
  scope: "me" | "org";
  now?: Date;
}

/** Assemble the whole `.ics` body. Pure — the route only supplies the rows. */
export function buildCalendar(tasksIn: IcalTask[], options: CalendarOptions): string {
  const now = options.now ?? new Date();
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    contentLine("X-WR-CALNAME", `PTD — ${options.orgName}`),
    contentLine("X-WR-CALDESC", options.scope === "org" ? `Every scheduled card in ${options.orgName}` : `Cards assigned to you in ${options.orgName}`),
    "X-PUBLISHED-TTL:PT5M",
    "REFRESH-INTERVAL;VALUE=DURATION:PT5M",
  ];

  for (const task of tasksIn) {
    const { start, end } = eventRange(task);
    lines.push(
      "BEGIN:VEVENT",
      `UID:task-${task.id}@ptd`,
      `DTSTAMP:${icalStamp(now)}`,
      `DTSTART;VALUE=DATE:${icalDay(start)}`,
      `DTEND;VALUE=DATE:${icalDay(end)}`,
      contentLine("SUMMARY", eventSummary(task)),
      contentLine("DESCRIPTION", eventDescription(task)),
      contentLine("URL", `${options.base}/plan?task=${task.id}`),
      `STATUS:${task.status === "wontfix" ? "CANCELLED" : "CONFIRMED"}`,
      "TRANSP:TRANSPARENT",
    );
    if (task.tags.length > 0) lines.push(contentLine("CATEGORIES", task.tags.join(",")));
    if (task.updatedAt) lines.push(`LAST-MODIFIED:${icalStamp(task.updatedAt)}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  // Trailing CRLF included: RFC 5545 content lines are terminated, not separated.
  return lines.join(CRLF) + CRLF;
}

/* ── Route ───────────────────────────────────────────────────────────── */

/** Feed path for a token. Kept here so `ical.url` and the route cannot drift. */
export function icalPath(secret: string, scope: "me" | "org"): string {
  return `/ical/${secret}.ics${scope === "org" ? "?scope=org" : ""}`;
}

export function registerIcalRoutes(app: Express) {
  app.get("/ical/:token.ics", async (req: Request, res: Response) => {
    // Express hands `:token.ics` back with or without the extension depending on
    // the path-to-regexp version; strip it either way.
    const raw = String((req.params as Record<string, string>).token ?? "").replace(/\.ics$/i, "");
    const auth = await verifyApiToken(`Bearer ${raw}`);
    // Deliberately 404: a calendar client treats 401 as "ask for a password".
    if (!auth) return res.status(404).type("text/plain").send("Calendar not found. The link may have been revoked — mint a new one in PTD → Org → Import.");

    const scope = req.query.scope === "org" ? "org" : "me";
    const [membership] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, auth.user.id), eq(memberships.orgId, auth.orgId)))
      .limit(1);
    const role = membership && isRole(membership.role) ? membership.role : "member";
    if (scope === "org" && !hasRole(role, "manager")) {
      return res.status(403).type("text/plain").send("The organization-wide feed needs the manager role. Drop ?scope=org for your own cards.");
    }

    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, auth.orgId)).limit(1);

    const scheduled = or(isNotNull(tasks.startDate), isNotNull(tasks.dueDate));
    const where =
      scope === "org"
        ? and(eq(tasks.orgId, auth.orgId), scheduled)
        : and(eq(tasks.orgId, auth.orgId), eq(tasks.assignedTo, auth.user.id), scheduled);

    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        externalKey: tasks.externalKey,
        startDate: tasks.startDate,
        dueDate: tasks.dueDate,
        estimatedDuration: tasks.estimatedDuration,
        priorityScore: tasks.priorityScore,
        tags: tasks.tags,
        updatedAt: tasks.updatedAt,
        streamName: streams.name,
        appName: apps.name,
        assigneeName: users.displayName,
      })
      .from(tasks)
      .leftJoin(streams, eq(tasks.streamId, streams.id))
      .leftJoin(apps, eq(tasks.appId, apps.id))
      .leftJoin(users, eq(tasks.assignedTo, users.id))
      .where(where)
      .orderBy(tasks.startDate, tasks.dueDate, tasks.id);

    const body = buildCalendar(
      rows.map((r) => ({ ...r, tags: Array.isArray(r.tags) ? r.tags : [] })) as IcalTask[],
      { orgName: org?.name ?? "PTD", base: baseUrl(req), scope }
    );

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
    res.set("Content-Disposition", `inline; filename="ptd-${scope}.ics"`);
    res.send(body);
  });
}
