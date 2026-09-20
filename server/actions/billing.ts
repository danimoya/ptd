/**
 * Billing actions — hosted deployments only.
 *
 * On a self-hosted PTD (`PTD_HOSTED` unset) every action here returns
 * `{ hosted: false }` and touches neither the database nor Stripe: no paywall, no
 * network call, nothing to configure. The client hides the tab on the same flag.
 *
 * Five actions: read the state, buy a plan, change a plan, open Stripe's portal,
 * re-read Stripe. The plan itself is never taken from the client — `billing.checkout`
 * says which price to sell, and the *subscription's* price is what the plan is read
 * back from afterwards.
 */
import { z } from "zod";
import { ActionError, defineAction } from "./registry";
import { currentBaseUrl } from "../billing/base";
import { addonUsage } from "../billing/addons";
import {
  AI_MARKUP,
  CERT_INVOICE_USD,
  FOUNDING_PROMOTION_CODE,
  PLAN_FEATURES,
  PLAN_LABELS,
  PLAN_PRICES,
  SEAT_PRICES,
  describeHostedPlans,
  foundingCoupon,
  planLimits,
  pricesConfigured,
  seatOverage,
  type Interval,
  type PaidPlan,
  type Plan,
} from "../billing/plans";
import {
  PRICE_USD,
  changeSubscriptionPlan,
  createCheckoutSession,
  createPortalSession,
  ensureCustomer,
  fetchSubscription,
  getOrgBilling,
  isHosted,
  orgSeatUsage,
  ownerEmail,
  readBillingState,
  requireStripe,
  subscriptionHealth,
  subscriptionPeriodEnd,
  subscriptionPeriodStart,
  syncOrgFromStripe,
  applySubscriptionState,
} from "../billing/service";
import { StripeError, StripeNotConfiguredError } from "../billing/stripe";
import type { BillingItems } from "../billing/state";

const OFF = { hosted: false as const };

const planArg = z.enum(["team", "business"]).describe("Which plan to buy: team ($15/org/month) or business ($49/org/month).");
const intervalArg = z
  .enum(["month", "year"])
  .optional()
  .describe("month, or year for two months free (Team $150, Business $490). Defaults to month.");

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
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDue: boolean;
  /** Which of the four line items the subscription carries. */
  items: BillingItems;
  seatQuantity: number | null;
}

