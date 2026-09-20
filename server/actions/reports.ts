/**
 * Reporting actions — registered by importing this module (see ./index.ts).
 *
 * Nine reads: three that roll the ledger up over a window, two that read its
 * shape back as patterns and prose, one that measures customers against their
 * weekly pledge, and three that turn a month into an invoice.
 *
 * Three rules hold across all of them.
 *
 *  1. **Scope is the caller's own ledger.** A member reports on their own rows.
 *     Manager and above may pass another member's `userId`, or the string
 *     `"all"` for the whole organization — the same gate `time_entry.list`
 *     applies, written once in `scope()` so no report can widen it by accident.
 *
 *  2. **Nothing is invented.** Every figure, and every sentence of
 *     `insights.summary`, is folded out of rows the engine returned. There is no
 *     model in this path: the narrative is assembled by `narrate()` from the
 *     same numbers the charts draw, so a summary can never disagree with the
 *     report above it.
 *
 *  3. **The agent column is never optional.** Each bucket, each stream split,
 *     each invoice line and the PDF itself carry the human/agent split with the
 *     agent's tokens and dollars. That split is the reason this surface exists.
 */

import { z } from "zod";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { endOfWeek, startOfWeek, subDays } from "date-fns";
import { db } from "../../db";
import { customers, invoices, organizations, streams, timeEntries, users } from "../../db/schema";
import { ActionError, defineAction, type ActionContext } from "./registry";
import { hasRole } from "../types";
import { endOfDay, parseWhen, startOfDay } from "../track/entries";
import {
  MAX_REPORT_ROWS,
  compareRanges,
  fetchReportRows,
  foldCustomerGoals,
  foldRange,
  searchEntries,
  type GroupBy,
  type ReportRow,
} from "../track/reports";
import { foldPatterns, narrate } from "../track/insights";
import { buildInvoiceData, invoiceReference, monthLabel } from "../track/invoice";
import { customerSnapshot } from "../invoices/customer";
import { certify, verifyUrlFor } from "../invoices/issue";

/* ── Shared input pieces ─────────────────────────────────────────────── */

const whenIn = (what: string) =>
  z.string().min(8).max(40).describe(`${what} as an ISO-8601 datetime (or YYYY-MM-DD for midnight local).`);

const groupByIn = z
  .enum(["day", "week", "month"])
  .describe("Bucket size. Weeks start on Monday; months are calendar months, both in the caller's local time.")
  .default("day");

const streamIdsIn = z
  .array(z.number().int().positive())
  .min(1)
  .max(50)
  .describe("Restrict the report to these streams. Omit for every stream.")
  .optional();

const userIdIn = z
  .union([z.number().int().positive(), z.literal("all")])
  .describe('Whose ledger to report on. Manager and above only; "all" reports the whole organization. Defaults to the caller.')
  .optional();

const includeBreaksIn = z
  .boolean()
  .describe("Count break minutes into each bucket's `breakMinutes`. Breaks never count as work either way.")
  .optional();

const monthIn = z.number().int().min(1).max(12).describe("Calendar month, 1–12.");
const yearIn = z.number().int().min(2000).max(2100).describe("Calendar year.");
const customerIdIn = z.number().int().positive().describe("The customer to bill.");

const manager = (ctx: ActionContext) => hasRole(ctx.role, "manager");

/* ── Scope ───────────────────────────────────────────────────────────── */

/**
 * Org filter plus the user filter the caller is allowed to ask for. Written
 * once: every report in this file starts from it, so widening the scope is a
 * deliberate act rather than a forgotten `eq(userId)`.
 */
function scope(ctx: ActionContext, userId?: number | "all") {
  if (userId !== undefined && userId !== ctx.userId && !manager(ctx)) {
    throw new ActionError("forbidden", "Reporting on another member's ledger requires manager or above");
  }
  const filters = [eq(timeEntries.orgId, ctx.orgId)];
  if (userId !== "all") filters.push(eq(timeEntries.userId, userId ?? ctx.userId));
  return filters;
}

