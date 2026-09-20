/**
 * The plan model — the one description of what PTD sells.
 *
 * Four plans, and only three of them are billable:
 *
 *   self_hosted  free, everything, no billing code in the process at all
 *   free         $0 hosted: one organization, 3 seats counting humans *and* agents
 *   team         $15 per organization per month (or $150 a year): up to 10 **human**
 *                seats, agent seats free — an agent pays its own API bill, so
 *                charging for its chair as well would be charging twice
 *   business     $49 per organization per month (or $490 a year): 50 human seats
 *                included, +$2 per human seat beyond that, and the surfaces an
 *                organization needs when it has to hand its numbers to someone
 *                else — certified invoices, SSO/2FA policy, audit export, Stripe Tax
 *
 * Two rules the rest of the billing code leans on:
 *
 *  1. **The price is the truth.** An organization's plan is derived from the
 *     subscription's base price (its lookup key, else its id), never from what a
 *     client asked for. `organizations.plan` is a cache of that derivation.
 *  2. **Humans and agents are counted differently on purpose.** `free` counts
 *     every member; `team` and `business` count humans for the seat limit and
 *     count everybody only against the hard member cap, which exists to keep a
 *     hosted tenant from turning into a deployment of its own.
 *
 * Everything here is pure: no database, no Stripe, no `process.env` read that is
 * not handed in. That is what lets the tests assert the plan maths without a
 * connection and the UI share the same numbers.
 */

export const PLANS = ["self_hosted", "free", "team", "business"] as const;
export type Plan = (typeof PLANS)[number];

/** The plans an organization on a hosted deployment can be on. */
export const HOSTED_PLANS = ["free", "team", "business"] as const;

