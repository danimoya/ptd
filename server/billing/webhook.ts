/**
 * Stripe webhook: signature verification and event handling, without the SDK.
 *
 * `Stripe-Signature: t=<unix>,v1=<hex>,v1=<hex>` — each v1 is an HMAC-SHA256 of
 * `${t}.${rawBody}` keyed with the endpoint secret. Verification must run against
 * the exact bytes Stripe sent (a re-serialised JSON body will not match) and must
 * compare in constant time.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { isPaidPlan, type PaidPlan } from "./plans";
import {
  applySubscriptionState,
  fetchSubscription,
  findOrgIdByStripe,
  idOf,
  requireStripe,
  subscriptionHealth,
  syncSeatQuantity,
  type AppliedState,
  type StripeCheckoutSession,
  type StripeSubscription,
} from "./service";
import type { StripeClient } from "./stripe";

/** Stripe's own replay window. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data?: { object?: Record<string, unknown> };
}

export interface ParsedSignature {
  timestamp: number;
  signatures: string[];
}

export function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp = NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") timestamp = Number(value);
    else if (key === "v1") signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export function computeSignature(timestamp: number | string, rawBody: string | Buffer, secret: string): string {
  const payload = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; error: string };

export function verifySignature(
  rawBody: string | Buffer,
  header: string | undefined,
  secret: string | undefined,
  opts: { toleranceSeconds?: number; nowMs?: number } = {},
): VerifyResult {
  if (!secret) return { ok: false, error: "STRIPE_WEBHOOK_SECRET is not configured" };
  if (!header) return { ok: false, error: "Missing Stripe-Signature header" };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, error: "Malformed Stripe-Signature header" };

  const tolerance = opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { ok: false, error: `Timestamp outside the ${tolerance}s tolerance` };
  }

  const expected = computeSignature(parsed.timestamp, rawBody, secret);
  // Several v1 entries during a secret rotation: any match is a pass.
  const matched = parsed.signatures.some((candidate) => safeEqualHex(expected, candidate));
  return matched ? { ok: true, timestamp: parsed.timestamp } : { ok: false, error: "No signature matched the endpoint secret" };
}

export type ConstructResult = { ok: true; event: StripeEvent } | { ok: false; error: string };

/** Verify, then parse. Never the other way around. */
export function constructEvent(
  rawBody: string | Buffer,
  header: string | undefined,
  secret: string | undefined,
  opts: { toleranceSeconds?: number; nowMs?: number } = {},
): ConstructResult {
  const verified = verifySignature(rawBody, header, secret, opts);
  if (!verified.ok) return verified;
  try {
    const event = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")) as StripeEvent;
    if (!event || typeof event.type !== "string" || typeof event.id !== "string") {
      return { ok: false, error: "Body is not a Stripe event" };
    }
    return { ok: true, event };
  } catch {
    return { ok: false, error: "Body is not valid JSON" };
  }
}

/* --------------------------------------------------------------- idempotency */

const PROCESSED_LIMIT = 1_000;
const processed = new Set<string>();
const processedOrder: string[] = [];

export function markProcessed(eventId: string): void {
  if (processed.has(eventId)) return;
  processed.add(eventId);
  processedOrder.push(eventId);
  while (processedOrder.length > PROCESSED_LIMIT) {
    const evicted = processedOrder.shift();
    if (evicted) processed.delete(evicted);
  }
}

export function wasProcessed(eventId: string): boolean {
  return processed.has(eventId);
}

/** Test helper — the set is per process and deliberately in memory. */
export function resetProcessedEvents(): void {
  processed.clear();
  processedOrder.length = 0;
}

/* ------------------------------------------------------------------ handling */

export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
] as const;

export interface HandleResult {
  received: true;
  eventId: string;
  type: string;
  handled: boolean;
  duplicate?: boolean;
  orgId?: number;
  plan?: string;
  interval?: string | null;
  /** Present when the event moved the Business seat quantity. */
  seats?: { quantity: number; previous: number | null; synced: boolean; note?: string };
  note?: string;
}

/**
 * The plan a Checkout Session says it bought.
 *
 * Only ever a fallback: the subscription's own price is what decides the plan
 * (`subscriptionShape`), and this metadata is written by PTD itself — so it is
 * trusted exactly as far as "Stripe is unreachable and the customer has paid".
 */
function planFromMetadata(obj: { metadata?: Record<string, string> } | undefined): PaidPlan | null {
  const raw = obj?.metadata?.plan;
  return isPaidPlan(raw) ? raw : null;
}