/** How the narrative refers to whose ledger it is reading. */
async function scopeLabel(ctx: ActionContext, userId?: number | "all"): Promise<string> {
  if (userId === "all") return "the organization";
  if (userId === undefined || userId === ctx.userId) return "you";
  const [u] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.displayName ?? `member ${userId}`;
}

/** Window from two optional bounds, defaulting to the trailing 30 days. */
function window(from?: string, to?: string, trailingDays = 30) {
  const end = to ? parseWhen(to, "to") : endOfDay();
  const start = from ? parseWhen(from, "from") : startOfDay(subDays(end, trailingDays - 1));
  if (start > end) throw new ActionError("invalid", "`from` is after `to`");
  return { from: start, to: end };
}

async function rowsFor(ctx: ActionContext, args: { from: Date; to: Date; streamIds?: number[]; userId?: number | "all" }): Promise<ReportRow[]> {
  const filters = scope(ctx, args.userId);
  filters.push(gte(timeEntries.checkIn, args.from), lte(timeEntries.checkIn, args.to));
  if (args.streamIds?.length) filters.push(inArray(timeEntries.streamId, args.streamIds));
  return fetchReportRows(filters);
}

/* ══════════════════════════════════════════════════════════════════════
   Range reports
   ══════════════════════════════════════════════════════════════════════ */