/** The plans you can buy. */
export const PAID_PLANS = ["team", "business"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

export const INTERVALS = ["month", "year"] as const;
export type Interval = (typeof INTERVALS)[number];

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

/**
 * Read a stored plan, including the one this model replaced.
 *
 * `organizations.plan` is a varchar and pricing v1 wrote `hosted` into it for every
 * paying organization — one flat $15 tier. That is exactly what Team is, so a row
 * that still says `hosted` is read as `team` rather than being silently demoted to
 * `free` (which is what an unknown value would otherwise mean). The next webhook or
 * `billing.sync` rewrites the column, so the alias fades on its own.
 */
export const LEGACY_PLAN_ALIASES: Record<string, Plan> = { hosted: "team" };

export function normalisePlan(value: unknown, fallback: Plan = "free"): Plan {
  if (isPlan(value)) return value;
  if (typeof value === "string" && LEGACY_PLAN_ALIASES[value]) return LEGACY_PLAN_ALIASES[value];
  return fallback;
}

export function isPaidPlan(value: unknown): value is PaidPlan {
  return value === "team" || value === "business";
}

export function isInterval(value: unknown): value is Interval {
  return value === "month" || value === "year";
}

/* ─────────────────────────────────────────────────────────── the price list */

/** Dollars per organization. The yearly figure is ten months: two months free. */
export const PLAN_PRICES: Record<PaidPlan, Record<Interval, number>> = {
  team: { month: 15, year: 150 },
  business: { month: 49, year: 490 },
};

/** Dollars per extra **human** seat beyond what Business includes. */
export const SEAT_PRICES: Record<Interval, number> = { month: 2, year: 20 };

/** Dollars per certified invoice, metered, on Team only — Business includes them. */
export const CERT_INVOICE_USD = 1;

/**
 * PTD-provided AI is billed at cost plus 20%. The meter's unit is a cent, so a
 * fraction of a cent is not silently free and not silently a cent either — see
 * `aiMeterCents`.
 */
export const AI_MARKUP = 1.2;

/** Humans + agents a `free` organization may hold. */
export const FREE_MEMBER_LIMIT = 3;
/** Human seats included on Team. Agents do not count. */
export const TEAM_HUMAN_SEATS = 10;
/** Human seats included on Business before the per-seat price starts. */
export const BUSINESS_INCLUDED_HUMAN_SEATS = 50;
/** The hard ceiling on a hosted organization when `PTD_HOSTED_MAX_MEMBERS` is unset. */
export const DEFAULT_MEMBER_CAP = 100;

/** Two months free: what the annual price works out to per month. */
export function perMonthOnAnnual(plan: PaidPlan): number {
  return Math.round((PLAN_PRICES[plan].year / 12) * 100) / 100;
}

/** Dollars saved by paying yearly. */
export function annualSaving(plan: PaidPlan): number {
  return PLAN_PRICES[plan].month * 12 - PLAN_PRICES[plan].year;
}

/** cost × 1.2, in whole cents, rounded once. A real call never meters 0. */
export function aiMeterCents(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  return Math.round(costUsd * 100 * AI_MARKUP);
}

/* ────────────────────────────────────────────────────────────────── features */

/**
 * What a plan may do. Only four of these are *enforced* in this codebase
 * (`certified_invoices`, `security_policy`, `audit_export`, `ai`) — the rest
 * describe the plan for the pricing surfaces and are available to whichever
 * feature grows a gate next, through `planAllows`.
 */
export const FEATURES = [
  "surfaces",
  "integrations",
  "oauth_connectors",
  "webhooks",
  "importers",
  "certified_invoices",
  "security_policy",
  "audit_export",
  "stripe_tax",
  "priority_support",
  "ai",
  "ai_priority",
] as const;
export type Feature = (typeof FEATURES)[number];

const FREE_FEATURES: readonly Feature[] = ["surfaces"];

const TEAM_FEATURES: readonly Feature[] = [
  "surfaces",
  "integrations",
  "oauth_connectors",
  "webhooks",
  "importers",
  "certified_invoices",
  "ai",
];

const BUSINESS_FEATURES: readonly Feature[] = [
  ...TEAM_FEATURES,
  "security_policy",
  "audit_export",
  "stripe_tax",
  "priority_support",
  "ai_priority",
];

export const PLAN_FEATURES: Record<Plan, readonly Feature[]> = {
  // Self-hosting is not a trial: every feature, no ceiling, no billing.
  self_hosted: FEATURES,
  free: FREE_FEATURES,
  team: TEAM_FEATURES,
  business: BUSINESS_FEATURES,
};

export function planAllows(plan: Plan, feature: Feature): boolean {
  return PLAN_FEATURES[plan]?.includes(feature) ?? false;
}

/** The cheapest plan that has `feature` — what the refusal should tell you to buy. */
export function lowestPlanWith(feature: Feature): PaidPlan | null {
  for (const plan of PAID_PLANS) if (planAllows(plan, feature)) return plan;
  return null;
}

export const PLAN_LABELS: Record<Plan, string> = {
  self_hosted: "Self-hosted",
  free: "Free",
  team: "Team",
  business: "Business",
};

/* ──────────────────────────────────────────────────────────────────── limits */

export interface PlanLimits {
  /** Human members allowed, or null for "as many as you pay for". */
  humanSeats: number | null;
  /** Humans + agents allowed. The hard cap; null only off the hosted instance. */
  totalMembers: number | null;
  /** Human seats the flat price already covers. */
  includedHumanSeats: number | null;
  /** Whether humans past `includedHumanSeats` are billed rather than refused. */
  billableSeats: boolean;
}

/** `PTD_HOSTED_MAX_MEMBERS`, the hard ceiling on one hosted organization. */
export function memberCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PTD_HOSTED_MAX_MEMBERS ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MEMBER_CAP;
}