function orgIdFromMetadata(obj: { metadata?: Record<string, string> } | undefined): number | null {
  const raw = obj?.metadata?.orgId;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve the event's object to an org: Stripe's own ids first (they are the
 * ownership boundary we stored), metadata only as a fallback.
 */
async function resolveOrgId(ref: { customerId?: string | null; subscriptionId?: string | null; clientReferenceId?: string | null; metadataOrgId?: number | null }): Promise<number | null> {
  const byStripe = await findOrgIdByStripe({ customerId: ref.customerId, subscriptionId: ref.subscriptionId });
  if (byStripe) return byStripe;
  if (ref.clientReferenceId) {
    const n = Number(ref.clientReferenceId);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return ref.metadataOrgId ?? null;
}

/**
 * Apply one event. Returns rather than throws: the endpoint must answer 200 so
 * Stripe stops retrying a payload we have already accepted, and every branch is
 * safe to run twice.
 */
export async function handleStripeEvent(
  event: StripeEvent,
  deps: { client?: StripeClient; env?: NodeJS.ProcessEnv } = {},
): Promise<HandleResult> {
  const base: HandleResult = { received: true, eventId: event.id, type: event.type, handled: false };
  if (wasProcessed(event.id)) return { ...base, handled: true, duplicate: true, note: "already processed" };

  const env = deps.env ?? process.env;
  const object = (event.data?.object ?? {}) as Record<string, unknown>;
  const client = () => deps.client ?? requireStripe(env);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = object as unknown as StripeCheckoutSession;
        const customerId = idOf(session.customer);
        const subscriptionId = idOf(session.subscription);
        const orgId = await resolveOrgId({
          customerId,
          subscriptionId,
          clientReferenceId: session.client_reference_id ?? null,
          metadataOrgId: orgIdFromMetadata(session),
        });
        if (!orgId) return { ...base, note: "no organization matched the session" };
        if (!subscriptionId) return { ...base, orgId, note: "session carried no subscription" };

        let applied: AppliedState;
        try {
          const sub = await fetchSubscription(client(), subscriptionId);
          applied = await applySubscriptionState(orgId, { ...sub, customer: idOf(sub.customer) ?? customerId });
        } catch (err) {
          // Stripe unreachable: the session completing is itself proof enough to
          // unlock the org; the next subscription event reconciles the details.
          console.warn(`[billing] subscription read failed for ${subscriptionId}: ${err instanceof Error ? err.message : err}`);
          applied = await applySubscriptionState(
            orgId,
            { id: subscriptionId, status: "active", customer: customerId },
            { forcePlan: planFromMetadata(session) ?? "team" },
          );
        }
        markProcessed(event.id);
        return { ...base, handled: true, orgId, plan: applied.plan, interval: applied.interval };
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = object as unknown as StripeSubscription;
        if (!sub.id) return { ...base, note: "event carried no subscription id" };
        const orgId = await resolveOrgId({
          customerId: idOf(sub.customer),
          subscriptionId: sub.id,
          metadataOrgId: orgIdFromMetadata(sub),
        });
        if (!orgId) return { ...base, note: "no organization matched the subscription" };

        const deleted = event.type === "customer.subscription.deleted";
        const applied = await applySubscriptionState(orgId, sub, deleted ? { forcePlan: "free" } : { env });
        if (!deleted && subscriptionHealth(sub.status).pastDue) {
          console.warn(`[billing] org ${orgId} subscription ${sub.id} is past_due — access kept while Stripe retries`);
        }

        // An `updated` event is also how a plan change lands, so this is where the
        // seat quantity is reconciled against the roll. It is a no-op when the
        // quantity already matches — which is what keeps our own seat update from
        // bouncing back through this branch for ever.
        let seats: HandleResult["seats"];
        if (event.type === "customer.subscription.updated" && applied.plan === "business") {
          const result = await syncSeatQuantity(orgId, { env, client: deps.client });
          seats = { quantity: result.quantity, previous: result.previous, synced: result.synced, ...(result.note ? { note: result.note } : {}) };
        }

        markProcessed(event.id);
        return { ...base, handled: true, orgId, plan: applied.plan, interval: applied.interval, ...(seats ? { seats } : {}) };
      }

      case "invoice.payment_failed": {
        const invoice = object as { id?: string; customer?: string | { id?: string } | null; attempt_count?: number; next_payment_attempt?: number | null };
        const orgId = await resolveOrgId({ customerId: idOf(invoice.customer ?? null) });
        console.warn(
          `[billing] invoice ${invoice.id ?? "?"} payment failed (org ${orgId ?? "unknown"}, attempt ${invoice.attempt_count ?? "?"})` +
            `${invoice.next_payment_attempt ? `, retry ${new Date(invoice.next_payment_attempt * 1000).toISOString()}` : ", no further retry"}`,
        );
        markProcessed(event.id);
        return { ...base, handled: true, orgId: orgId ?? undefined, note: "logged" };
      }

      default:
        // Unknown types are fine: the endpoint may be subscribed to more than it needs.
        return { ...base, note: "ignored" };
    }
  } catch (err) {
    // Not marked processed, so Stripe's retry gets another chance.
    console.error(`[billing] handler failed for ${event.type} (${event.id}):`, err instanceof Error ? err.message : err);
    return { ...base, note: "handler error, will retry on Stripe's redelivery" };
  }
}
