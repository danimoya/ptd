/**
 * Contractor billing: who is external, whose hours need approving, and the
 * certified invoices that come out the other end.
 *
 * Registered by importing this module (see ./index.ts).
 *
 * The feature exists because an organization's hours are not all the same kind of
 * hour. Salaried members log time to see where it went; an **external** member
 * logs time that someone has to pay for. Flipping `memberships.billable` is what
 * says which is which, and from that one flag the rest follows: a rate, a billing
 * name and tax id for the document, and optionally an approval gate so a manager
 * signs off the month before it can be invoiced.
 *
 * Four rules hold across this file.
 *
 *  1. **Billing settings are admin's.** A rate is money; a member cannot set
 *     their own. `member.set_billing` is admin+, and the only way in.
 *  2. **Approval is a manager's signature, and it is recorded.** `approved_by`
 *     and `approved_at` are written from the context, never from an argument.
 *  3. **Issuing an invoice freezes what it says.** See server/invoices/issue.ts:
 *     the rows are snapshotted, hashed, signed and locked in one step, and a
 *     locked entry refuses edits (server/track/entries.ts).
 *  4. **A member may always read their own.** Previews and the invoice list are
 *     open to the member the invoice is about — they are the party being paid, and
 *     a document about you that you cannot read is not a document, it is a rumour.
 */

import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../db";
import { invoices, memberships, organizations, timeEntries, users } from "../../db/schema";
import { ActionError, defineAction, type ActionContext } from "./registry";
import { hasRole } from "../types";
import { getWebSocketManager } from "../websocket";
import { entryMinutes } from "../track/aggregate";
import { monthLabel, monthWindow } from "../track/invoice";
import { billingProfile, billingProfiles } from "../invoices/entries";
import { buildContractorInvoice, contractorReference, contractorSnapshot } from "../invoices/contractor";
import { certify, verifyUrlFor, voidInvoice } from "../invoices/issue";
import { invoiceForSharing, recipientHash, recipientsOf, shareInvoice, unshareInvoice, MAX_RECIPIENTS } from "../invoices/access";
import { audit } from "../audit/log";
import { assertCertifiedInvoices } from "../billing/gate";
import { meterIssuedInvoice } from "../billing/metering";
import { parseWhen } from "../track/entries";

/* ── Shared input pieces ─────────────────────────────────────────────── */

const idIn = (what: string) => z.number().int().positive().describe(what);
const monthIn = z.number().int().min(1).max(12).describe("Calendar month, 1–12.");
const yearIn = z.number().int().min(2000).max(2100).describe("Calendar year.");
const whenIn = (what: string) => z.string().min(8).max(40).describe(`${what} as an ISO-8601 datetime (or YYYY-MM-DD for midnight local).`);

const manager = (ctx: ActionContext) => hasRole(ctx.role, "manager");

const CURRENCY = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "currency must be a three-letter ISO 4217 code")
  .transform((v) => v.toUpperCase())
  .describe("ISO 4217 currency of this member's rate, e.g. USD or EUR.");

function ws() {
  return getWebSocketManager();
}

async function orgName(orgId: number): Promise<string> {
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return org?.name ?? "Plan Track Done";
}

