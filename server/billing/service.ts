/**
 * Billing service: the org ⇄ Stripe mapping.
 *
 * The plan model lives in ./plans.ts (pure), the subscription's item ids in
 * ./state.ts (`org_integrations` kind `billing`). This file is where those two
 * meet the database and Stripe:
 *
 *   - read an organization's billing columns and its seat counts,
 *   - derive the plan from the subscription's **base price**, never from what a
 *     client asked for,
 *   - build the exact Checkout / subscription-update / meter-event bodies,
 *   - keep the seat quantity on Business equal to `humans − 50`.
 *
 * Every function here is hosted-only; callers gate on `isHosted()` first.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { memberships, organizations, users } from "../../db/schema";
import { billingReturnUrl, currentBaseUrl } from "./base";
import {
  FREE_MEMBER_LIMIT,
  PLAN_PRICES,
  aiUsagePriceId,
  certInvoicePriceId,
  isPaidPlan,
  isPlan,
  normalisePlan,
  planPriceId,
  priceRole,
  seatOverage,
  seatPriceId,
  type Interval,
  type PaidPlan,
  type Plan,
} from "./plans";
import { readBillingState, writeBillingState, clearBillingState, type BillingItems } from "./state";
import { INTEGRATION_IDENTIFIER, StripeClient, StripeError, StripeNotConfiguredError, stripeFromEnv, type FetchLike } from "./stripe";

export { FREE_MEMBER_LIMIT, isPlan, normalisePlan, type Plan };
/** Kept for older callers and copy: Team monthly is still the entry price. */
export const PRICE_USD = PLAN_PRICES.team.month;
export const BILLING_INTERVAL: Interval = "month";

export function isHosted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PTD_HOSTED === "1";
}

/** A client or an explanatory throw — never a half-configured no-op. */
export function requireStripe(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): StripeClient {
  if (!env.STRIPE_SECRET_KEY) throw new StripeNotConfiguredError();
  return stripeFromEnv(env, fetchImpl);
}

/** The price id for a plan, or an error naming the variable that is missing. */
export function requirePlanPriceId(plan: PaidPlan, interval: Interval, env: NodeJS.ProcessEnv = process.env): string {
  const id = planPriceId(plan, interval, env);
  if (!id) {
    throw new StripeNotConfiguredError(
      `No Stripe price configured for ${plan} / ${interval} — set STRIPE_PRICE_${plan.toUpperCase()}_${interval === "month" ? "MONTHLY" : "YEARLY"}`,
    );
  }
  return id;
}

/* ----------------------------------------------------------------- org state */

export interface OrgBilling {
  id: number;
  name: string;
  plan: Plan;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

export async function getOrgBilling(orgId: number): Promise<OrgBilling | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      plan: organizations.plan,
      stripeCustomerId: organizations.stripeCustomerId,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) return null;
  // `normalisePlan` also reads pricing v1's `hosted` as Team — see plans.ts.
  return { ...row, plan: normalisePlan(row.plan) };
}

/** Find the org a Stripe object belongs to: our own columns first, then metadata. */
export async function findOrgIdByStripe(ref: { customerId?: string | null; subscriptionId?: string | null }): Promise<number | null> {
  if (ref.subscriptionId) {
    const [row] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.stripeSubscriptionId, ref.subscriptionId)).limit(1);
    if (row) return row.id;
  }
  if (ref.customerId) {
    const [row] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.stripeCustomerId, ref.customerId)).limit(1);
    if (row) return row.id;
  }
  return null;
}

export interface SeatUsage {
  /** Humans + agents. What the hard member cap counts. */
  members: number;
  /** Members whose user is not an agent. What the seat limits and the seat price count. */
  humans: number;
  agents: number;
}

/**
 * Who is in the organization.
 *
 * A human seat is a chair someone sits in; an agent seat is a token. On Team and
 * Business the agents are free — they pay their own API bill — so the two are
 * counted separately here and the plan decides which number matters.
 */
