/**
 * The customer invoice's frozen record.
 *
 * The customer document had no certification before Phase 4 — it stated hours and
 * was re-rendered from the ledger on every request, which is fine for a document
 * nobody has to trust and wrong for one an accounts-payable department will file.
 * So it now freezes the same way a contractor invoice does, with one difference:
 * a customer's hours can be priced at more than one rate, because a stream may
 * override the customer's. Each snapshot line therefore carries the rate that
 * applied to it, and the total is the sum of the priced lines.
 */

import { SNAPSHOT_VERSION, type InvoiceSnapshot } from "./snapshot";
import type { InvoiceData } from "../track/invoice";

export function customerSnapshot(data: InvoiceData): InvoiceSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    kind: "customer",
    org: { id: 0, name: data.orgName },
    customer: {
      id: data.customer.id,
      name: data.customer.name,
      billingAddress: data.customer.billingAddress,
      billingEmail: data.customer.billingEmail,
    },
    period: data.period,
    currency: data.currency ?? data.customer.currency ?? "USD",
    rate: data.customer.hourlyRate ?? null,
    lines: data.entries ?? [],
    totals: {
      minutes: data.totals.minutes,
      amountCents: data.totals.amountCents,
      humanMinutes: data.totals.humanMinutes,
      agentMinutes: data.totals.agentMinutes,
      tokens: data.totals.tokens,
      costUsd: data.totals.costUsd,
    },
    issuedAt: data.issuedAt,
    reference: data.reference,
  };
}