defineAction({
  name: "billing.status",
  title: "Billing status",
  description:
    "Everything the Billing tab draws: the plan and interval, the price list, the seat limits and what is in use (humans, agents, total, billable overage), " +
    "the metered add-ons so far this period (certified invoices, AI cents), the live subscription state, and the founding-member code while one is on offer. " +
    "On a self-hosted deployment it answers { hosted: false } and nothing else — there is no billing to report.",
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  handler: async (_args, ctx) => {
    if (!isHosted()) return OFF;
    const org = await getOrgBilling(ctx.orgId);
    if (!org) throw new ActionError("not_found", "Organization not found");

    const usage = await orgSeatUsage(ctx.orgId);
    const stored = await readBillingState(ctx.orgId);
    const limits = planLimits(org.plan);

    let subscription: SubscriptionView | null = stored.status
      ? {
          id: org.stripeSubscriptionId ?? "",
          status: stored.status,
          currentPeriodStart: stored.currentPeriodStart,
          currentPeriodEnd: stored.currentPeriodEnd,
          cancelAtPeriodEnd: stored.cancelAtPeriodEnd,
          pastDue: subscriptionHealth(stored.status).pastDue,
          items: stored.items,
          seatQuantity: stored.seatQuantity,
        }
      : null;
    let interval: Interval | null = stored.interval;
    let warning: string | undefined;

    if (org.stripeSubscriptionId && process.env.STRIPE_SECRET_KEY) {
      try {
        // Stripe is the truth; the stored config is only what we last heard.
        const applied = await applySubscriptionState(ctx.orgId, await fetchSubscription(requireStripe(), org.stripeSubscriptionId));
        interval = applied.interval ?? interval;
        subscription = {
          id: org.stripeSubscriptionId,
          status: applied.status,
          currentPeriodStart: applied.currentPeriodStart,
          currentPeriodEnd: applied.currentPeriodEnd,
          cancelAtPeriodEnd: applied.cancelAtPeriodEnd,
          pastDue: applied.pastDue,
          items: applied.items,
          seatQuantity: applied.seatQuantity,
        };
      } catch (err) {
        // A Stripe outage must not blank out the tab.
        warning = err instanceof Error ? err.message : String(err);
      }
    }

    // The plan may have moved under us (a cancelled subscription, a changed price).
    const current = (await getOrgBilling(ctx.orgId)) ?? org;
    const addons = await addonUsage(ctx.orgId, { since: subscription?.currentPeriodStart ?? stored.currentPeriodStart });
    const overage = seatOverage(current.plan, usage.humans);

    return {
      hosted: true,
      plan: current.plan as Plan,
      planLabel: PLAN_LABELS[current.plan],
      interval: interval ?? (current.plan === "free" ? null : "month"),
      features: PLAN_FEATURES[current.plan],
      prices: PLAN_PRICES,
      seatPrices: SEAT_PRICES,
      certInvoiceUsd: CERT_INVOICE_USD,
      aiMarkup: AI_MARKUP,
      /** What the entry plan costs, for copy that quotes one number. */
      priceUsd: PRICE_USD,
      plans: describeHostedPlans(),
      limits: {
        humanSeats: limits.humanSeats,
        totalMembers: limits.totalMembers,
        includedHumanSeats: limits.includedHumanSeats,
        billableSeats: limits.billableSeats,
        /** Back-compatible field: the free tier's single ceiling. */
        members: current.plan === "free" ? limits.totalMembers : null,
      },
      usage: {
        humans: usage.humans,
        agents: usage.agents,
        total: usage.members,
        members: usage.members,
        seatOverage: overage,
        seatCostUsd: overage * SEAT_PRICES[interval ?? "month"],
      },
      addons: {
        since: addons.since,
        certifiedInvoices: addons.certifiedInvoices,
        /** Only Team pays for these; on Business they are included. */
        certifiedInvoicesUsd: current.plan === "team" ? addons.certifiedInvoices * CERT_INVOICE_USD : 0,
        aiCents: addons.aiCents,
        aiCostUsd: addons.aiCostUsd,
        aiCalls: addons.aiCalls,
      },
      subscription,
      portalAvailable: Boolean(current.stripeCustomerId) && Boolean(process.env.STRIPE_SECRET_KEY),
      configured: Boolean(process.env.STRIPE_SECRET_KEY) && pricesConfigured(),
      memberCap: limits.totalMembers,
      // The founding offer is only worth showing to an organization that has not
      // bought yet: the code is redeemed at Checkout, not in the portal.
      foundingCode: foundingCoupon() && !current.stripeSubscriptionId ? FOUNDING_PROMOTION_CODE : null,
      ...(warning ? { warning } : {}),
    };
  },
});

defineAction({
  name: "billing.checkout",
  title: "Start checkout",
  description:
    "Create a Stripe Checkout Session for a plan and interval and return its URL for the browser to follow. " +
    "The session carries the flat plan price, the seat price when Business is already past 50 humans, and both usage meters; promotion codes (FOUNDING) are accepted there. Owner only.",
  input: z.object({ plan: planArg, interval: intervalArg }),
  requiredRole: "owner",
  audited: true,
  surface: "org",
  handler: async (args, ctx) => {
    if (!isHosted()) return OFF;
    try {
      const org = await getOrgBilling(ctx.orgId);
      if (!org) throw new ActionError("not_found", "Organization not found");
      if (org.stripeSubscriptionId && org.plan !== "free") {
        throw new ActionError(
          "conflict",
          "This organization already has a subscription — use billing.change_plan to move between plans or intervals, or Manage billing to cancel it.",
        );
      }
      const plan = args.plan as PaidPlan;
      const interval: Interval = args.interval ?? "month";
      const usage = await orgSeatUsage(ctx.orgId);
      const client = requireStripe();
      const email = await ownerEmail(ctx.orgId, ctx.email);
      const customerId = await ensureCustomer(client, org, { email });
      const session = await createCheckoutSession(client, {
        orgId: ctx.orgId,
        customerId,
        plan,
        interval,
        seatQuantity: seatOverage(plan, usage.humans),
        base: currentBaseUrl(),
      });
      return {
        hosted: true,
        url: session.url,
        sessionId: session.id,
        plan,
        interval,
        seatQuantity: seatOverage(plan, usage.humans),
        priceUsd: PLAN_PRICES[plan][interval],
      };
    } catch (err) {
      asActionError(err);
    }
  },
});

