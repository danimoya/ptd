/**
 * The one read every invoice starts from.
 *
 * Both kinds of certified invoice — the contractor's and the customer's — need
 * exactly the same thing: the closed, non-break entries of one calendar month,
 * with the names of what they were booked against, their approval state, and
 * whether some earlier invoice has already claimed them. Doing that in one place
 * means a contractor's invoice and a customer's invoice can never disagree about
 * what a row said.
 *
 * Breaks and still-running sessions are excluded here rather than downstream: a
 * break is not work, and a session with no `check_out` has no duration to bill.
 */

import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../db";
import { memberships, streams, tasks, timeEntries, users } from "../../db/schema";
import { entrySha256, lineMinutes, type SnapshotLine } from "./snapshot";

export interface InvoiceEntryRow {
  id: number;
  userId: number;
  userName: string | null;
  checkIn: Date;
  checkOut: Date;
  taskId: number | null;
  taskKey: string | null;
  taskTitle: string | null;
  streamId: number | null;
  streamName: string | null;
  streamCustomerId: number | null;
  streamHourlyRate: number | null;
  customerId: number | null;
  isBreak: boolean;
  entrySource: string;
  tokensUsed: number | null;
  apiCostUsd: number | null;
  approvalStatus: string;
  lockedInvoiceId: number | null;
}

const view = {
  id: timeEntries.id,
  userId: timeEntries.userId,
  userName: users.displayName,
  checkIn: timeEntries.checkIn,
  checkOut: timeEntries.checkOut,
  taskId: timeEntries.taskId,
  taskKey: tasks.externalKey,
  taskTitle: tasks.title,
  streamId: timeEntries.streamId,
  streamName: streams.name,
  streamCustomerId: streams.customerId,
  streamHourlyRate: streams.hourlyRate,
  customerId: timeEntries.customerId,
  isBreak: timeEntries.isBreak,
  entrySource: timeEntries.entrySource,
  tokensUsed: timeEntries.tokensUsed,
  apiCostUsd: timeEntries.apiCostUsd,
  approvalStatus: timeEntries.approvalStatus,
  lockedInvoiceId: timeEntries.lockedInvoiceId,
} as const;

/** Closed, non-break entries in `[from, to]`, optionally narrowed to one member. */
export async function billableEntries(args: { orgId: number; from: Date; to: Date; userId?: number }): Promise<InvoiceEntryRow[]> {
  const filters = [
    eq(timeEntries.orgId, args.orgId),
    eq(timeEntries.isBreak, false),
    sql`${timeEntries.checkOut} is not null`,
    gte(timeEntries.checkIn, args.from),
    lte(timeEntries.checkIn, args.to),
  ];
  if (args.userId !== undefined) filters.push(eq(timeEntries.userId, args.userId));
  const rows = await db
    .select(view)
    .from(timeEntries)
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .leftJoin(streams, eq(timeEntries.streamId, streams.id))
    .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
    .where(and(...filters))
    .orderBy(asc(timeEntries.checkIn), asc(timeEntries.id));
  return rows as InvoiceEntryRow[];
}

/** The live rows behind an already-issued invoice, for the tamper check. */
export async function lockedEntries(orgId: number, invoiceId: number): Promise<InvoiceEntryRow[]> {
  const rows = await db
    .select(view)
    .from(timeEntries)
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .leftJoin(streams, eq(timeEntries.streamId, streams.id))
    .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
    .where(and(eq(timeEntries.orgId, orgId), eq(timeEntries.lockedInvoiceId, invoiceId)))
    .orderBy(asc(timeEntries.id));
  return rows as InvoiceEntryRow[];
}

/** Freeze one entry into a snapshot line. */
export function snapshotLine(row: InvoiceEntryRow): SnapshotLine {
  return {
    entryId: row.id,
    checkIn: new Date(row.checkIn).toISOString(),
    checkOut: new Date(row.checkOut).toISOString(),
    minutes: lineMinutes(row.checkIn, row.checkOut),
    taskId: row.taskId,
    taskKey: row.taskKey ?? null,
    taskTitle: row.taskTitle ?? null,
    streamId: row.streamId,
    streamName: row.streamName ?? null,
    entrySource: row.entrySource,
    tokensUsed: row.tokensUsed ?? null,
    apiCostUsd: row.apiCostUsd === null || row.apiCostUsd === undefined ? null : Math.round(row.apiCostUsd * 10_000) / 10_000,
    approvalStatus: row.approvalStatus,
    entrySha256: entrySha256(row),
  };
}

/* ── Billing profile of one member ───────────────────────────────────── */

export interface BillingProfile {
  userId: number;
  displayName: string;
  email: string;
  isAgent: boolean;
  role: string;
  billable: boolean;
  hourlyRate: number | null;
  currency: string;
  billingName: string | null;
  billingAddress: string | null;
  taxId: string | null;
  requireApproval: boolean;
}

/** One member's billing settings, or null when they are not in this organization. */
export async function billingProfile(orgId: number, userId: number): Promise<BillingProfile | null> {
  const [row] = await db
    .select({
      userId: memberships.userId,
      displayName: users.displayName,
      email: users.email,
      isAgent: users.isAgent,
      role: memberships.role,
      billable: memberships.billable,
      hourlyRate: memberships.hourlyRate,
      currency: memberships.currency,
      billingName: memberships.billingName,
      billingAddress: memberships.billingAddress,
      taxId: memberships.taxId,
      requireApproval: memberships.requireApproval,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Every member's billing settings, for the Members tab. */
export async function billingProfiles(orgId: number): Promise<BillingProfile[]> {
  const rows = await db
    .select({
      userId: memberships.userId,
      displayName: users.displayName,
      email: users.email,
      isAgent: users.isAgent,
      role: memberships.role,
      billable: memberships.billable,
      hourlyRate: memberships.hourlyRate,
      currency: memberships.currency,
      billingName: memberships.billingName,
      billingAddress: memberships.billingAddress,
      taxId: memberships.taxId,
      requireApproval: memberships.requireApproval,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(users.displayName));
  return rows;
}

export { isNull };