/** A member may act on themselves; reaching another member's row needs manager+. */
function selfOrManager(ctx: ActionContext, userId: number, what: string) {
  if (userId !== ctx.userId && !manager(ctx)) {
    throw new ActionError("forbidden", `${what} for another member requires manager or above`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   Who is external — the billing settings on a membership
   ══════════════════════════════════════════════════════════════════════ */

defineAction({
  name: "member.set_billing",
  title: "Set a member's billing",
  description:
    "Mark a member as external (billable) and record what invoicing them needs: an hourly rate and currency, the legal name and address to print as the issuer, a tax id, and whether their hours must be approved by a manager before they can be invoiced. Turning `billable` off leaves the recorded rate and details alone, so switching a contractor back on does not mean re-typing them. Admin and above: a rate is money, and nobody sets their own.",
  input: z.object({
    userId: idIn("The member to configure."),
    billable: z.boolean().describe("True for an external member PTD should invoice; false for salaried staff and agent seats."),
    hourlyRate: z.number().min(0).max(100_000).describe("What an hour of their time bills at. Omit (or null) to invoice hours with no money attached.").nullable().optional(),
    currency: CURRENCY.optional(),
    billingName: z.string().max(200).describe("Legal or trading name to print as the invoice's issuer. Defaults to their display name.").nullable().optional(),
    billingAddress: z.string().max(2000).describe("Postal address printed under the issuer's name.").nullable().optional(),
    taxId: z.string().max(64).describe("VAT / tax registration number printed on the invoice.").nullable().optional(),
    requireApproval: z.boolean().describe("When true, their entries start as `pending` and only approved entries can be invoiced.").optional(),
  }),
  requiredRole: "admin",
  surface: "org",
  audited: true,
  handler: async (args, ctx) => {
    const profile = await billingProfile(ctx.orgId, args.userId);
    if (!profile) throw new ActionError("not_found", `User ${args.userId} is not a member of this organization`);

    const [updated] = await db
      .update(memberships)
      .set({
        billable: args.billable,
        ...(args.hourlyRate !== undefined ? { hourlyRate: args.hourlyRate } : {}),
        ...(args.currency !== undefined ? { currency: args.currency } : {}),
        ...(args.billingName !== undefined ? { billingName: args.billingName } : {}),
        ...(args.billingAddress !== undefined ? { billingAddress: args.billingAddress } : {}),
        ...(args.taxId !== undefined ? { taxId: args.taxId } : {}),
        ...(args.requireApproval !== undefined ? { requireApproval: args.requireApproval } : {}),
      })
      .where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, args.userId)))
      .returning();

    return {
      userId: args.userId,
      displayName: profile.displayName,
      billable: updated.billable,
      hourlyRate: updated.hourlyRate,
      currency: updated.currency,
      billingName: updated.billingName,
      billingAddress: updated.billingAddress,
      taxId: updated.taxId,
      requireApproval: updated.requireApproval,
    };
  },
});

defineAction({
  name: "member.billing",
  title: "Read billing settings",
  description:
    "A member's billing settings, or every member's when you name nobody. A member may always read their own; reading someone else's requires manager or above. The row says whether they are external, at what rate and in what currency, the issuer details their invoice prints, and whether their hours need approving.",
  input: z.object({
    userId: idIn("Whose settings to read. Omit for every member in the organization (manager and above), or for your own.").optional(),
  }),
  requiredRole: "member",
  surface: "org",
  handler: async (args, ctx) => {
    if (args.userId === undefined) {
      if (!manager(ctx)) {
        const own = await billingProfile(ctx.orgId, ctx.userId);
        return own ? [own] : [];
      }
      return billingProfiles(ctx.orgId);
    }
    selfOrManager(ctx, args.userId, "Reading billing settings");
    const profile = await billingProfile(ctx.orgId, args.userId);
    if (!profile) throw new ActionError("not_found", `User ${args.userId} is not a member of this organization`);
    return profile;
  },
});

/* ══════════════════════════════════════════════════════════════════════
   Approvals
   ══════════════════════════════════════════════════════════════════════ */

const APPROVABLE = [eq(timeEntries.isBreak, false), sql`${timeEntries.checkOut} is not null`, isNull(timeEntries.lockedInvoiceId)];

/** Entries a manager may act on: closed, not a break, not already invoiced. */
async function entriesForApproval(orgId: number, where: ReturnType<typeof eq>[]) {
  return db
    .select({
      id: timeEntries.id,
      userId: timeEntries.userId,
      userName: users.displayName,
      checkIn: timeEntries.checkIn,
      checkOut: timeEntries.checkOut,
      approvalStatus: timeEntries.approvalStatus,
      lockedInvoiceId: timeEntries.lockedInvoiceId,
      isBreak: timeEntries.isBreak,
    })
    .from(timeEntries)
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(and(eq(timeEntries.orgId, orgId), ...where))
    .orderBy(asc(timeEntries.checkIn));
}

function summarise(rows: { id: number; userId: number; checkIn: Date; checkOut: Date | null }[]) {
  const minutes = rows.reduce((t, r) => t + (r.checkOut ? entryMinutes(r.checkIn, r.checkOut) : 0), 0);
  return { entryIds: rows.map((r) => r.id), count: rows.length, minutes, userIds: Array.from(new Set(rows.map((r) => r.userId))) };
}

