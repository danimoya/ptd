/**
 * What the metered add-ons have cost so far this period.
 *
 * Stripe knows the authoritative total — it is the one holding the meters — but it
 * will not tell a tab quickly, and a number that takes two round-trips is a number
 * nobody puts on a page. So the same rows we metered *from* are counted again here:
 * one certified invoice per `invoices` row issued in the period, and the AI cents
 * derived from the `ai_usage` ledger with the same `cost × 1.2` arithmetic the meter
 * events used. The figures therefore agree with the invoice by construction, and
 * they are labelled "this period" rather than "billed", because Stripe rounds the
 * final line.
 */
import { and, count, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiUsage, invoices } from "../../db/schema";
import { aiMeterCents } from "./plans";

export interface AddonUsage {
  /** Start of the window the figures cover. */
  since: string;
  /** Certified invoices issued in the window — $1 each on Team. */
  certifiedInvoices: number;
  /** What PTD-provided AI would bill: Σ round(cost × 100 × 1.2) per call. */
  aiCents: number;
  /** The raw provider cost behind those cents, before the markup. */
  aiCostUsd: number;
  aiCalls: number;
}

/** The first day of the current month, for an organization with no period on file. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function addonUsage(orgId: number, opts: { since?: Date | string | null; now?: Date } = {}): Promise<AddonUsage> {
  const parsed = typeof opts.since === "string" ? new Date(opts.since) : opts.since ?? null;
  const since = parsed && !Number.isNaN(parsed.getTime()) ? parsed : monthStart(opts.now);

  const [issued, calls] = await Promise.all([
    // A voided invoice still went out and was still metered: the dollar was for
    // issuing it, and voiding it does not un-sign the document.
    db
      .select({ n: count() })
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), gte(invoices.issuedAt, since), sql`${invoices.reference} is not null`)),
    db
      .select({ costUsd: aiUsage.costUsd })
      .from(aiUsage)
      .where(and(eq(aiUsage.orgId, orgId), gte(aiUsage.createdAt, since))),
  ]);

  let aiCents = 0;
  let aiCostUsd = 0;
  for (const row of calls) {
    const cost = Number(row.costUsd ?? 0);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    aiCostUsd += cost;
    aiCents += aiMeterCents(cost);
  }

  return {
    since: since.toISOString(),
    certifiedInvoices: Number(issued[0]?.n ?? 0) || 0,
    aiCents,
    aiCostUsd: Math.round(aiCostUsd * 1_000_000) / 1_000_000,
    aiCalls: calls.length,
  };
}
