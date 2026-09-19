/**
 * Billing actions — hosted deployments only.
 *
 * On a self-hosted PTD (`PTD_HOSTED` unset) every action here returns
 * `{ hosted: false }` and touches neither the database nor Stripe: no paywall, no
 * network call, nothing to configure. The client hides the tab on the same flag.
 *
 * Pricing is one flat $15/month per organization — no seat maths, so the only
 * state worth keeping is "does a healthy subscription exist".
 */
import { z } from "zod";
import { ActionError, defineAction } from "./registry";
import { currentBaseUrl } from "../billing/base";
import {
  BILLING_INTERVAL,
  FREE_MEMBER_LIMIT,
  PRICE_USD,
  createCheckoutSession,
  createPortalSession,
  ensureCustomer,
  fetchSubscription,
  getOrgBilling,
  isHosted,
  orgSeatUsage,
  ownerEmail,
  priceId,
  requireStripe,
  subscriptionPeriodEnd,
  syncOrgFromStripe,
  planForStatus,
  type Plan,
} from "../billing/service";
import { StripeError, StripeNotConfiguredError } from "../billing/stripe";

const OFF = { hosted: false as const };

/** Stripe and configuration failures become action errors, never 500s. */
function asActionError(err: unknown): never {
  if (err instanceof ActionError) throw err;
  if (err instanceof StripeNotConfiguredError) throw new ActionError("conflict", `Billing is not configured on this deployment: ${err.message}`);
  if (err instanceof StripeError) throw new ActionError("conflict", `Stripe rejected the request: ${err.message}`);
  throw err;
}

interface SubscriptionView {
  id: string;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDue: boolean;
}

defineAction({
  name: "billing.status",
  title: "Billing status",
  description:
    "The organization's hosted plan, what it costs, seat usage against the free-tier limit and the live subscription state. " +
    "On a self-hosted deployment it answers { hosted: false } and nothing else — there is no billing to report.",
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  handler: async (_args, ctx) => {
    if (!isHosted()) return OFF;
    const org = await getOrgBilling(ctx.orgId);
    if (!org) throw new ActionError("not_found", "Organization not found");
    const usage = await orgSeatUsage(ctx.orgId);

    let subscription: SubscriptionView | null = null;
    let warning: string | undefined;
    if (org.stripeSubscriptionId && process.env.STRIPE_SECRET_KEY) {
      try {
        const sub = await fetchSubscription(requireStripe(), org.stripeSubscriptionId);
        subscription = {
          id: sub.id,
          status: sub.status ?? null,
          currentPeriodEnd: subscriptionPeriodEnd(sub),
          cancelAtPeriodEnd: sub.cancel_at_period_end === true,
          pastDue: planForStatus(sub.status).pastDue,
        };
      } catch (err) {
        // A Stripe outage must not blank out the tab.
        warning = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      hosted: true,
      plan: org.plan as Plan,
      priceUsd: PRICE_USD,
      interval: BILLING_INTERVAL,
      limits: { members: org.plan === "free" ? FREE_MEMBER_LIMIT : null },
      usage: { members: usage.members, agents: usage.agents, humans: usage.humans },
      subscription,
      portalAvailable: Boolean(org.stripeCustomerId) && Boolean(process.env.STRIPE_SECRET_KEY),
      configured: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
      ...(warning ? { warning } : {}),
    };
  },
});

defineAction({
  name: "billing.checkout",
  title: "Start checkout",
  description:
    "Create a Stripe Checkout Session for the flat $15/month organization subscription and return its URL for the browser to follow. Owner only.",
  input: z.object({}),
  requiredRole: "owner",
  surface: "org",
  handler: async (_args, ctx) => {
    if (!isHosted()) return OFF;
    try {
      const org = await getOrgBilling(ctx.orgId);
      if (!org) throw new ActionError("not_found", "Organization not found");
      if (org.plan === "hosted" && org.stripeSubscriptionId) {
        throw new ActionError("conflict", "This organization already has a subscription — use Manage billing to change or cancel it");
      }
      const client = requireStripe();
      const email = await ownerEmail(ctx.orgId, ctx.email);
      const customerId = await ensureCustomer(client, org, { email });
      const session = await createCheckoutSession(client, {
        orgId: ctx.orgId,
        customerId,
        priceId: priceId(),
        base: currentBaseUrl(),
      });
      return { hosted: true, url: session.url, sessionId: session.id };
    } catch (err) {
      asActionError(err);
    }
  },
});

defineAction({
  name: "billing.portal",
  title: "Manage billing",
  description:
    "Create a Stripe Customer Portal session — card, invoices, cancellation — and return its URL. Owner only; requires an existing Stripe customer.",
  input: z.object({}),
  requiredRole: "owner",
  surface: "org",
  handler: async (_args, ctx) => {
    if (!isHosted()) return OFF;
    try {
      const org = await getOrgBilling(ctx.orgId);
      if (!org) throw new ActionError("not_found", "Organization not found");
      if (!org.stripeCustomerId) throw new ActionError("conflict", "No Stripe customer yet — subscribe first");
      const session = await createPortalSession(requireStripe(), { customerId: org.stripeCustomerId, base: currentBaseUrl() });
      return { hosted: true, url: session.url };
    } catch (err) {
      asActionError(err);
    }
  },
});

defineAction({
  name: "billing.sync",
  title: "Sync subscription",
  description:
    "Re-read the subscription from Stripe and apply it to the organization. The Checkout success redirect calls this so the plan is correct " +
    "even before the webhook lands; safe to call at any time. Owner only.",
  input: z.object({
    sessionId: z.string().min(1).max(200).optional().describe("Checkout Session id from the success redirect (session_id), if available."),
  }),
  requiredRole: "owner",
  surface: "org",
  handler: async (args, ctx) => {
    if (!isHosted()) return OFF;
    try {
      const applied = await syncOrgFromStripe(requireStripe(), ctx.orgId, { sessionId: args.sessionId });
      if (!applied) {
        const org = await getOrgBilling(ctx.orgId);
        return { hosted: true, synced: false, plan: org?.plan ?? null, subscription: null };
      }
      return {
        hosted: true,
        synced: true,
        plan: applied.plan,
        changed: applied.changed,
        subscription: {
          status: applied.status,
          currentPeriodEnd: applied.currentPeriodEnd,
          cancelAtPeriodEnd: applied.cancelAtPeriodEnd,
          pastDue: applied.pastDue,
        },
      };
    } catch (err) {
      asActionError(err);
    }
  },
});