defineAction({
  name: "time_entry.submit",
  title: "Submit your hours",
  description:
    "Hand a window of your own finished entries to a manager for approval: every closed, non-break entry of yours in the range that is not already approved or invoiced moves to `pending`. This is what an external contractor does at the end of a month; entries that are already approved are left alone, and rejected ones go back to pending so a corrected line can be looked at again.",
  input: z.object({
    from: whenIn("Start of the window to submit"),
    to: whenIn("End of the window to submit"),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const from = parseWhen(args.from, "from");
    const to = parseWhen(args.to, "to");
    if (from > to) throw new ActionError("invalid", "`from` is after `to`");
    const rows = await entriesForApproval(ctx.orgId, [
      eq(timeEntries.userId, ctx.userId),
      gte(timeEntries.checkIn, from),
      lte(timeEntries.checkIn, to),
      ...APPROVABLE,
    ] as never);
    const pending = rows.filter((r) => r.approvalStatus !== "approved");
    if (pending.length === 0) {
      return { submitted: 0, minutes: 0, entryIds: [], alreadyApproved: rows.length };
    }
    const now = new Date();
    await db
      .update(timeEntries)
      .set({ approvalStatus: "pending", approvedBy: null, approvedAt: null, updatedAt: now })
      .where(and(eq(timeEntries.orgId, ctx.orgId), inArray(timeEntries.id, pending.map((r) => r.id))));
    const summary = summarise(pending);
    ws()?.notifyDashboardUpdate(ctx.userId, { reason: "time_entry.submit", entryIds: summary.entryIds });
    return { submitted: summary.count, minutes: summary.minutes, entryIds: summary.entryIds, alreadyApproved: rows.length - pending.length };
  },
});

/** Both approve and reject accept either explicit ids or a member + window. */
const targetIn = {
  entryIds: z.array(z.number().int().positive()).min(1).max(500).describe("The entries to act on. Use this or userId + from + to.").optional(),
  userId: idIn("Act on this member's entries in the window instead of naming ids.").optional(),
  from: whenIn("Start of the window").optional(),
  to: whenIn("End of the window").optional(),
};

async function resolveTargets(ctx: ActionContext, args: { entryIds?: number[]; userId?: number; from?: string; to?: string }) {
  if (args.entryIds?.length) {
    const rows = await entriesForApproval(ctx.orgId, [inArray(timeEntries.id, args.entryIds)] as never);
    const found = new Set(rows.map((r) => r.id));
    const missing = args.entryIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw new ActionError(
        "not_found",
        `${missing.length === 1 ? "Entry" : "Entries"} ${missing.join(", ")} cannot be approved or rejected: not in this organization, still running, a break, or already frozen into an invoice.`
      );
    }
    return rows;
  }
  if (args.userId === undefined || args.from === undefined || args.to === undefined) {
    throw new ActionError("invalid", "Pass entryIds, or userId together with from and to");
  }
  const from = parseWhen(args.from, "from");
  const to = parseWhen(args.to, "to");
  if (from > to) throw new ActionError("invalid", "`from` is after `to`");
  return entriesForApproval(ctx.orgId, [eq(timeEntries.userId, args.userId), gte(timeEntries.checkIn, from), lte(timeEntries.checkIn, to), ...APPROVABLE] as never);
}

defineAction({
  name: "time_entry.approve",
  title: "Approve hours",
  description:
    "Sign off entries so they can be invoiced. Name the entries, or a member and a window to approve the lot. Who approved and when are written from your credential, not from the request. Entries already frozen into an invoice are refused rather than silently skipped, because approving them would change nothing.",
  input: z.object(targetIn),
  requiredRole: "manager",
  surface: "track",
  handler: async (args, ctx) => {
    const rows = await resolveTargets(ctx, args);
    if (rows.length === 0) return { approved: 0, minutes: 0, entryIds: [] };
    const now = new Date();
    await db
      .update(timeEntries)
      .set({ approvalStatus: "approved", approvedBy: ctx.userId, approvedAt: now, updatedAt: now })
      .where(and(eq(timeEntries.orgId, ctx.orgId), inArray(timeEntries.id, rows.map((r) => r.id))));
    const summary = summarise(rows);
    for (const userId of summary.userIds) ws()?.notifyDashboardUpdate(userId, { reason: "time_entry.approve", entryIds: summary.entryIds });
    return { approved: summary.count, minutes: summary.minutes, entryIds: summary.entryIds, approvedBy: ctx.displayName, approvedAt: now.toISOString() };
  },
});