defineAction({
  name: "billing.change_plan",
  title: "Change plan",
  description:
    "Move an existing subscription to another plan or billing interval in place — Team↔Business, monthly↔annual — rather than starting a second Checkout. " +
    "Stripe prorates the difference onto the next invoice (`create_prorations`), the subscription keeps its identity and any discount, and the seat quantity is set from the current human count. " +
    "An organization with no subscription yet is sent to billing.checkout instead. Owner only.",
  input: z.object({ plan: planArg, interval: intervalArg }),
  requiredRole: "owner",
  audited: true,
  surface: "org",
  handler: async (args, ctx) => {
    if (!isHosted()) return OFF;
    try {
      const org = await getOrgBilling(ctx.orgId);
      if (!org) throw new ActionError("not_found", "Organization not found");
      if (!org.stripeSubscriptionId) {
        throw new ActionError("conflict", "This organization has no subscription yet — start one with billing.checkout.");
      }
      const plan = args.plan as PaidPlan;
      const state = await readBillingState(ctx.orgId);
      const interval: Interval = args.interval ?? state.interval ?? "month";
      if (org.plan === plan && state.interval === interval) {
        throw new ActionError("conflict", `This organization is already on ${PLAN_LABELS[plan]}, billed ${interval === "year" ? "yearly" : "monthly"}.`);
      }
      const usage = await orgSeatUsage(ctx.orgId);
      const seatQuantity = seatOverage(plan, usage.humans);
      const client = requireStripe();
      const sub = await changeSubscriptionPlan(client, org.stripeSubscriptionId, {
        orgId: ctx.orgId,
        plan,
        interval,
        items: state.items,
        seatQuantity,
      });
      const applied = await applySubscriptionState(ctx.orgId, sub);
      return {
        hosted: true,
        plan: applied.plan,
        interval: applied.interval ?? interval,
        seatQuantity,
        priceUsd: PLAN_PRICES[plan][interval],
        subscription: {
          id: sub.id,
          status: applied.status,
          currentPeriodStart: applied.currentPeriodStart ?? subscriptionPeriodStart(sub),
          currentPeriodEnd: applied.currentPeriodEnd ?? subscriptionPeriodEnd(sub),
          cancelAtPeriodEnd: applied.cancelAtPeriodEnd,
          pastDue: applied.pastDue,
        },
      };
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
  audited: true,
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
    "Re-read the subscription from Stripe and apply it to the organization — plan from the base price, interval, item ids and the period. The Checkout success redirect calls this so the plan is correct " +
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
        return { hosted: true, synced: false, plan: org?.plan ?? null, interval: null, subscription: null };
      }
      return {
        hosted: true,
        synced: true,
        plan: applied.plan,
        interval: applied.interval,
        changed: applied.changed,
        subscription: {
          status: applied.status,
          currentPeriodStart: applied.currentPeriodStart,
          currentPeriodEnd: applied.currentPeriodEnd,
          cancelAtPeriodEnd: applied.cancelAtPeriodEnd,
          pastDue: applied.pastDue,
          items: applied.items,
          seatQuantity: applied.seatQuantity,
        },
      };
    } catch (err) {
      asActionError(err);
    }
  },
});
