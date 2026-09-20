/**
 * Issuing and voiding a certified invoice.
 *
 * "Issue" means four things happen together, in this order, and none of them is
 * optional:
 *
 *  1. The ledger rows are **frozen** into a snapshot (`server/invoices/snapshot.ts`).
 *  2. The snapshot is canonically serialised, hashed, and the hash is **signed**
 *     with the deployment's Ed25519 key.
 *  3. A 32-byte **verify token** is minted; whoever holds the document can open
 *     `/verify/<token>` and check all of it without an account.
 *  4. Every included entry is **locked** to the invoice, so the hours behind a
 *     document that is already in someone's hands cannot be edited or struck.
 *
 * Voiding reverses step 4 and stamps `voided_at`. It deliberately leaves the
 * snapshot, the hash and the signature in place: a voided invoice must still
 * verify — as voided — because a copy of the PDF is still out there.
 */

import { randomBytes } from "crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import { invoices, timeEntries } from "../../db/schema";
import { ActionError, type ActionContext } from "../actions/registry";
import { DEFAULT_PUBLIC_URL } from "../billing/base";
import { activeSigningKey, signHash } from "./keys";
import { contentHashOf, type InvoiceSnapshot } from "./snapshot";
import type { Certification } from "./contractor";

/** Where a verifier is sent. `PTD_BASE_URL` first: it is what the dev loop sets. */
export function publicBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PTD_BASE_URL || env.PTD_PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
}

export const verifyUrlFor = (token: string, env: NodeJS.ProcessEnv = process.env): string => `${publicBase(env)}/verify/${token}`;

export const invoicePdfPath = (invoiceId: number): string => `/api/track/invoices/${invoiceId}.pdf`;

export interface Issued {
  invoiceId: number;
  reference: string;
  verifyToken: string;
  verifyUrl: string;
  pdfUrl: string;
  contentHash: string;
  signature: string;
  signingKeyId: number;
  issuedAt: Date;
  certification: Certification;
}

/**
 * Freeze, hash, sign, lock. `build` is handed the new invoice id so the
 * reference — which is part of what gets signed — can be the final one.
 */
export async function certify(args: {
  orgId: number;
  invoiceId: number;
  reference: string;
  snapshot: InvoiceSnapshot;
  entryIds: number[];
  currency: string;
  rate: number | null;
  totalMinutes: number;
  amountCents: number | null;
  issuedAt: Date;
}): Promise<Issued> {
  const key = await activeSigningKey();
  const contentHash = contentHashOf(args.snapshot);
  const signature = await signHash(contentHash, key.id);
  const verifyToken = randomBytes(32).toString("hex");
  const pdfUrl = invoicePdfPath(args.invoiceId);

  await db
    .update(invoices)
    .set({
      reference: args.reference,
      currency: args.currency,
      rate: args.rate,
      totalMinutes: args.totalMinutes,
      amountCents: args.amountCents,
      totalAmount: args.amountCents ?? args.totalMinutes,
      snapshot: args.snapshot as unknown as Record<string, unknown>,
      contentHash,
      signature,
      signingKeyId: key.id,
      verifyToken,
      issuedAt: args.issuedAt,
      pdfUrl,
      status: "issued",
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, args.invoiceId));

  // Lock only rows that are still free; `alreadyInvoiced` is refused upstream, so
  // a row taken between the check and here stays with its first invoice.
  if (args.entryIds.length) {
    await db
      .update(timeEntries)
      .set({ lockedInvoiceId: args.invoiceId, updatedAt: new Date() })
      .where(and(eq(timeEntries.orgId, args.orgId), inArray(timeEntries.id, args.entryIds), isNull(timeEntries.lockedInvoiceId)));
  }

  return {
    invoiceId: args.invoiceId,
    reference: args.reference,
    verifyToken,
    verifyUrl: verifyUrlFor(verifyToken),
    pdfUrl,
    contentHash,
    signature,
    signingKeyId: key.id,
    issuedAt: args.issuedAt,
    certification: {
      reference: args.reference,
      contentHash,
      keyId: key.id,
      algorithm: key.algorithm,
      verifyUrl: verifyUrlFor(verifyToken),
      issuedAt: args.issuedAt.toISOString(),
      voided: false,
    },
  };
}

/** The certification block of an invoice row, for re-rendering its PDF. */
export function certificationOf(row: {
  reference: string | null;
  contentHash: string | null;
  signingKeyId: number | null;
  verifyToken: string | null;
  issuedAt: Date | null;
  voidedAt: Date | null;
  createdAt: Date;
}): Certification | undefined {
  if (!row.contentHash || !row.verifyToken || !row.reference) return undefined;
  return {
    reference: row.reference,
    contentHash: row.contentHash,
    keyId: row.signingKeyId ?? 0,
    algorithm: "ed25519",
    verifyUrl: verifyUrlFor(row.verifyToken),
    issuedAt: new Date(row.issuedAt ?? row.createdAt).toISOString(),
    voided: row.voidedAt !== null,
  };
}

/* ── Voiding ─────────────────────────────────────────────────────────── */

export async function voidInvoice(ctx: ActionContext, invoiceId: number, reason: string) {
  const [row] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, ctx.orgId)))
    .limit(1);
  if (!row) throw new ActionError("not_found", `Invoice ${invoiceId} not found`);
  if (row.voidedAt) throw new ActionError("conflict", `Invoice ${row.reference ?? invoiceId} was already voided on ${new Date(row.voidedAt).toISOString()}`);

  const voidedAt = new Date();
  await db.update(invoices).set({ voidedAt, status: "void", updatedAt: voidedAt }).where(eq(invoices.id, invoiceId));
  const unlocked = await db
    .update(timeEntries)
    .set({ lockedInvoiceId: null, updatedAt: voidedAt })
    .where(and(eq(timeEntries.orgId, ctx.orgId), eq(timeEntries.lockedInvoiceId, invoiceId)))
    .returning({ id: timeEntries.id });

  // The reason has no column of its own on `invoices`, and it must not go into the
  // snapshot — that would change the content hash and break every copy of the PDF
  // already in circulation. `invoice.void` is declared `audited`, so the registry
  // records the reason in the organization's audit trail with the rest of the call.

  return {
    invoiceId,
    reference: row.reference,
    voidedAt: voidedAt.toISOString(),
    unlockedEntries: unlocked.map((u) => u.id),
    reason,
    // The document stays verifiable; it now verifies as voided.
    stillVerifiable: row.verifyToken !== null,
  };
}