defineAction({
  name: "time_entry.reject",
  title: "Reject hours",
  description:
    "Send entries back with a reason: they become `rejected` and stop counting towards an invoice until the member corrects and resubmits them. The reason is recorded in the organization's audit trail rather than overwriting the member's own note on the line.",
  input: z.object({
    entryIds: z.array(z.number().int().positive()).min(1).max(500).describe("The entries to send back."),
    reason: z.string().min(1).max(500).describe("Why they are being rejected. The member sees it in the audit trail."),
  }),
  requiredRole: "manager",
  surface: "track",
  audited: true,
  handler: async (args, ctx) => {
    const rows = await resolveTargets(ctx, { entryIds: args.entryIds });
    const now = new Date();
    await db
      .update(timeEntries)
      .set({ approvalStatus: "rejected", approvedBy: null, approvedAt: null, updatedAt: now })
      .where(and(eq(timeEntries.orgId, ctx.orgId), inArray(timeEntries.id, rows.map((r) => r.id))));
    const summary = summarise(rows);
    for (const userId of summary.userIds) ws()?.notifyDashboardUpdate(userId, { reason: "time_entry.reject", entryIds: summary.entryIds });
    return { rejected: summary.count, minutes: summary.minutes, entryIds: summary.entryIds, reason: args.reason };
  },
});

defineAction({
  name: "time_entry.pending",
  title: "Hours waiting for approval",
  description:
    "Every entry in the organization waiting for a manager's signature, oldest first, with who logged it and how long it ran. A member sees only their own. This is the queue behind the approval chips on the ledger.",
  input: z.object({
    userId: idIn("Only this member's pending entries.").optional(),
    limit: z.number().int().min(1).max(500).describe("Maximum rows (default 200).").optional(),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const userId = manager(ctx) ? args.userId : ctx.userId;
    if (args.userId !== undefined) selfOrManager(ctx, args.userId, "Reading the approval queue");
    const filters = [eq(timeEntries.orgId, ctx.orgId), eq(timeEntries.approvalStatus, "pending"), ...APPROVABLE];
    if (userId !== undefined) filters.push(eq(timeEntries.userId, userId));
    const rows = await db
      .select({
        id: timeEntries.id,
        userId: timeEntries.userId,
        userName: users.displayName,
        checkIn: timeEntries.checkIn,
        checkOut: timeEntries.checkOut,
        streamId: timeEntries.streamId,
        taskId: timeEntries.taskId,
        entrySource: timeEntries.entrySource,
        approvalStatus: timeEntries.approvalStatus,
      })
      .from(timeEntries)
      .leftJoin(users, eq(timeEntries.userId, users.id))
      .where(and(...filters))
      .orderBy(asc(timeEntries.checkIn))
      .limit(args.limit ?? 200);
    return rows.map((r) => ({ ...r, minutes: r.checkOut ? entryMinutes(r.checkIn, r.checkOut) : 0 }));
  },
});

/* ══════════════════════════════════════════════════════════════════════
   Certified contractor invoices
   ══════════════════════════════════════════════════════════════════════ */

const contractorArgs = {
  userId: idIn("The external member being invoiced."),
  month: monthIn,
  year: yearIn,
  onlyApproved: z
    .boolean()
    .describe("Bill only entries a manager approved. Defaults to the member's own `requireApproval` setting, so a gated member is never invoiced for unapproved hours by accident.")
    .optional(),
};

defineAction({
  name: "invoice.contractor_preview",
  title: "What a contractor's month would bill",
  description:
    "The invoice an external member's month would produce: one line per day × stream × task with its minutes, whether a human or an agent produced them, the rate and the amount, plus the totals and how many minutes are being left out because they are unapproved. Nothing is written. The member may read their own; anyone else's needs manager or above.",
  input: z.object(contractorArgs),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    selfOrManager(ctx, args.userId, "Previewing a contractor invoice");
    return buildContractorInvoice({
      orgId: ctx.orgId,
      orgName: await orgName(ctx.orgId),
      userId: args.userId,
      month: args.month,
      year: args.year,
      onlyApproved: args.onlyApproved,
    });
  },
});

