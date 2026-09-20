/**
 * The two metered add-ons.
 *
 *   ptd_certified_invoices   one event per certified invoice, value 1, on Team.
 *                            Business includes them; Free cannot issue one.
 *   ptd_ai_usage_cents       one event per provider call, value = cost × 1.2 in
 *                            whole cents, when the organization is using PTD's key
 *                            rather than its own.
 *
 * Three rules:
 *
 *  1. **Metering never fails the work.** An invoice is signed and its entries are
 *     locked before we tell Stripe about it; a suggestion has already been given.
 *     Losing the event costs a dollar, losing the invoice costs the month — so a
 *     failure here is a warning and a `note` in the result, never a throw.
 *  2. **Every event carries an identifier.** Stripe de-duplicates on it for at
 *     least 24 hours, so a retry — ours or Stripe's — cannot double-charge. The
 *     invoice's own reference is the identifier for an invoice; a digest of the
 *     call record is the identifier for an AI call.
 *  3. **Self-hosting meters nothing.** Not "meters zero": makes no call.
 */
import { createHash } from "crypto";
import { CERT_INVOICE_USD, certMeterName, aiMeterCents, aiMeterName } from "./plans";
import { isHosted, postMeterEvent, requireStripe } from "./service";
import type { StripeClient } from "./stripe";

export interface MeterOutcome {
  metered: boolean;
  identifier?: string;
  /** Present when nothing was sent, saying why. */
  note?: string;
  /** What the meter was told, in the meter's own unit. */
  value?: number;
}

/** `PTD-CTR-2026-09-0007` → `ptd-cert-PTD-CTR-2026-09-0007`. */
export function certInvoiceIdentifier(reference: string): string {
  return `ptd-cert-${reference}`.slice(0, 100);
}

export interface AiCallKey {
  orgId: number;
  at: string;
  label: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * A stable name for one provider call.
 *
 * `server/ai/usage.ts` writes the `ai_usage` row in the background and does not
 * hand back its id, so the identifier is a digest of the call record instead: the
 * same call always produces the same identifier (a retried POST is de-duplicated),
 * and two different calls practically never collide.
 */
export function aiUsageIdentifier(call: AiCallKey): string {
  const digest = createHash("sha256")
    .update([call.orgId, call.at, call.label, call.provider, call.model, call.inputTokens, call.outputTokens, call.costUsd.toFixed(8)].join("|"))
    .digest("hex")
    .slice(0, 24);
  return `ptd-ai-${call.orgId}-${digest}`;
}

/** One certified invoice, $1, on Team. */
export async function meterCertifiedInvoice(
  input: { orgId: number; customerId: string; reference: string; at?: Date },
  opts: { client?: StripeClient; env?: NodeJS.ProcessEnv } = {},
): Promise<MeterOutcome> {
  const env = opts.env ?? process.env;
  if (!isHosted(env)) return { metered: false, note: "self-hosted" };
  const identifier = certInvoiceIdentifier(input.reference);
  try {
    const client = opts.client ?? requireStripe(env);
    await postMeterEvent(client, {
      eventName: certMeterName(env),
      customerId: input.customerId,
      value: 1,
      identifier,
      at: input.at,
    });
    return { metered: true, identifier, value: 1 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Loud, and recoverable: Stripe accepts a meter event up to 35 days late.
    console.warn(`[billing] certified-invoice meter event failed for org ${input.orgId} (${identifier}): ${message}`);
    return { metered: false, identifier, note: `meter event failed: ${message}` };
  }
}

/** One AI call, cost × 1.2 in cents, when PTD's key paid for it. */
export async function meterAiUsage(
  input: { orgId: number; customerId: string; costUsd: number; identifier: string; at?: Date },
  opts: { client?: StripeClient; env?: NodeJS.ProcessEnv } = {},
): Promise<MeterOutcome> {
  const env = opts.env ?? process.env;
  if (!isHosted(env)) return { metered: false, note: "self-hosted" };
  const cents = aiMeterCents(input.costUsd);
  // A call the price table could not price, or one that cost a fraction of a
  // hundredth of a cent, is not worth an event — and a zero-value event would
  // still consume the identifier.
  if (cents <= 0) return { metered: false, note: "nothing to bill", value: 0 };
  try {
    const client = opts.client ?? requireStripe(env);
    await postMeterEvent(client, {
      eventName: aiMeterName(env),
      customerId: input.customerId,
      value: cents,
      identifier: input.identifier,
      at: input.at,
    });
    return { metered: true, identifier: input.identifier, value: cents };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[billing] ai meter event failed for org ${input.orgId} (${input.identifier}): ${message}`);
    return { metered: false, identifier: input.identifier, note: `meter event failed: ${message}`, value: cents };
  }
}

/* ------------------------------------------------- what an action reports back */

export interface InvoiceBillingNote {
  /** The plan that allowed it — null when self-hosted. */
  plan: string | null;
  /** Whether this invoice consumed a $1 add-on. */
  metered: boolean;
  /** $1 on Team, 0 when the plan includes certified invoices. */
  usd: number;
  identifier?: string;
  note?: string;
}

/**
 * Meter one issued invoice, if the plan says it costs a dollar, and describe the
 * outcome for the action's result. Both `invoice.generate` and
 * `invoice.contractor_generate` end with this, so the two documents are billed the
 * same way — and both say so in their answer rather than silently.
 */
export async function meterIssuedInvoice(
  gate: { plan: string | null; metered: boolean; customerId: string | null },
  input: { orgId: number; reference: string; at?: Date },
  opts: { client?: StripeClient; env?: NodeJS.ProcessEnv } = {},
): Promise<InvoiceBillingNote> {
  if (!gate.metered || !gate.customerId) {
    return { plan: gate.plan, metered: false, usd: 0, ...(gate.plan === "business" ? { note: "included in Business" } : {}) };
  }
  const outcome = await meterCertifiedInvoice({ orgId: input.orgId, customerId: gate.customerId, reference: input.reference, at: input.at }, opts);
  return {
    plan: gate.plan,
    metered: outcome.metered,
    usd: outcome.metered ? CERT_INVOICE_USD : 0,
    ...(outcome.identifier ? { identifier: outcome.identifier } : {}),
    ...(outcome.note ? { note: outcome.note } : {}),
  };
}
