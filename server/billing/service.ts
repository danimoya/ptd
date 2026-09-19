/**
 * Billing service: the org ⇄ Stripe mapping.
 *
 * One flat price per organization ($15/month, any number of seats), so there is
 * no quantity to sync and no per-seat proration to reason about — a subscription
 * either exists and is healthy (plan `hosted`) or it does not (plan `free`).
 *
 * Every function here is hosted-only; callers gate on `isHosted()` first.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { memberships, organizations, users } from "../../db/schema";
import { billingReturnUrl, currentBaseUrl } from "./base";
import { INTEGRATION_IDENTIFIER, StripeClient, StripeError, StripeNotConfiguredError, stripeFromEnv, type FetchLike } from "./stripe";

export const PRICE_USD = 15;
export const BILLING_INTERVAL = "month" as const;
/** Humans + agents a `free` hosted org may hold. */
export const FREE_MEMBER_LIMIT = 3;

export const PLANS = ["self_hosted", "free", "hosted"] as const;
export type Plan = (typeof PLANS)[number];

export function isHosted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PTD_HOSTED === "1";
}

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

/** A client or an explanatory throw — never a half-configured no-op. */
export function requireStripe(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): StripeClient {
  if (!env.STRIPE_SECRET_KEY) throw new StripeNotConfiguredError();
  return stripeFromEnv(env, fetchImpl);
}

export function priceId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env.STRIPE_PRICE_ID;
  if (!id) throw new StripeNotConfiguredError("STRIPE_PRICE_ID is unset — create the $15/month price first");
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
  return { ...row, plan: isPlan(row.plan) ? row.plan : "free" };
}

/** Find the org a Stripe object belongs to: metadata first, then our own columns. */
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
  members: number;
  humans: number;
  agents: number;
}

/** Seats in the org. A seat is a membership, whether a human or an agent holds it. */
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

export interface StripeSubscription {
  id: string;
  status?: string;
  customer?: string | { id?: string } | null;
  cancel_at_period_end?: boolean;
  current_period_end?: number | null;
  canceled_at?: number | null;
  items?: { data?: { current_period_end?: number | null; price?: { id?: string } }[] };
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

/**
 * Period end lives on the subscription item from 2025-03-31.basil onward and on
 * the subscription itself before that; read whichever the account answers with.
 */
export function subscriptionPeriodEnd(sub: StripeSubscription): string | null {
  const epoch = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end ?? null;
  return typeof epoch === "number" && epoch > 0 ? new Date(epoch * 1000).toISOString() : null;
}

/**
 * Stripe status → PTD plan. `null` means "leave the plan alone": an `incomplete`
 * or `paused` subscription is mid-flight, and guessing either way is worse than
 * waiting for the next event.
 */
export function planForStatus(status: string | undefined | null): { plan: Plan | null; pastDue: boolean } {
  switch (status) {
    case "active":
    case "trialing":
      return { plan: "hosted", pastDue: false };
    case "past_due":
      // Stripe is still dunning: keep the org working, flag it in the UI.
      return { plan: "hosted", pastDue: true };
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      return { plan: "free", pastDue: false };
    default:
      return { plan: null, pastDue: false };
  }
}

/* ------------------------------------------------------------------ mutation */

export interface AppliedState {
  orgId: number;
  plan: Plan;
  status: string | null;
  pastDue: boolean;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  changed: boolean;
}

/**
 * Write what Stripe says onto the org row. Safe to re-run: it computes the whole
 * desired state and only issues an UPDATE when a column actually differs, so a
 * replayed webhook is a no-op.
 */
export async function applySubscriptionState(
  orgId: number,
  sub: StripeSubscription,
  opts: { forcePlan?: Plan } = {},
): Promise<AppliedState> {
  const current = await getOrgBilling(orgId);
  const mapped = planForStatus(sub.status);
  const plan: Plan = opts.forcePlan ?? mapped.plan ?? current?.plan ?? "free";
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

  return {
    orgId,
    plan,
    status: sub.status ?? null,
    pastDue: mapped.pastDue,
    currentPeriodEnd: subscriptionPeriodEnd(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    changed,
  };
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
export async function ensureCustomer(
  client: StripeClient,
  org: OrgBilling,
  opts: { email: string },
): Promise<string> {
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

/** The exact Checkout Session request body. Pure, so a test can assert it. */
export function checkoutParams(input: {
  orgId: number;
  customerId: string;
  priceId: string;
  base?: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, unknown> {
  const env = input.env ?? process.env;
  const base = input.base ?? currentBaseUrl(env);
  return {
    mode: "subscription",
    customer: input.customerId,
    client_reference_id: String(input.orgId),
    // No payment_method_types: dynamic payment methods, configured in the Dashboard.
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: billingReturnUrl({ checkout: "success", session_id: "{CHECKOUT_SESSION_ID}" }, env, base),
    cancel_url: billingReturnUrl({ checkout: "cancelled" }, env, base),
    allow_promotion_codes: true,
    // Off deliberately: Stripe Tax collects nothing without an active registration,
    // and a half-on setting looks like tax is handled when it is not.
    automatic_tax: { enabled: false },
    subscription_data: { metadata: { orgId: String(input.orgId), product: "ptd-hosted" } },
    metadata: { orgId: String(input.orgId) },
    integration_identifier: INTEGRATION_IDENTIFIER,
  };
}

export async function createCheckoutSession(
  client: StripeClient,
  input: { orgId: number; customerId: string; priceId: string; base?: string; env?: NodeJS.ProcessEnv },
): Promise<{ id: string; url: string }> {
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

/**
 * The subscription that decides the org's plan: the healthiest one Stripe has for
 * the customer, newest first. Used when the org row has no subscription id yet
 * (checkout just completed and the webhook has not landed).
 */
export async function latestSubscriptionForCustomer(client: StripeClient, customerId: string): Promise<StripeSubscription | null> {
  const list = await client.get<{ data?: StripeSubscription[] }>("/v1/subscriptions", { customer: customerId, status: "all", limit: 10 });
  const rows = list.data ?? [];
  if (rows.length === 0) return null;
  return rows.find((s) => planForStatus(s.status).plan === "hosted") ?? rows[0];
}

/**
 * Re-read Stripe and apply. Used by the success redirect (which lands before the
 * webhook does) and by any manual reconciliation.
 */
export async function syncOrgFromStripe(
  client: StripeClient,
  orgId: number,
  opts: { sessionId?: string } = {},
): Promise<AppliedState | null> {
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
    return applySubscriptionState(orgId, sub);
  }

  // No id on file: ask Stripe what the customer actually has.
  const customerId = (await getOrgBilling(orgId))?.stripeCustomerId ?? org.stripeCustomerId;
  if (!customerId) return null;
  const found = await latestSubscriptionForCustomer(client, customerId);
  return found ? applySubscriptionState(orgId, found) : null;
}