defineAction({
  name: "invoice.contractor_generate",
  title: "Issue a certified contractor invoice",
  description:
    "Commit the month: freeze every billed entry into a signed snapshot, lock those entries against further edits, and hand back the invoice's verification URL and PDF. The snapshot records each entry's times and a hash of its immutable columns; the whole record is hashed and signed with the deployment's Ed25519 key, so anyone holding the document can confirm at the verification URL that PTD issued it and that the hours behind it have not moved since. Refuses a month with nothing to bill, and refuses entries an earlier invoice already claimed.",
  input: z.object(contractorArgs),
  requiredRole: "manager",
  surface: "track",
  audited: true,
  handler: async (args, ctx) => {
    // Before anything is frozen: is a certified invoice part of this plan, and can
    // the dollar it costs on Team actually be billed? Finding that out after the
    // document is signed and its entries are locked would be far too late.
    const gate = await assertCertifiedInvoices(ctx.orgId);
    const name = await orgName(ctx.orgId);
    const draft = await buildContractorInvoice({
      orgId: ctx.orgId,
      orgName: name,
      userId: args.userId,
      month: args.month,
      year: args.year,
      onlyApproved: args.onlyApproved,
    });
    if (draft.entries.length === 0) {
      const waiting = draft.excluded.pendingMinutes + draft.excluded.unsubmittedMinutes;
      throw new ActionError(
        "conflict",
        waiting > 0
          ? `Nothing to invoice for ${draft.contractor.name} in ${monthLabel(args.month, args.year)}: ${waiting} minutes are recorded but not approved.`
          : `Nothing to invoice for ${draft.contractor.name} in ${monthLabel(args.month, args.year)}.`
      );
    }
    if (draft.alreadyInvoiced.length) {
      const first = draft.alreadyInvoiced[0];
      throw new ActionError(
        "conflict",
        `${draft.alreadyInvoiced.length} of those entries are already frozen into invoice ${first.invoiceId} (entry ${first.entryId}). Void that invoice first if it needs re-issuing.`
      );
    }

    const issuedAt = new Date();
    const [row] = await db
      .insert(invoices)
      .values({
        orgId: ctx.orgId,
        customerId: null,
        userId: ctx.userId,
        memberUserId: args.userId,
        kind: "contractor",
        month: args.month,
        year: args.year,
        status: "issued",
        currency: draft.currency,
        rate: draft.rate,
        totalMinutes: draft.totals.minutes,
        amountCents: draft.totals.amountCents,
        totalAmount: draft.totals.amountCents ?? draft.totals.minutes,
        issuedAt,
      })
      .returning();

    // The reference is part of what gets signed, so it can only be built once the
    // row — and therefore its number — exists.
    const reference = contractorReference(args.year, args.month, row.id);
    const snapshot = contractorSnapshot({ ...draft, invoiceId: row.id, reference, status: "issued", issuedAt: issuedAt.toISOString() });
    const issued = await certify({
      orgId: ctx.orgId,
      invoiceId: row.id,
      reference,
      snapshot,
      entryIds: draft.entries.map((e) => e.entryId),
      currency: draft.currency,
      rate: draft.rate,
      totalMinutes: draft.totals.minutes,
      amountCents: draft.totals.amountCents,
      issuedAt,
      // So the contractor is allowlisted for their own document without anyone
      // having to share it with them.
      memberUserId: args.userId,
    });

    // One `ptd_certified_invoices` meter event on Team, keyed on the reference so a
    // retry cannot bill it twice. Business includes them; self-hosting meters nothing.
    const billing = await meterIssuedInvoice(gate, { orgId: ctx.orgId, reference: issued.reference, at: issuedAt });

    return {
      invoiceId: row.id,
      kind: "contractor",
      billing,
      reference: issued.reference,
      verifyUrl: issued.verifyUrl,
      verifyToken: issued.verifyToken,
      pdfUrl: issued.pdfUrl,
      contentHash: issued.contentHash,
      signingKeyId: issued.signingKeyId,
      // The link proves the document; its details need a code emailed to a named
      // recipient, and the contractor is already one of them.
      recipientCount: issued.recipientCount,
      status: "issued",
      contractor: draft.contractor,
      period: draft.period,
      currency: draft.currency,
      rate: draft.rate,
      totals: draft.totals,
      lineCount: draft.lines.length,
      entryCount: draft.entries.length,
      lockedEntryIds: draft.entries.map((e) => e.entryId),
      onlyApproved: draft.onlyApproved,
    };
  },
});