export function planLimits(plan: Plan, env: NodeJS.ProcessEnv = process.env): PlanLimits {
  const cap = memberCap(env);
  switch (plan) {
    case "free":
      return { humanSeats: FREE_MEMBER_LIMIT, totalMembers: FREE_MEMBER_LIMIT, includedHumanSeats: FREE_MEMBER_LIMIT, billableSeats: false };
    case "team":
      return { humanSeats: TEAM_HUMAN_SEATS, totalMembers: cap, includedHumanSeats: TEAM_HUMAN_SEATS, billableSeats: false };
    case "business":
      return { humanSeats: null, totalMembers: cap, includedHumanSeats: BUSINESS_INCLUDED_HUMAN_SEATS, billableSeats: true };
    default:
      // Self-hosted: no ceiling of any kind.
      return { humanSeats: null, totalMembers: null, includedHumanSeats: null, billableSeats: false };
  }
}

/** Billable human seats: what the seat line item's quantity must be. */
export function seatOverage(plan: Plan, humans: number): number {
  if (plan !== "business") return 0;
  return Math.max(0, humans - BUSINESS_INCLUDED_HUMAN_SEATS);
}

/* ───────────────────────────────────────────────── Stripe prices and meters */

/** The lookup keys the live Stripe objects carry. The plan is read back from these. */
export const PLAN_LOOKUP_KEYS: Record<PaidPlan, Record<Interval, string>> = {
  team: { month: "ptd_team_monthly", year: "ptd_team_yearly" },
  business: { month: "ptd_business_monthly", year: "ptd_business_yearly" },
};

export const SEAT_LOOKUP_KEYS: Record<Interval, string> = {
  month: "ptd_seat_monthly",
  year: "ptd_seat_yearly",
};

export const CERT_INVOICE_LOOKUP_KEY = "ptd_certified_invoice_metered";
export const AI_USAGE_LOOKUP_KEY = "ptd_ai_usage_metered";

/** Billing meter `event_name`s. Overridable, because a second account's meters may differ. */
export const DEFAULT_CERT_METER = "ptd_certified_invoices";
export const DEFAULT_AI_METER = "ptd_ai_usage_cents";

/** The promotion code a founding member types at Checkout. 40% off, first 100 orgs. */
export const FOUNDING_PROMOTION_CODE = "FOUNDING";

const PRICE_ENV_KEYS: Record<PaidPlan, Record<Interval, string>> = {
  team: { month: "STRIPE_PRICE_TEAM_MONTHLY", year: "STRIPE_PRICE_TEAM_YEARLY" },
  business: { month: "STRIPE_PRICE_BUSINESS_MONTHLY", year: "STRIPE_PRICE_BUSINESS_YEARLY" },
};

const SEAT_ENV_KEYS: Record<Interval, string> = {
  month: "STRIPE_PRICE_SEAT_MONTHLY",
  year: "STRIPE_PRICE_SEAT_YEARLY",
};

export function planPriceEnvKey(plan: PaidPlan, interval: Interval): string {
  return PRICE_ENV_KEYS[plan][interval];
}

/**
 * The price id for a plan and interval.
 *
 * `STRIPE_PRICE_ID` is still honoured as Team monthly, because that is exactly
 * what it meant when it was the only price PTD had — an older deployment keeps
 * working without an env edit.
 */
export function planPriceId(plan: PaidPlan, interval: Interval, env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env[planPriceEnvKey(plan, interval)]?.trim();
  if (configured) return configured;
  if (plan === "team" && interval === "month") return env.STRIPE_PRICE_ID?.trim() || null;
  return null;
}

export function seatPriceId(interval: Interval, env: NodeJS.ProcessEnv = process.env): string | null {
  return env[SEAT_ENV_KEYS[interval]]?.trim() || null;
}

export function certInvoicePriceId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.STRIPE_PRICE_CERT_INVOICE?.trim() || null;
}

export function aiUsagePriceId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.STRIPE_PRICE_AI_USAGE?.trim() || null;
}

export function certMeterName(env: NodeJS.ProcessEnv = process.env): string {
  return env.STRIPE_METER_CERT_INVOICE?.trim() || DEFAULT_CERT_METER;
}

