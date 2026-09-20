/**
 * Public verification of a certified invoice.
 *
 * This is the endpoint the whole scheme points at: someone holding a PDF — a
 * client, an accountant, a bank — opens the URL printed on it and gets a yes or a
 * no, with reasons, without an account on this deployment.
 *
 * Three checks run, and they fail independently so the answer can say *which*
 * assurance broke:
 *
 *  - `contentHashMatches` — the stored snapshot is re-serialised canonically and
 *    re-hashed. A mismatch means the frozen record itself was edited.
 *  - `signatureValid` — the recorded signature is checked against the recorded
 *    signing key's public half. A mismatch means the hash was rewritten by someone
 *    who does not hold the private key.
 *  - `entriesUnchanged` — every entry in the snapshot is re-read from the ledger
 *    and re-hashed. Changed rows are named. This is the check that catches an
 *    inside edit: the snapshot and signature can be perfectly valid while a
 *    manager has quietly moved an hour.
 *
 * The response is deliberately thin. A verifier needs to know the invoice is real
 * and the hours are the hours; it has no business reading the notes a contractor
 * wrote on a session, or anyone's email address. Dates and durations only.
 */

import { format } from "date-fns";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { invoices, timeEntries } from "../../db/schema";
import { signingKeyById, verifyHash } from "./keys";
import { contentHashOf, entrySha256, type InvoiceSnapshot } from "./snapshot";

export interface VerifyLine {
  date: string;
  minutes: number;
  taskKey: string | null;
  taskTitle: string | null;
  streamName: string | null;
  entrySource: string;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  reasons?: string[];
  invoice?: {
    reference: string;
    kind: string;
    org: string;
    contractorOrCustomer: string;
    period: { month: number; year: number; label: string };
    currency: string;
    rate: number | null;
    totals: { minutes: number; hours: number; amountCents: number | null };
    issuedAt: string;
    voided: boolean;
    voidedAt: string | null;
  };
  integrity?: {
    contentHashMatches: boolean;
    signatureValid: boolean;
    keyId: number | null;
    algorithm: string | null;
    publicKeyUrl: string;
    contentHash: string;
    entriesUnchanged: boolean;
    changedEntryIds: number[];
    missingEntryIds: number[];
    entriesChecked: number;
  };
  lines?: VerifyLine[];
}

const NOT_FOUND: VerifyResult = {
  valid: false,
  reason: "No invoice carries that verification token. Check the link on the document — the token is 64 hexadecimal characters.",
};

export const looksLikeToken = (token: string): boolean => /^[0-9a-f]{64}$/i.test(token);

/**
 * Verify by token. Reads the invoice, re-derives everything, and answers whether
 * the document in someone's hands is what this deployment issued.
 */
export async function verifyByToken(token: string): Promise<VerifyResult> {
  if (!looksLikeToken(token)) return NOT_FOUND;

  const [row] = await db.select().from(invoices).where(eq(invoices.verifyToken, token)).limit(1);
  if (!row || !row.snapshot || !row.contentHash) return NOT_FOUND;

  const snapshot = row.snapshot as unknown as InvoiceSnapshot;
  const reasons: string[] = [];

  const recomputed = contentHashOf(snapshot);
  const contentHashMatches = recomputed === row.contentHash;
  if (!contentHashMatches) reasons.push("The frozen record no longer hashes to the value recorded with it, so the record has been altered.");

  const key = row.signingKeyId === null ? null : await signingKeyById(row.signingKeyId);
  const signatureValid = Boolean(key && row.signature) && verifyHash(row.contentHash, row.signature as string, (key as { publicKey: string }).publicKey);
  if (!signatureValid) reasons.push("The signature does not verify against the signing key this invoice names.");

  /* Re-hash the live rows. */
  const snapshotIds = snapshot.lines.map((l) => l.entryId);
  const live = snapshotIds.length
    ? await db
        .select({
          id: timeEntries.id,
          userId: timeEntries.userId,
          checkIn: timeEntries.checkIn,
          checkOut: timeEntries.checkOut,
          isBreak: timeEntries.isBreak,
          taskId: timeEntries.taskId,
          streamId: timeEntries.streamId,
          customerId: timeEntries.customerId,
          entrySource: timeEntries.entrySource,
          tokensUsed: timeEntries.tokensUsed,
          apiCostUsd: timeEntries.apiCostUsd,
        })
        .from(timeEntries)
        .where(and(eq(timeEntries.orgId, row.orgId), inArray(timeEntries.id, snapshotIds)))
    : [];
  const byId = new Map(live.map((e) => [e.id, e]));
  const changedEntryIds: number[] = [];
  const missingEntryIds: number[] = [];
  for (const line of snapshot.lines) {
    const entry = byId.get(line.entryId);
    if (!entry) {
      missingEntryIds.push(line.entryId);
      continue;
    }
    if (entrySha256(entry) !== line.entrySha256) changedEntryIds.push(line.entryId);
  }
  const entriesUnchanged = changedEntryIds.length === 0 && missingEntryIds.length === 0;
  if (changedEntryIds.length) {
    reasons.push(
      `${changedEntryIds.length} time ${changedEntryIds.length === 1 ? "entry has" : "entries have"} been altered since this invoice was issued.`
    );
  }
  if (missingEntryIds.length) {
    reasons.push(`${missingEntryIds.length} time ${missingEntryIds.length === 1 ? "entry has" : "entries have"} been deleted since this invoice was issued.`);
  }
  if (row.voidedAt) reasons.push("This invoice has been voided by the organization that issued it.");

  const who = snapshot.kind === "contractor" ? snapshot.contractor?.billingName ?? snapshot.contractor?.name ?? "" : snapshot.customer?.name ?? "";

  return {
    valid: contentHashMatches && signatureValid && entriesUnchanged && !row.voidedAt,
    ...(reasons.length ? { reason: reasons[0], reasons } : {}),
    invoice: {
      reference: snapshot.reference,
      kind: snapshot.kind,
      org: snapshot.org.name,
      contractorOrCustomer: who,
      period: { month: snapshot.period.month, year: snapshot.period.year, label: snapshot.period.label },
      currency: snapshot.currency,
      rate: snapshot.rate,
      totals: {
        minutes: snapshot.totals.minutes,
        hours: Math.round((snapshot.totals.minutes / 60) * 100) / 100,
        amountCents: snapshot.totals.amountCents,
      },
      issuedAt: snapshot.issuedAt,
      voided: row.voidedAt !== null,
      voidedAt: row.voidedAt ? new Date(row.voidedAt).toISOString() : null,
    },
    integrity: {
      contentHashMatches,
      signatureValid,
      keyId: row.signingKeyId,
      algorithm: key?.algorithm ?? null,
      publicKeyUrl: "/.well-known/ptd-signing-key.json",
      contentHash: row.contentHash,
      entriesUnchanged,
      changedEntryIds,
      missingEntryIds,
      entriesChecked: snapshot.lines.length,
    },
    // A date, a duration, what it was booked against, and who did it. No notes.
    lines: snapshot.lines.map((l) => ({
      date: format(new Date(l.checkIn), "yyyy-MM-dd"),
      minutes: l.minutes,
      taskKey: l.taskKey,
      taskTitle: l.taskTitle,
      streamName: l.streamName,
      entrySource: l.entrySource,
    })),
  };
}