defineAction({
  name: "invoice.contractor_list",
  title: "Contractor invoices issued",
  description:
    "Every certified contractor invoice, newest period first, with the member it was rendered for, the amount, whether it has been voided, and its verification URL and PDF. A member sees only their own.",
  input: z.object({
    userId: idIn("Only this member's invoices.").optional(),
    limit: z.number().int().min(1).max(200).describe("Maximum rows (default 100).").optional(),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    if (args.userId !== undefined) selfOrManager(ctx, args.userId, "Reading contractor invoices");
    const filters = [eq(invoices.orgId, ctx.orgId), eq(invoices.kind, "contractor")];
    const scoped = manager(ctx) ? args.userId : ctx.userId;
    if (scoped !== undefined) filters.push(eq(invoices.memberUserId, scoped));
    const rows = await db
      .select({
        id: invoices.id,
        memberUserId: invoices.memberUserId,
        memberName: users.displayName,
        reference: invoices.reference,
        month: invoices.month,
        year: invoices.year,
        status: invoices.status,
        currency: invoices.currency,
        rate: invoices.rate,
        totalMinutes: invoices.totalMinutes,
        amountCents: invoices.amountCents,
        contentHash: invoices.contentHash,
        signingKeyId: invoices.signingKeyId,
        verifyToken: invoices.verifyToken,
        pdfUrl: invoices.pdfUrl,
        issuedAt: invoices.issuedAt,
        voidedAt: invoices.voidedAt,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .leftJoin(users, eq(invoices.memberUserId, users.id))
      .where(and(...filters))
      .orderBy(desc(invoices.year), desc(invoices.month), desc(invoices.id))
      .limit(args.limit ?? 100);
    return rows.map((r) => ({
      ...r,
      periodLabel: monthLabel(r.month, r.year),
      totalMinutes: r.totalMinutes ?? 0,
      pdfUrl: r.pdfUrl ?? `/api/track/invoices/${r.id}.pdf`,
      verifyUrl: r.verifyToken ? verifyUrlFor(r.verifyToken) : null,
      voided: r.voidedAt !== null,
    }));
  },
});

defineAction({
  name: "invoice.void",
  title: "Void an invoice",
  description:
    "Withdraw an invoice of either kind: it is stamped voided, and the entries it froze are unlocked so they can be corrected and invoiced again. The snapshot, hash and signature are deliberately left in place — a copy of the PDF is still out there, and it must go on verifying, as voided. Admin and above; the reason is recorded in the organization's audit trail.",
  input: z.object({
    invoiceId: idIn("The invoice to withdraw."),
    reason: z.string().min(1).max(500).describe("Why it is being withdrawn."),
  }),
  requiredRole: "admin",
  surface: "track",
  audited: true,
  handler: async (args, ctx) => voidInvoice(ctx, args.invoiceId, args.reason),
});

/* ══════════════════════════════════════════════════════════════════════
   Who may read an invoice — the recipient allowlist
   ══════════════════════════════════════════════════════════════════════

   The verification link proves a document is genuine to anyone who opens it and
   says nothing else: no organization, no party, no period, no money, no lines.
   The particulars are released to a **named recipient** who types back a
   six-digit code emailed to their own address. These three actions maintain that
   list.

   Two things about them are deliberate and easy to misread as omissions.

   1. **They are not marked `audited`.** The registry's audit hook records an
      action's arguments verbatim, and the arguments here are email addresses.
      Writing them into `audit_events` would put back, in the clear, exactly what
      the allowlist takes the trouble to store as a salted hash. Each handler
      audits itself instead, with the hash.
   2. **An address can never be read back.** `invoice.recipients` answers masks.
      There is no "resend to the third one down", because the address that letter
      went to was never kept — resending means typing it again, which
      `invoice.share` treats as a re-send rather than a duplicate.
*/

const emailsIn = z
  .array(z.string().trim().email("that is not an email address").max(200))
  .min(1)
  .max(20)
  .describe("The addresses to name as recipients. Each is sent the link and told a code will be emailed to that address on request.");

/**
 * Who may change an invoice's allowlist: a manager, or the contractor the invoice
 * is about. A contractor sending their own certified invoice to their own client
 * is the ordinary case, and needing a manager for it would make the feature
 * useless to the person the document is about.
 */
async function invoiceForRecipients(ctx: ActionContext, invoiceId: number, what: string) {
  const row = await invoiceForSharing(ctx.orgId, invoiceId);
  if (!row) {
    throw new ActionError("not_found", `Invoice ${invoiceId} is not in this organization, or has not been certified — there is no link to share.`);
  }
  const own = row.kind === "contractor" && row.memberUserId === ctx.userId;
  if (!manager(ctx) && !own) throw new ActionError("forbidden", `${what} requires manager or above, or being the contractor the invoice is about`);
  return row;
}

defineAction({
  name: "invoice.share",
  title: "Share a certified invoice",
  description:
    "Name the people who may read an invoice, and write to them. Each address is added to the invoice's recipient allowlist and sent the verification link with a note that a six-digit code will be emailed to that address when they ask for the details on the page. The link itself proves the document is genuine and shows nothing else, so forwarding it discloses nothing. Addresses are stored only as a salted hash and a mask — sharing the same address again re-sends the letter rather than adding it twice, and there is no way to read an address back out. Manager and above, or the contractor the invoice is about.",
  input: z.object({
    invoiceId: idIn("The certified invoice to share."),
    emails: emailsIn,
    message: z.string().max(1000).describe("A line of your own to include in the letter.").optional(),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const row = await invoiceForRecipients(ctx, args.invoiceId, "Sharing an invoice");
    const outcome = await shareInvoice({
      row,
      emails: args.emails,
      message: args.message,
      sharedBy: ctx.displayName,
      sharedByUserId: ctx.userId,
      orgName: await orgName(ctx.orgId),
    });
    audit(ctx, "invoice.shared", row.reference ?? `invoiceId:${row.id}`, {
      invoiceId: row.id,
      recipients: args.emails.map((e) => recipientHash(row.verifyToken, e)),
      added: outcome.shared.filter((s) => s.added).length,
      mailed: outcome.shared.filter((s) => s.mailed).length,
    });
    return {
      invoiceId: row.id,
      reference: row.reference,
      verifyUrl: verifyUrlFor(row.verifyToken),
      shared: outcome.shared,
      recipients: outcome.recipients,
      maxRecipients: MAX_RECIPIENTS,
      // A self-hoster with no SMTP gets the link back and sends it themselves;
      // the recipient is on the allowlist either way.
      mailed: outcome.shared.filter((s) => s.mailed).length,
    };
  },
});

defineAction({
  name: "invoice.recipients",
  title: "Who may read an invoice",
  description:
    "The invoice's recipient allowlist, masked: one row per named address with when it was added, whether PTD added it at issue (the contractor, a customer's billing address) or somebody shared it, how many access codes it has asked for and how many opened the details. Addresses are stored as a salted hash, so what comes back is `a••••a@example.com` and never the address. Manager and above, or the contractor the invoice is about.",
  input: z.object({ invoiceId: idIn("The certified invoice.") }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const row = await invoiceForRecipients(ctx, args.invoiceId, "Reading an invoice's recipients");
    return {
      invoiceId: row.id,
      reference: row.reference,
      verifyUrl: verifyUrlFor(row.verifyToken),
      recipients: recipientsOf(row),
      maxRecipients: MAX_RECIPIENTS,
    };
  },
});

defineAction({
  name: "invoice.unshare",
  title: "Withdraw access to an invoice",
  description:
    "Take an address off an invoice's allowlist. Any code already sent to it is destroyed with it, so access that a letter in an inbox could still open is actually revoked. Because addresses are stored hashed, the address has to be typed in full; answers whether it was on the list. Manager and above, or the contractor the invoice is about.",
  input: z.object({
    invoiceId: idIn("The certified invoice."),
    email: z.string().trim().email().max(200).describe("The address to remove, in full."),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) => {
    const row = await invoiceForRecipients(ctx, args.invoiceId, "Withdrawing access to an invoice");
    const outcome = await unshareInvoice({ row, email: args.email });
    audit(ctx, "invoice.unshared", row.reference ?? `invoiceId:${row.id}`, {
      invoiceId: row.id,
      recipient: recipientHash(row.verifyToken, args.email),
      removed: outcome.removed,
    });
    return { invoiceId: row.id, reference: row.reference, removed: outcome.removed, mask: outcome.mask, recipients: outcome.recipients };
  },
});

/* ══════════════════════════════════════════════════════════════════════
   The whole billing picture, for the Members tab
   ══════════════════════════════════════════════════════════════════════ */

defineAction({
  name: "billing.contractors",
  title: "Contractors and what is owed",
  description:
    "Every billable member with their rate, how many minutes of the named month are approved, pending or unsubmitted, and whether an invoice has already been issued for that month. One read for the billing overview, so the UI does not have to preview each contractor in turn.",
  input: z.object({ month: monthIn.optional(), year: yearIn.optional() }),
  requiredRole: "manager",
  surface: "org",
  handler: async (args, ctx) => {
    const now = new Date();
    const month = args.month ?? now.getMonth() + 1;
    const year = args.year ?? now.getFullYear();
    const { from, to } = monthWindow(month, year);

    const [profiles, entryRows, invoiceRows] = await Promise.all([
      billingProfiles(ctx.orgId),
      db
        .select({
          userId: timeEntries.userId,
          approvalStatus: timeEntries.approvalStatus,
          seconds: sql<string>`coalesce(sum(extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))), 0)`,
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.orgId, ctx.orgId),
            eq(timeEntries.isBreak, false),
            sql`${timeEntries.checkOut} is not null`,
            gte(timeEntries.checkIn, from),
            lte(timeEntries.checkIn, to)
          )
        )
        .groupBy(timeEntries.userId, timeEntries.approvalStatus),
      db
        .select({ id: invoices.id, memberUserId: invoices.memberUserId, reference: invoices.reference, voidedAt: invoices.voidedAt, amountCents: invoices.amountCents })
        .from(invoices)
        .where(and(eq(invoices.orgId, ctx.orgId), eq(invoices.kind, "contractor"), eq(invoices.month, month), eq(invoices.year, year))),
    ]);

    const minutesOf = (raw: unknown) => Math.max(0, Math.round(Number(raw ?? 0) / 60));
    const buckets = new Map<number, { approved: number; pending: number; rejected: number; none: number }>();
    for (const row of entryRows) {
      const cur = buckets.get(row.userId) ?? { approved: 0, pending: 0, rejected: 0, none: 0 };
      const minutes = minutesOf(row.seconds);
      if (row.approvalStatus === "approved") cur.approved += minutes;
      else if (row.approvalStatus === "pending") cur.pending += minutes;
      else if (row.approvalStatus === "rejected") cur.rejected += minutes;
      else cur.none += minutes;
      buckets.set(row.userId, cur);
    }
    const issued = new Map(invoiceRows.filter((i) => i.memberUserId !== null).map((i) => [i.memberUserId as number, i]));

    return {
      period: { month, year, label: monthLabel(month, year) },
      contractors: profiles
        .filter((p) => p.billable)
        .map((p) => {
          const b = buckets.get(p.userId) ?? { approved: 0, pending: 0, rejected: 0, none: 0 };
          const billable = p.requireApproval ? b.approved : b.approved + b.pending + b.none;
          const invoice = issued.get(p.userId) ?? null;
          return {
            userId: p.userId,
            displayName: p.displayName,
            billingName: p.billingName,
            hourlyRate: p.hourlyRate,
            currency: p.currency,
            requireApproval: p.requireApproval,
            minutes: { ...b, billable },
            amountCents: p.hourlyRate === null ? null : Math.round((billable / 60) * p.hourlyRate * 100),
            invoice: invoice ? { invoiceId: invoice.id, reference: invoice.reference, voided: invoice.voidedAt !== null } : null,
          };
        }),
    };
  },
});