defineAction({
  name: "report.range",
  title: "Hours over a date range, bucketed",
  description:
    "Recorded work between two instants, grouped by day, week or month. Every bucket splits human minutes from agent minutes and carries the agent's tokens and API cost, and each bucket is further split per stream. Breaks and still-running sessions never count as work. A member reports on their own ledger; manager and above may pass another member's userId, or \"all\".",
  input: z.object({
    from: whenIn("Start of the range (inclusive, by when a session opened)"),
    to: whenIn("End of the range (inclusive, by when a session opened)"),
    groupBy: groupByIn,
    streamIds: streamIdsIn,
    includeBreaks: includeBreaksIn,
    userId: userIdIn,
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const { from, to } = window(args.from, args.to);
    const rows = await rowsFor(ctx, { from, to, streamIds: args.streamIds, userId: args.userId });
    return foldRange(rows, {
      from,
      to,
      groupBy: args.groupBy as GroupBy,
      includeBreaks: args.includeBreaks ?? false,
      truncated: rows.length >= MAX_REPORT_ROWS,
    });
  },
});

defineAction({
  name: "report.compare",
  title: "One period against another",
  description:
    "The same roll-up for two windows side by side, with the difference and the percent change for total minutes, human minutes, agent minutes, agent tokens, agent cost, sessions, active days and break minutes. Each metric also carries a trend: an arrow, a direction, and whether that direction is the good one (for cost, tokens and breaks, down is good).",
  input: z.object({
    current: z.object({ from: whenIn("Start of the current period"), to: whenIn("End of the current period") }).describe("The period being judged."),
    previous: z.object({ from: whenIn("Start of the comparison period"), to: whenIn("End of the comparison period") }).describe("What to judge it against."),
    groupBy: groupByIn,
    streamIds: streamIdsIn,
    includeBreaks: includeBreaksIn,
    userId: userIdIn,
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const cur = window(args.current.from, args.current.to);
    const prev = window(args.previous.from, args.previous.to);
    const groupBy = args.groupBy as GroupBy;
    const includeBreaks = args.includeBreaks ?? false;
    const [curRows, prevRows] = await Promise.all([
      rowsFor(ctx, { ...cur, streamIds: args.streamIds, userId: args.userId }),
      rowsFor(ctx, { ...prev, streamIds: args.streamIds, userId: args.userId }),
    ]);
    return compareRanges(
      foldRange(curRows, { ...cur, groupBy, includeBreaks, truncated: curRows.length >= MAX_REPORT_ROWS }),
      foldRange(prevRows, { ...prev, groupBy, includeBreaks, truncated: prevRows.length >= MAX_REPORT_ROWS })
    );
  },
});

defineAction({
  name: "report.search",
  title: "Search the ledger",
  description:
    "Case-insensitive search across entry notes and the titles of the tasks entries point at, newest first, with the total number of matches and their total minutes. Filter by window, stream, task or a minimum session length. `%` and `_` in the query are matched literally.",
  input: z.object({
    query: z.string().min(1).max(200).describe("Text to look for in a note or a task title."),
    from: whenIn("Only sessions that started at or after this instant").optional(),
    to: whenIn("Only sessions that started at or before this instant").optional(),
    streamId: z.number().int().positive().describe("Only sessions in this stream.").optional(),
    taskId: z.number().int().positive().describe("Only sessions against this task.").optional(),
    minMinutes: z.number().int().min(0).max(1440).describe("Drop sessions shorter than this.").optional(),
    limit: z.number().int().min(1).max(200).describe("Matches per page (default 25).").optional(),
    offset: z.number().int().min(0).max(100_000).describe("How many matches to skip (default 0).").optional(),
    userId: userIdIn,
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) =>
    searchEntries(scope(ctx, args.userId), {
      query: args.query,
      from: args.from ? parseWhen(args.from, "from") : undefined,
      to: args.to ? parseWhen(args.to, "to") : undefined,
      streamId: args.streamId,
      taskId: args.taskId,
      minMinutes: args.minMinutes,
      limit: args.limit ?? 25,
      offset: args.offset ?? 0,
    }),
});

/* ══════════════════════════════════════════════════════════════════════
   Insights
   ══════════════════════════════════════════════════════════════════════ */

defineAction({
  name: "insights.patterns",
  title: "When the work happens",
  description:
    "The shape of a window: minutes by hour of day and by weekday (human vs agent in both), a 7×24 heat matrix for the heat strip, break count and frequency, the longest unbroken stretch of work, and the peak hour and weekday. Defaults to the trailing 30 days.",
  input: z.object({
    from: whenIn("Start of the window").optional(),
    to: whenIn("End of the window").optional(),
    streamIds: streamIdsIn,
    userId: userIdIn,
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const { from, to } = window(args.from, args.to);
    const rows = await rowsFor(ctx, { from, to, streamIds: args.streamIds, userId: args.userId });
    return { ...foldPatterns(rows, from, to), truncated: rows.length >= MAX_REPORT_ROWS };
  },
});

defineAction({
  name: "insights.summary",
  title: "The window in plain English",
  description:
    "Three to six sentences reading the window back: how much was logged and over how many sessions, what the agents logged and what their API cost came to, when the work clusters, the longest unbroken stretch, and how breaks were taken. Every figure is computed from the ledger — there is no language model in this path, and the same window always produces the same words.",
  input: z.object({
    from: whenIn("Start of the window").optional(),
    to: whenIn("End of the window").optional(),
    streamIds: streamIdsIn,
    userId: userIdIn,
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const { from, to } = window(args.from, args.to);
    const [rows, who] = await Promise.all([
      rowsFor(ctx, { from, to, streamIds: args.streamIds, userId: args.userId }),
      scopeLabel(ctx, args.userId),
    ]);
    const patterns = foldPatterns(rows, from, to);
    return {
      from: patterns.from,
      to: patterns.to,
      sentences: narrate(patterns, { who }),
      facts: {
        minutes: patterns.minutes,
        breakMinutes: patterns.breakMinutes,
        sessions: patterns.sessions,
        activeDays: patterns.activeDays,
        avgSessionMinutes: patterns.avgSessionMinutes,
        human: patterns.human,
        agent: patterns.agent,
        agentSessions: patterns.agentSessions,
        humanSessions: patterns.humanSessions,
        peakHour: patterns.peakHour,
        peakWeekday: patterns.peakWeekday,
        longestFocusMinutes: patterns.longestFocus?.minutes ?? 0,
        breaks: patterns.breaks,
        agentStreams: patterns.agentStreams,
      },
    };
  },
});

/* ══════════════════════════════════════════════════════════════════════
   Customer goals
   ══════════════════════════════════════════════════════════════════════ */

defineAction({
  name: "customer.goals",
  title: "Weekly goal vs logged, per customer",
  description:
    "Every customer's weekly goal against what the organization actually logged for them this week, with the human/agent split and a per-stream breakdown. A session bills to the customer of the stream it sits in (falling back to the session's own customer when it has no stream). Monday-first weeks.",
  input: z.object({
    weekOf: whenIn("Any instant inside the week to report on. Defaults to this week.").optional(),
  }),
  requiredRole: "manager",
  surface: "track",
  handler: async (args, ctx) => {
    const anchor = args.weekOf ? parseWhen(args.weekOf, "weekOf") : new Date();
    const from = startOfWeek(anchor, { weekStartsOn: 1 });
    const to = endOfWeek(anchor, { weekStartsOn: 1 });
    const [rows, customerRows, streamRows] = await Promise.all([
      fetchReportRows([eq(timeEntries.orgId, ctx.orgId), gte(timeEntries.checkIn, from), lte(timeEntries.checkIn, to)]),
      db
        .select({ id: customers.id, name: customers.name, weeklyGoalHours: customers.weeklyGoalHours })
        .from(customers)
        .where(eq(customers.orgId, ctx.orgId))
        .orderBy(customers.name),
      db
        .select({ id: streams.id, name: streams.name, customerId: streams.customerId })
        .from(streams)
        .where(eq(streams.orgId, ctx.orgId)),
    ]);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      customers: foldCustomerGoals(rows, customerRows, streamRows),
    };
  },
});

/* ══════════════════════════════════════════════════════════════════════
   Invoices
   ══════════════════════════════════════════════════════════════════════ */

async function orgName(orgId: number): Promise<string> {
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return org?.name ?? "Plan Track Done";
}

export const invoicePdfPath = (invoiceId: number): string => `/api/track/invoices/${invoiceId}.pdf`;

defineAction({
  name: "invoice.preview",
  title: "What a month's invoice would say",
  description:
    "The line items a customer's month would bill: one line per stream × task with its session count, human minutes, agent minutes, agent tokens, agent API cost, the hourly rate that applies and the amount, plus the totals and the agent spend as a pass-through figure. Nothing is written — this is the document a manager reads before committing to it. A stream's own hourly rate overrides the customer's; where neither is recorded the line states hours with no money attached.",
  input: z.object({ customerId: customerIdIn, month: monthIn, year: yearIn }),
  requiredRole: "manager",
  surface: "track",
  handler: async (args, ctx) =>
    buildInvoiceData({
      orgId: ctx.orgId,
      orgName: await orgName(ctx.orgId),
      customerId: args.customerId,
      month: args.month,
      year: args.year,
    }),
});

defineAction({
  name: "invoice.generate",
  title: "Commit a month's invoice",
  description:
    "Issue the invoice: freeze the month's entries into a signed snapshot, lock them against further edits, and hand back the document's verification URL and PDF. The snapshot records each entry's times and a hash of its immutable columns; the record is hashed and signed with the deployment's Ed25519 key, so the customer — or their accountant — can confirm at the verification URL that this deployment issued the document and that the hours behind it have not moved since. Because the rows are now locked, re-issuing a month means voiding the first invoice with `invoice.void` rather than generating a second on top of it.",
  input: z.object({ customerId: customerIdIn, month: monthIn, year: yearIn }),
  requiredRole: "manager",
  audited: true,
  surface: "track",
  handler: async (args, ctx) => {
    // Preview first: this both validates the customer is in the org and gives
    // the totals recorded on the row.
    const data = await buildInvoiceData({
      orgId: ctx.orgId,
      orgName: await orgName(ctx.orgId),
      customerId: args.customerId,
      month: args.month,
      year: args.year,
    });
    if (data.alreadyInvoiced?.length) {
      const first = data.alreadyInvoiced[0];
      throw new ActionError(
        "conflict",
        `${data.alreadyInvoiced.length} of that month's entries are already frozen into invoice ${first.invoiceId} (entry ${first.entryId}). Void it first if the month needs re-issuing.`
      );
    }
    const issuedAt = new Date();
    const [row] = await db
      .insert(invoices)
      .values({
        orgId: ctx.orgId,
        customerId: args.customerId,
        userId: ctx.userId,
        kind: "customer",
        month: args.month,
        year: args.year,
        status: "issued",
        currency: data.currency ?? "USD",
        rate: data.customer.hourlyRate ?? null,
        totalMinutes: data.totals.minutes,
        amountCents: data.totals.amountCents,
        totalAmount: data.totals.amountCents ?? data.totals.minutes,
        issuedAt,
      })
      .returning();

    // The reference is inside what gets signed, so the row — and therefore its
    // number — has to exist before the snapshot can be built.
    const reference = invoiceReference(args.year, args.month, row.id);
    const issued = await certify({
      orgId: ctx.orgId,
      invoiceId: row.id,
      reference,
      snapshot: customerSnapshot({ ...data, invoiceId: row.id, reference, status: "issued", issuedAt: issuedAt.toISOString() }),
      entryIds: (data.entries ?? []).map((e) => e.entryId),
      currency: data.currency ?? "USD",
      rate: data.customer.hourlyRate ?? null,
      totalMinutes: data.totals.minutes,
      amountCents: data.totals.amountCents,
      issuedAt,
    });

    return {
      invoiceId: row.id,
      kind: "customer",
      pdfUrl: issued.pdfUrl,
      reference: issued.reference,
      verifyUrl: issued.verifyUrl,
      verifyToken: issued.verifyToken,
      contentHash: issued.contentHash,
      signingKeyId: issued.signingKeyId,
      status: "issued",
      customer: data.customer,
      period: data.period,
      currency: data.currency ?? "USD",
      totals: data.totals,
      lineCount: data.lines.length,
      entryCount: (data.entries ?? []).length,
      lockedEntryIds: (data.entries ?? []).map((e) => e.entryId),
    };
  },
});

defineAction({
  name: "invoice.list",
  title: "Invoices issued",
  description:
    "Every customer invoice recorded for the organization, newest period first, with the customer it was rendered to, who issued it, the total in minutes and money, whether it has been voided, and the URLs of its PDF and its public verification page. Contractor invoices have their own list — `invoice.contractor_list` — because a member may read their own.",
  input: z.object({
    customerId: customerIdIn.describe("Only this customer's invoices.").optional(),
    limit: z.number().int().min(1).max(200).describe("Maximum rows (default 100).").optional(),
  }),
  requiredRole: "manager",
  surface: "track",
  handler: async (args, ctx) => {
    const filters = [eq(invoices.orgId, ctx.orgId), eq(invoices.kind, "customer")];
    if (args.customerId !== undefined) filters.push(eq(invoices.customerId, args.customerId));
    const rows = await db
      .select({
        id: invoices.id,
        customerId: invoices.customerId,
        customerName: customers.name,
        userId: invoices.userId,
        issuedBy: users.displayName,
        month: invoices.month,
        year: invoices.year,
        status: invoices.status,
        totalMinutes: invoices.totalAmount,
        pdfUrl: invoices.pdfUrl,
        reference: invoices.reference,
        currency: invoices.currency,
        amountCents: invoices.amountCents,
        contentHash: invoices.contentHash,
        verifyToken: invoices.verifyToken,
        voidedAt: invoices.voidedAt,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .leftJoin(users, eq(invoices.userId, users.id))
      .where(and(...filters))
      // `ORDER BY 2 DESC` style positional ordering is what HeliosDB-Nano wants
      // after a GROUP BY; there is no grouping here, so plain columns are fine.
      .orderBy(desc(invoices.year), desc(invoices.month), desc(invoices.id))
      .limit(args.limit ?? 100);
    return rows.map((r) => ({
      ...r,
      periodLabel: monthLabel(r.month, r.year),
      pdfUrl: r.pdfUrl ?? invoicePdfPath(r.id),
      totalMinutes: r.totalMinutes ?? 0,
      reference: r.reference ?? invoiceReference(r.year, r.month, r.id),
      verifyUrl: r.verifyToken ? verifyUrlFor(r.verifyToken) : null,
      voided: r.voidedAt !== null,
    }));
  },
});
