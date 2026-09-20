/**
 * Plan gates — the four places a feature asks "may this organization do this?".
 *
 * The rules, in one table, are in ./plans.ts. This file is the throw: it loads the
 * organization's plan and turns "no" into an `ActionError("forbidden")` whose text
 * names the plan that *would* allow it, because a refusal that does not say what to
 * buy is just a wall.
 *
 * Two invariants:
 *
 *  - **Self-hosting is never gated.** `PTD_HOSTED` unset, or a `self_hosted`
 *     organization, means every gate returns immediately. A self-hoster has paid
 *     with their own hardware.
 *  - **Nothing here meters.** Metering is ./metering.ts, and it happens after the
 *     work succeeded, never as a side effect of asking permission.
 */
import { ActionError } from "../actions/registry";
import {
  PLAN_LABELS,
  PLAN_PRICES,
  isPaidPlan,
  lowestPlanWith,
  planAllows,
  type Feature,
  type Plan,
} from "./plans";
import { getOrgBilling, isHosted } from "./service";

/** The plan a gate should judge by, or null when nothing is gated at all. */
export async function gatedPlan(orgId: number, env: NodeJS.ProcessEnv = process.env): Promise<Plan | null> {
  if (!isHosted(env)) return null;
  const org = await getOrgBilling(orgId);
  if (!org || org.plan === "self_hosted") return null;
  return org.plan;
}

export function upgradeMessage(what: string, plan: Plan, needed: Plan): string {
  const price = isPaidPlan(needed) ? ` ($${PLAN_PRICES[needed].month}/month, or $${PLAN_PRICES[needed].year} a year)` : "";
  return `${what} is part of the ${PLAN_LABELS[needed]} plan${price}. This organization is on ${PLAN_LABELS[plan]} — upgrade in Org → Billing.`;
}

/**
 * Refuse unless the organization's plan carries `feature`.
 *
 * Returns the plan it judged by (null when the deployment is self-hosted), so a
 * caller that behaves differently per plan does not have to load the org twice.
 */
export async function assertFeature(
  orgId: number,
  feature: Feature,
  what: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Plan | null> {
  const plan = await gatedPlan(orgId, env);
  if (plan === null) return null;
  if (planAllows(plan, feature)) return plan;
  const needed = lowestPlanWith(feature) ?? "business";
  throw new ActionError("forbidden", upgradeMessage(what, plan, needed));
}

/* ------------------------------------------------------- certified invoices */

export interface CertifiedInvoiceGate {
  /** null on a self-hosted deployment. */
  plan: Plan | null;
  /** Team pays $1 an invoice; Business includes them; self-hosting meters nothing. */
  metered: boolean;
  customerId: string | null;
}

/**
 * May this organization certify an invoice, and does issuing one cost a dollar?
 *
 * Team is allowed *and* metered, which is why the Stripe customer is checked here,
 * before anything is frozen: an organization we cannot bill must not quietly get
 * the add-on for free, and finding that out after the invoice is signed and the
 * entries are locked is far too late.
 */
export async function assertCertifiedInvoices(orgId: number, env: NodeJS.ProcessEnv = process.env): Promise<CertifiedInvoiceGate> {
  if (!isHosted(env)) return { plan: null, metered: false, customerId: null };
  const org = await getOrgBilling(orgId);
  if (!org || org.plan === "self_hosted") return { plan: org?.plan ?? null, metered: false, customerId: null };

  if (!planAllows(org.plan, "certified_invoices")) {
    throw new ActionError(
      "forbidden",
      upgradeMessage("Certified invoices — signed, with a public verification link", org.plan, "team") +
        ` On Team they are $1 each; Business includes them.`,
    );
  }
  if (org.plan !== "team") return { plan: org.plan, metered: false, customerId: org.stripeCustomerId };

  if (!org.stripeCustomerId || !org.stripeSubscriptionId) {
    throw new ActionError(
      "conflict",
      "Certified invoices are $1 each on Team, and this organization has no live Stripe subscription to bill them to. " +
        "Open Org → Billing and finish (or refresh) the subscription first — or move to Business, where they are included.",
    );
  }
  return { plan: org.plan, metered: true, customerId: org.stripeCustomerId };
}

/* ----------------------------------------------------------------------- AI */

export interface AiGate {
  plan: Plan | null;
  /** Whose key pays for the call. */
  source: "org" | "ptd";
  /** Whether the call is billed on at cost + 20%. */
  metered: boolean;
  customerId: string | null;
}

/**
 * May this organization use AI, and who pays for it?
 *
 * With its own key, the organization pays its provider directly and PTD meters
 * nothing. Without one it may use the key this deployment is configured with — and
 * then the tokens are billed on at cost plus 20%, which is the only honest way to
 * resell somebody else's meter.
 */
export async function assertAiAllowed(
  orgId: number,
  opts: { hasOrgKey: boolean; serverKeyConfigured: boolean; env?: NodeJS.ProcessEnv },
): Promise<AiGate> {
  const env = opts.env ?? process.env;
  if (!isHosted(env)) return { plan: null, source: opts.hasOrgKey ? "org" : "ptd", metered: false, customerId: null };
  const org = await getOrgBilling(orgId);
  if (!org || org.plan === "self_hosted") {
    return { plan: org?.plan ?? null, source: opts.hasOrgKey ? "org" : "ptd", metered: false, customerId: null };
  }

  if (!planAllows(org.plan, "ai")) {
    throw new ActionError(
      "forbidden",
      upgradeMessage("AI priority suggestions", org.plan, "team") +
        " Bring your own provider key and the calls cost PTD nothing; without one, PTD's key is metered at cost plus 20%.",
    );
  }
  if (opts.hasOrgKey) return { plan: org.plan, source: "org", metered: false, customerId: org.stripeCustomerId };

  if (!opts.serverKeyConfigured) {
    throw new ActionError(
      "invalid",
      "This deployment has no AI provider of its own, so connect your organization's key first (Org → AI, or the `ai.connect` action).",
    );
  }
  if (!org.stripeCustomerId || !org.stripeSubscriptionId) {
    throw new ActionError(
      "conflict",
      "PTD-provided AI is metered at cost plus 20%, and this organization has no live Stripe subscription to bill it to. " +
        "Finish the subscription in Org → Billing, or connect your own provider key with `ai.connect`.",
    );
  }
  return { plan: org.plan, source: "ptd", metered: true, customerId: org.stripeCustomerId };
}