export async function orgSeatUsage(orgId: number): Promise<SeatUsage> {
  const rows = await db
    .select({ isAgent: users.isAgent })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.orgId, orgId));
  const agents = rows.filter((r) => r.isAgent === true).length;
  return { members: rows.length, humans: rows.length - agents, agents };
}

/** The human owner's address, so the Stripe customer and the receipts match a person. */
export async function ownerEmail(orgId: number, fallback: string): Promise<string> {
  const rows = await db
    .select({ email: users.email, isAgent: users.isAgent })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "owner")))
    .orderBy(memberships.createdAt);
  return rows.find((r) => !r.isAgent)?.email ?? rows[0]?.email ?? fallback;
}

/* ------------------------------------------------------------ stripe objects */

export interface StripePrice {
  id?: string;
  lookup_key?: string | null;
  recurring?: { interval?: string } | null;
}

export interface StripeSubscriptionItem {
  id?: string;
  quantity?: number | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  price?: StripePrice | null;
}

export interface StripeSubscription {
  id: string;
  status?: string;
  customer?: string | { id?: string } | null;
  cancel_at_period_end?: boolean;
  current_period_start?: number | null;
  current_period_end?: number | null;
  canceled_at?: number | null;
  items?: { data?: StripeSubscriptionItem[] };
  metadata?: Record<string, string>;
}

export interface StripeCheckoutSession {
  id: string;
  url?: string | null;
  status?: string;
  payment_status?: string;
  client_reference_id?: string | null;
  customer?: string | { id?: string } | null;
  subscription?: string | { id?: string } | null;
  metadata?: Record<string, string>;
}