export function aiMeterName(env: NodeJS.ProcessEnv = process.env): string {
  return env.STRIPE_METER_AI_USAGE?.trim() || DEFAULT_AI_METER;
}

/** The founding-member coupon id, if this deployment has one. */
export function foundingCoupon(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.STRIPE_COUPON_FOUNDING?.trim() || null;
}

/** Whether the four plan prices needed to sell anything are configured. */
export function pricesConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return PAID_PLANS.every((plan) => INTERVALS.every((interval) => Boolean(planPriceId(plan, interval, env))));
}

export function planFromLookupKey(key: string | null | undefined): { plan: PaidPlan; interval: Interval } | null {
  if (!key) return null;
  for (const plan of PAID_PLANS) {
    for (const interval of INTERVALS) {
      if (PLAN_LOOKUP_KEYS[plan][interval] === key) return { plan, interval };
    }
  }
  return null;
}

export type PriceRole =
  | { kind: "base"; plan: PaidPlan; interval: Interval }
  | { kind: "seat"; interval: Interval }
  | { kind: "cert" }
  | { kind: "ai" };

/**
 * What one subscription item's price *is*: the plan's base, the seat overage, or
 * one of the two meters. The lookup key decides when Stripe expanded it (it is
 * stable across accounts); the configured id is the fallback for a raw event
 * whose price was not expanded.
 */
export function priceRole(
  price: { id?: string | null; lookup_key?: string | null } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PriceRole | null {
  if (!price) return null;
  const byKey = planFromLookupKey(price.lookup_key ?? null);
  if (byKey) return { kind: "base", ...byKey };
  if (price.lookup_key) {
    for (const interval of INTERVALS) if (SEAT_LOOKUP_KEYS[interval] === price.lookup_key) return { kind: "seat", interval };
    if (price.lookup_key === CERT_INVOICE_LOOKUP_KEY) return { kind: "cert" };
    if (price.lookup_key === AI_USAGE_LOOKUP_KEY) return { kind: "ai" };
  }
  const id = price.id?.trim();
  if (!id) return null;
  for (const plan of PAID_PLANS) {
    for (const interval of INTERVALS) {
      if (planPriceId(plan, interval, env) === id) return { kind: "base", plan, interval };
    }
  }
  for (const interval of INTERVALS) if (seatPriceId(interval, env) === id) return { kind: "seat", interval };
  if (certInvoicePriceId(env) === id) return { kind: "cert" };
  if (aiUsagePriceId(env) === id) return { kind: "ai" };
  return null;
}

/* ───────────────────────────────────────────────────────── the plan, in full */

export interface PlanDescription {
  plan: Plan;
  label: string;
  /** null on the plans that are not sold. */
  prices: Record<Interval, number> | null;
  limits: PlanLimits;
  features: readonly Feature[];
  /** Dollars per extra human seat, Business only. */
  seatPrices: Record<Interval, number> | null;
  /** Dollars per certified invoice, when they are metered rather than included. */
  certInvoiceUsd: number | null;
}

export function describePlan(plan: Plan, env: NodeJS.ProcessEnv = process.env): PlanDescription {
  return {
    plan,
    label: PLAN_LABELS[plan],
    prices: isPaidPlan(plan) ? PLAN_PRICES[plan] : null,
    limits: planLimits(plan, env),
    features: PLAN_FEATURES[plan],
    seatPrices: plan === "business" ? SEAT_PRICES : null,
    // Team meters them; Business includes them; Free cannot issue one at all.
    certInvoiceUsd: plan === "team" ? CERT_INVOICE_USD : null,
  };
}

/** Every hosted plan, in order, for the pricing cards. */
export function describeHostedPlans(env: NodeJS.ProcessEnv = process.env): PlanDescription[] {
  return HOSTED_PLANS.map((plan) => describePlan(plan, env));
}