export function idOf(value: string | { id?: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id ?? null;
}

function isoOf(epoch: number | null | undefined): string | null {
  return typeof epoch === "number" && epoch > 0 ? new Date(epoch * 1000).toISOString() : null;
}

/**
 * Period bounds live on the subscription item from 2025-03-31.basil onward and on
 * the subscription itself before that; read whichever the account answers with.
 */
export function subscriptionPeriodEnd(sub: StripeSubscription): string | null {
  return isoOf(sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end ?? null);
}

export function subscriptionPeriodStart(sub: StripeSubscription): string | null {
  return isoOf(sub.items?.data?.[0]?.current_period_start ?? sub.current_period_start ?? null);
}

/**
 * What a Stripe status means for access. It deliberately does *not* say which plan
 * the organization is on — the price says that.
 *
 *   healthy  the subscription is paid for (or being dunned, which keeps access)
 *   dead     it is over: drop to `free`
 *   null     mid-flight (`incomplete`, `paused`): leave the plan alone rather than
 *            guess, and wait for the next event
 */
export function subscriptionHealth(status: string | undefined | null): { healthy: boolean | null; pastDue: boolean } {
  switch (status) {
    case "active":
    case "trialing":
      return { healthy: true, pastDue: false };
    case "past_due":
      // Stripe is still dunning: keep the org working, flag it in the UI.
      return { healthy: true, pastDue: true };
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      return { healthy: false, pastDue: false };
    default:
      return { healthy: null, pastDue: false };
  }
}

export interface SubscriptionShape {
  /** The plan the base price sells, or null when no item on the subscription is one. */
  plan: PaidPlan | null;
  interval: Interval | null;
  items: BillingItems;
  /** The seat item's quantity as Stripe has it. */
  seatQuantity: number | null;
}

/**
 * Read the subscription's items back into PTD's own vocabulary. The base item's
 * price — by lookup key, else by configured id — is the single source of truth for
 * which plan an organization is on.
 */
export function subscriptionShape(sub: StripeSubscription, env: NodeJS.ProcessEnv = process.env): SubscriptionShape {
  const shape: SubscriptionShape = { plan: null, interval: null, items: {}, seatQuantity: null };
  for (const item of sub.items?.data ?? []) {
    const role = priceRole(item.price ?? null, env);
    if (!role || !item.id) continue;
    if (role.kind === "base") {
      shape.plan = role.plan;
      shape.interval = role.interval;
      shape.items.base = item.id;
    } else if (role.kind === "seat") {
      shape.items.seat = item.id;
      shape.seatQuantity = typeof item.quantity === "number" ? item.quantity : null;
      if (!shape.interval) shape.interval = role.interval;
    } else if (role.kind === "cert") {
      shape.items.cert = item.id;
    } else {
      shape.items.ai = item.id;
    }
  }
  // Last resort for an unexpanded price: the recurring interval Stripe reports.
  if (!shape.interval) {
    const raw = sub.items?.data?.[0]?.price?.recurring?.interval;
    if (raw === "month" || raw === "year") shape.interval = raw;
  }
  return shape;
}

/* ------------------------------------------------------------------ mutation */

export interface AppliedState {
  orgId: number;
  plan: Plan;
  interval: Interval | null;
  status: string | null;
  pastDue: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  items: BillingItems;
  seatQuantity: number | null;
  changed: boolean;
}

/**
 * Write what Stripe says onto the org row and the billing config.
 *
 * Safe to re-run: it computes the whole desired state and only UPDATEs when a
 * column actually differs, so a replayed webhook is observably a no-op. The plan
 * comes from the base price; the status only decides whether that plan applies at
 * all or the organization falls back to `free`.
 */
export async function applySubscriptionState(
  orgId: number,
  sub: StripeSubscription,
  opts: { forcePlan?: Plan; env?: NodeJS.ProcessEnv } = {},
): Promise<AppliedState> {
  const env = opts.env ?? process.env;
  const current = await getOrgBilling(orgId);
  const health = subscriptionHealth(sub.status);
  const shape = subscriptionShape(sub, env);

  let plan: Plan;
  if (opts.forcePlan) plan = opts.forcePlan;
  else if (health.healthy === false) plan = "free";
  else if (health.healthy === true) plan = shape.plan ?? (current?.plan === "free" ? "team" : current?.plan ?? "team");
  else plan = current?.plan ?? "free";

  const customerId = idOf(sub.customer) ?? current?.stripeCustomerId ?? null;
  // A cancelled subscription stops being the org's live subscription.
  const subscriptionId = plan === "free" ? null : sub.id;

  const next = { plan, stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId };
  const changed =
    !current ||
    current.plan !== next.plan ||
    (current.stripeCustomerId ?? null) !== next.stripeCustomerId ||
    (current.stripeSubscriptionId ?? null) !== next.stripeSubscriptionId;

  if (changed) await db.update(organizations).set(next).where(eq(organizations.id, orgId));

  const applied: AppliedState = {
    orgId,
    plan,
    interval: shape.interval,
    status: sub.status ?? null,
    pastDue: health.pastDue,
    currentPeriodStart: subscriptionPeriodStart(sub),
    currentPeriodEnd: subscriptionPeriodEnd(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    items: shape.items,
    seatQuantity: shape.seatQuantity,
    changed,
  };

  if (plan === "free") {
    // Nothing left to remember: the items are gone with the subscription.
    await clearBillingState(orgId);
  } else {
    await writeBillingState(orgId, {
      interval: shape.interval,
      items: shape.items,
      currentPeriodStart: applied.currentPeriodStart,
      currentPeriodEnd: applied.currentPeriodEnd,
      status: applied.status,
      cancelAtPeriodEnd: applied.cancelAtPeriodEnd,
      seatQuantity: shape.seatQuantity,
    });
  }

  return applied;
}

/* -------------------------------------------------------------------- Stripe */

export function fetchSubscription(client: StripeClient, subscriptionId: string): Promise<StripeSubscription> {
  return client.get<StripeSubscription>(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export function fetchCheckoutSession(client: StripeClient, sessionId: string): Promise<StripeCheckoutSession> {
  return client.get<StripeCheckoutSession>(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * The org's Stripe customer, created on first use. A stored id that Stripe no
 * longer has (deleted in the dashboard) is replaced rather than inherited.
 */
export async function ensureCustomer(client: StripeClient, org: OrgBilling, opts: { email: string }): Promise<string> {
  if (org.stripeCustomerId) {
    try {
      const existing = await client.get<{ id: string; deleted?: boolean }>(`/v1/customers/${encodeURIComponent(org.stripeCustomerId)}`);
      if (existing.id && !existing.deleted) return existing.id;
    } catch (err) {
      if (!(err instanceof StripeError) || err.status !== 404) throw err;
    }
  }

  const created = await client.post<{ id: string }>(
    "/v1/customers",
    {
      email: opts.email,
      name: org.name,
      metadata: { orgId: String(org.id), product: "ptd" },
    },
    { idempotencyKey: `ptd-customer-org-${org.id}` },
  );
  await db.update(organizations).set({ stripeCustomerId: created.id }).where(eq(organizations.id, org.id));
  return created.id;
}

/**
 * `STRIPE_TAX_ENABLED=1` turns Stripe Tax on for Checkout. It is a switch rather
 * than the default because Stripe Tax does nothing at all until the account has
 * live tax registrations — and a flow that *looks* like it handles VAT while
 * collecting none is worse than one that plainly does not.
 *
 * Switched on, four settings have to move together, which is why they live here
 * and not in four places:
 *   automatic_tax          Stripe computes the tax for each registration,
 *   billing_address_collection=required   because the rate depends on where the
 *                          customer is, and Stripe cannot guess,
 *   tax_id_collection      so a business can enter a VAT/GST number and be
 *                          reverse-charged instead of taxed,
 *   customer_update[address]=auto   so the address the customer types is saved
 *                          back onto the Customer — without it Stripe refuses the
 *                          session, since it may not write what it just collected.
 */
export function taxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STRIPE_TAX_ENABLED === "1";
}

export interface CheckoutInput {
  orgId: number;
  customerId: string;
  plan: PaidPlan;
  interval: Interval;
  /** Billable human seats beyond what Business includes. */
  seatQuantity?: number;
  base?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The line items one Checkout Session carries:
 *
 *   the plan's flat price, quantity 1 — it is per organization, not per seat;
 *   on Business, the seat price with the overage as its quantity, and only when
 *     there is an overage: Stripe will not take a quantity of zero;
 *   both metered prices, with **no** quantity — usage arrives as meter events,
 *     and a quantity on a metered price is an error.
 */
export function checkoutLineItems(input: CheckoutInput): Record<string, unknown>[] {
  const env = input.env ?? process.env;
  const items: Record<string, unknown>[] = [{ price: requirePlanPriceId(input.plan, input.interval, env), quantity: 1 }];

  const seats = input.plan === "business" ? Math.max(0, Math.floor(input.seatQuantity ?? 0)) : 0;
  if (seats > 0) {
    const seatPrice = seatPriceId(input.interval, env);
    if (seatPrice) items.push({ price: seatPrice, quantity: seats });
  }

  const cert = certInvoicePriceId(env);
  if (cert) items.push({ price: cert });
  const ai = aiUsagePriceId(env);
  if (ai) items.push({ price: ai });

  return items;
}

/** The exact Checkout Session request body. Pure, so a test can assert it. */
export function checkoutParams(input: CheckoutInput): Record<string, unknown> {
  const env = input.env ?? process.env;
  const base = input.base ?? currentBaseUrl(env);
  const tax = taxEnabled(env);
  return {
    mode: "subscription",
    customer: input.customerId,
    client_reference_id: String(input.orgId),
    // No payment_method_types: dynamic payment methods, configured in the Dashboard.
    line_items: checkoutLineItems(input),
    success_url: billingReturnUrl({ checkout: "success", plan: input.plan, session_id: "{CHECKOUT_SESSION_ID}" }, env, base),
    cancel_url: billingReturnUrl({ checkout: "cancelled" }, env, base),
    // The founding-member code (FOUNDING) is a promotion code on the coupon, so
    // Checkout's own field is what redeems it — PTD never applies the discount.
    allow_promotion_codes: true,
    automatic_tax: { enabled: tax },
    ...(tax
      ? {
          billing_address_collection: "required",
          tax_id_collection: { enabled: true },
          customer_update: { address: "auto" },
        }
      : {}),
    subscription_data: { metadata: { orgId: String(input.orgId), product: "ptd-hosted", plan: input.plan, interval: input.interval } },
    metadata: { orgId: String(input.orgId), plan: input.plan, interval: input.interval },
    integration_identifier: INTEGRATION_IDENTIFIER,
  };
}

export async function createCheckoutSession(client: StripeClient, input: CheckoutInput): Promise<{ id: string; url: string }> {
  const session = await client.post<{ id: string; url?: string | null }>("/v1/checkout/sessions", checkoutParams(input));
  if (!session.url) throw new StripeError("Stripe returned a Checkout Session without a URL", 502);
  return { id: session.id, url: session.url };
}

export async function createPortalSession(
  client: StripeClient,
  input: { customerId: string; base?: string; env?: NodeJS.ProcessEnv },
): Promise<{ id: string; url: string }> {
  const env = input.env ?? process.env;
  const session = await client.post<{ id: string; url?: string | null }>("/v1/billing_portal/sessions", {
    customer: input.customerId,
    return_url: billingReturnUrl({ portal: "return" }, env, input.base ?? currentBaseUrl(env)),
  });
  if (!session.url) throw new StripeError("Stripe returned a portal session without a URL", 502);
  return { id: session.id, url: session.url };
}

/* ------------------------------------------------------------- plan changes */

export interface ChangePlanInput {
  plan: PaidPlan;
  interval: Interval;
  /** The items already on the subscription, from the stored billing state. */
  items: BillingItems;
  seatQuantity?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * The body that moves an existing subscription to another plan or interval.
 *
 * The base item is *replaced in place* (`items[0][id]` + a new price) rather than
 * deleted and re-added, so the subscription keeps its identity, its discounts and
 * its billing anchor. `create_prorations` writes the credit and the charge as
 * proration line items on the next invoice rather than taking money now: an
 * upgrade should not surprise a card, and Stripe bills the difference at renewal.
 */
export function changePlanParams(input: ChangePlanInput): Record<string, unknown> {
  const env = input.env ?? process.env;
  const items: Record<string, unknown>[] = [];

  const basePrice = requirePlanPriceId(input.plan, input.interval, env);
  items.push(input.items.base ? { id: input.items.base, price: basePrice, quantity: 1 } : { price: basePrice, quantity: 1 });

  // Seats only exist on Business. Moving down to Team removes the item outright,
  // which is the only way to stop it billing.
  const seats = input.plan === "business" ? Math.max(0, Math.floor(input.seatQuantity ?? 0)) : 0;
  const seatPrice = seatPriceId(input.interval, env);
  if (input.items.seat) {
    if (input.plan === "business") items.push({ id: input.items.seat, price: seatPrice ?? undefined, quantity: seats });
    else items.push({ id: input.items.seat, deleted: true });
  } else if (seats > 0 && seatPrice) {
    items.push({ price: seatPrice, quantity: seats });
  }

  // The meters follow the interval too, and are added if checkout never carried them.
  const cert = certInvoicePriceId(env);
  if (cert) items.push(input.items.cert ? { id: input.items.cert, price: cert } : { price: cert });
  const ai = aiUsagePriceId(env);
  if (ai) items.push(input.items.ai ? { id: input.items.ai, price: ai } : { price: ai });

  return { items, proration_behavior: "create_prorations" };
}

export async function changeSubscriptionPlan(
  client: StripeClient,
  subscriptionId: string,
  input: ChangePlanInput & { orgId: number },
): Promise<StripeSubscription> {
  const params = changePlanParams(input);
  params.metadata = { orgId: String(input.orgId), plan: input.plan, interval: input.interval, product: "ptd-hosted" };
  return client.post<StripeSubscription>(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, params, {
    idempotencyKey: `ptd-plan-${input.orgId}-${input.plan}-${input.interval}-${input.seatQuantity ?? 0}`,
  });
}

/* ------------------------------------------------------------------- seats */

export interface SeatSyncResult {
  synced: boolean;
  plan: Plan | null;
  humans: number;
  quantity: number;
  previous: number | null;
  note?: string;
}

/**
 * Keep the seat line item equal to `humans − 50` on Business.
 *
 * Called from every path that adds or removes a seat, and from the subscription
 * webhook. Three properties make that safe:
 *
 *  - **It never throws.** An invitation must not fail because Stripe is down; the
 *    result says what happened and the next call reconciles.
 *  - **It is a no-op when nothing moved**, so our own update — which comes back as
 *    `customer.subscription.updated` — does not bounce into a second update.
 *  - **Only Business bills seats.** On Free and Team it returns immediately: Team's
 *    ten humans are a limit, not a meter.
 */
export async function syncSeatQuantity(
  orgId: number,
  opts: { env?: NodeJS.ProcessEnv; client?: StripeClient } = {},
): Promise<SeatSyncResult> {
  const env = opts.env ?? process.env;
  const idle = (note: string, extra: Partial<SeatSyncResult> = {}): SeatSyncResult => ({
    synced: false,
    plan: null,
    humans: 0,
    quantity: 0,
    previous: null,
    note,
    ...extra,
  });
  if (!isHosted(env)) return idle("self-hosted");

  try {
    const org = await getOrgBilling(orgId);
    if (!org) return idle("no such organization");
    if (org.plan !== "business") return idle("seats are only billed on business", { plan: org.plan });
    if (!org.stripeSubscriptionId) return idle("no subscription on file", { plan: org.plan });

    const usage = await orgSeatUsage(orgId);
    const quantity = seatOverage(org.plan, usage.humans);
    const state = await readBillingState(orgId);
    const previous = state.seatQuantity;
    const interval: Interval = state.interval ?? "month";

    if (previous === quantity && (quantity === 0 || state.items.seat)) {
      return { synced: false, plan: org.plan, humans: usage.humans, quantity, previous, note: "unchanged" };
    }
    if (!state.items.seat && quantity === 0) {
      // Nothing to bill and nothing to update; just remember where we are.
      await writeBillingState(orgId, { seatQuantity: 0 });
      return { synced: false, plan: org.plan, humans: usage.humans, quantity, previous, note: "no overage" };
    }

    const seatPrice = seatPriceId(interval, env);
    if (!state.items.seat && !seatPrice) {
      return { synced: false, plan: org.plan, humans: usage.humans, quantity, previous, note: `no seat price configured for ${interval}` };
    }

    const client = opts.client ?? requireStripe(env);
    const item = state.items.seat ? { id: state.items.seat, quantity } : { price: seatPrice, quantity };
    const sub = await client.post<StripeSubscription>(
      `/v1/subscriptions/${encodeURIComponent(org.stripeSubscriptionId)}`,
      { items: [item], proration_behavior: "create_prorations" },
      { idempotencyKey: `ptd-seats-${orgId}-${org.stripeSubscriptionId}-${quantity}` },
    );

    const shape = subscriptionShape(sub, env);
    await writeBillingState(orgId, {
      items: shape.items,
      seatQuantity: shape.seatQuantity ?? quantity,
      status: sub.status ?? state.status,
      currentPeriodStart: subscriptionPeriodStart(sub) ?? state.currentPeriodStart,
      currentPeriodEnd: subscriptionPeriodEnd(sub) ?? state.currentPeriodEnd,
    });
    return { synced: true, plan: org.plan, humans: usage.humans, quantity, previous };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[billing] seat sync failed for org ${orgId}: ${message}`);
    return idle(`seat sync failed: ${message}`);
  }
}

/* ------------------------------------------------------------ meter events */

export interface MeterEventInput {
  eventName: string;
  customerId: string;
  /** Whatever the meter counts: 1 for an invoice, cents for AI. */
  value: number;
  /** Stripe de-duplicates on this for at least 24h, so it must name the *thing*. */
  identifier: string;
  at?: Date;
}

/** The exact `POST /v1/billing/meter_events` body. Pure, so a test can assert it. */
export function meterEventParams(input: MeterEventInput): Record<string, unknown> {
  return {
    event_name: input.eventName,
    payload: { stripe_customer_id: input.customerId, value: String(Math.max(0, Math.round(input.value))) },
    identifier: input.identifier.slice(0, 100),
    ...(input.at ? { timestamp: Math.floor(input.at.getTime() / 1000) } : {}),
  };
}

export function postMeterEvent(client: StripeClient, input: MeterEventInput): Promise<{ identifier?: string }> {
  // Two guards against double-counting: Stripe's own uniqueness on `identifier`,
  // and the idempotency key, which makes a retried POST return the first answer.
  return client.post<{ identifier?: string }>("/v1/billing/meter_events", meterEventParams(input), {
    idempotencyKey: `meter-${input.identifier}`.slice(0, 255),
  });
}

/* ---------------------------------------------------------------- reconcile */

/**
 * The subscription that decides the org's plan: the healthiest one Stripe has for
 * the customer, newest first. Used when the org row has no subscription id yet
 * (checkout just completed and the webhook has not landed).
 */
export async function latestSubscriptionForCustomer(client: StripeClient, customerId: string): Promise<StripeSubscription | null> {
  const list = await client.get<{ data?: StripeSubscription[] }>("/v1/subscriptions", { customer: customerId, status: "all", limit: 10 });
  const rows = list.data ?? [];
  if (rows.length === 0) return null;
  return rows.find((s) => subscriptionHealth(s.status).healthy === true) ?? rows[0];
}

/**
 * Re-read Stripe and apply. Used by the success redirect (which lands before the
 * webhook does) and by any manual reconciliation.
 */
export async function syncOrgFromStripe(
  client: StripeClient,
  orgId: number,
  opts: { sessionId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<AppliedState | null> {
  const env = opts.env ?? process.env;
  const org = await getOrgBilling(orgId);
  if (!org) return null;

  let subscriptionId = org.stripeSubscriptionId;
  if (opts.sessionId) {
    const session = await fetchCheckoutSession(client, opts.sessionId);
    const sessionOrgId = session.client_reference_id ? Number(session.client_reference_id) : Number(session.metadata?.orgId);
    // Never let a session id from another org move this org's plan.
    if (Number.isFinite(sessionOrgId) && sessionOrgId === orgId) {
      subscriptionId = idOf(session.subscription) ?? subscriptionId;
      const customerId = idOf(session.customer);
      if (customerId && customerId !== org.stripeCustomerId) {
        await db.update(organizations).set({ stripeCustomerId: customerId }).where(eq(organizations.id, orgId));
      }
    }
  }
  if (subscriptionId) {
    const sub = await fetchSubscription(client, subscriptionId);
    return applySubscriptionState(orgId, sub, { env });
  }

  // No id on file: ask Stripe what the customer actually has.
  const customerId = (await getOrgBilling(orgId))?.stripeCustomerId ?? org.stripeCustomerId;
  if (!customerId) return null;
  const found = await latestSubscriptionForCustomer(client, customerId);
  return found ? applySubscriptionState(orgId, found, { env }) : null;
}

/** Re-exported so callers need one import for "what plan, which items". */
export { readBillingState, writeBillingState, clearBillingState };
export { isPaidPlan, seatOverage };
