/**
 * The plan model, on its own.
 *
 * `server/billing/plans.ts` touches no database and no network, so this file is the
 * cheapest place to pin the numbers the owner decided on — and the place a future
 * price change will fail first.
 */
import { describe, expect, it } from "vitest";
import {
  AI_MARKUP,
  BUSINESS_INCLUDED_HUMAN_SEATS,
  CERT_INVOICE_USD,
  DEFAULT_MEMBER_CAP,
  FREE_MEMBER_LIMIT,
  PLAN_LOOKUP_KEYS,
  PLAN_PRICES,
  SEAT_PRICES,
  TEAM_HUMAN_SEATS,
  aiMeterCents,
  annualSaving,
  describeHostedPlans,
  describePlan,
  isPaidPlan,
  lowestPlanWith,
  memberCap,
  normalisePlan,
  perMonthOnAnnual,
  planAllows,
  planFromLookupKey,
  planLimits,
  planPriceId,
  priceRole,
  pricesConfigured,
  seatOverage,
  type Feature,
  type Plan,
} from "../../server/billing/plans";

const ENV = {
  STRIPE_PRICE_TEAM_MONTHLY: "price_team_m",
  STRIPE_PRICE_TEAM_YEARLY: "price_team_y",
  STRIPE_PRICE_BUSINESS_MONTHLY: "price_bus_m",
  STRIPE_PRICE_BUSINESS_YEARLY: "price_bus_y",
  STRIPE_PRICE_SEAT_MONTHLY: "price_seat_m",
  STRIPE_PRICE_SEAT_YEARLY: "price_seat_y",
  STRIPE_PRICE_CERT_INVOICE: "price_cert",
  STRIPE_PRICE_AI_USAGE: "price_ai",
} as unknown as NodeJS.ProcessEnv;

describe("the price list", () => {
  it("is $15/$150 for Team and $49/$490 for Business — two months free on the year", () => {
    expect(PLAN_PRICES).toEqual({ team: { month: 15, year: 150 }, business: { month: 49, year: 490 } });
    expect(PLAN_PRICES.team.year).toBe(PLAN_PRICES.team.month * 10);
    expect(PLAN_PRICES.business.year).toBe(PLAN_PRICES.business.month * 10);
    expect(annualSaving("team")).toBe(30);
    expect(annualSaving("business")).toBe(98);
    expect(perMonthOnAnnual("team")).toBe(12.5);
    expect(perMonthOnAnnual("business")).toBeCloseTo(40.83, 2);
  });

  it("prices an extra human seat at $2 a month, $20 a year, and an invoice at $1", () => {
    expect(SEAT_PRICES).toEqual({ month: 2, year: 20 });
    expect(CERT_INVOICE_USD).toBe(1);
    expect(AI_MARKUP).toBe(1.2);
  });

  it("meters AI in whole cents at cost plus 20%", () => {
    expect(aiMeterCents(0.01)).toBe(1); // 1c → 1.2c → 1
    expect(aiMeterCents(0.05)).toBe(6); // 5c → 6c
    expect(aiMeterCents(1)).toBe(120);
    expect(aiMeterCents(0.0001)).toBe(0); // below a hundredth of a cent: nothing to bill
    expect(aiMeterCents(0)).toBe(0);
    expect(aiMeterCents(-1)).toBe(0);
    expect(aiMeterCents(Number.NaN)).toBe(0);
  });
});

describe("limits", () => {
  it("counts every member on free and only humans on the paid plans", () => {
    expect(planLimits("free", ENV)).toEqual({ humanSeats: 3, totalMembers: 3, includedHumanSeats: 3, billableSeats: false });
    expect(planLimits("team", ENV)).toEqual({ humanSeats: 10, totalMembers: 100, includedHumanSeats: 10, billableSeats: false });
    expect(planLimits("business", ENV)).toEqual({ humanSeats: null, totalMembers: 100, includedHumanSeats: 50, billableSeats: true });
    expect(planLimits("self_hosted", ENV)).toEqual({ humanSeats: null, totalMembers: null, includedHumanSeats: null, billableSeats: false });
    expect([FREE_MEMBER_LIMIT, TEAM_HUMAN_SEATS, BUSINESS_INCLUDED_HUMAN_SEATS, DEFAULT_MEMBER_CAP]).toEqual([3, 10, 50, 100]);
  });

  it("takes the hard cap from PTD_HOSTED_MAX_MEMBERS and ignores nonsense", () => {
    expect(memberCap({ PTD_HOSTED_MAX_MEMBERS: "250" } as unknown as NodeJS.ProcessEnv)).toBe(250);
    for (const raw of ["", "0", "-5", "many", undefined]) {
      expect(memberCap({ PTD_HOSTED_MAX_MEMBERS: raw } as unknown as NodeJS.ProcessEnv)).toBe(100);
    }
  });

  it("bills the humans past 50 on Business and nobody anywhere else", () => {
    expect(seatOverage("business", 50)).toBe(0);
    expect(seatOverage("business", 51)).toBe(1);
    expect(seatOverage("business", 62)).toBe(12);
    expect(seatOverage("team", 99)).toBe(0);
    expect(seatOverage("free", 99)).toBe(0);
    expect(seatOverage("self_hosted", 999)).toBe(0);
  });
});

describe("the feature table", () => {
  const matrix: Record<Feature, Plan[]> = {
    surfaces: ["free", "team", "business", "self_hosted"],
    integrations: ["team", "business", "self_hosted"],
    oauth_connectors: ["team", "business", "self_hosted"],
    webhooks: ["team", "business", "self_hosted"],
    importers: ["team", "business", "self_hosted"],
    certified_invoices: ["team", "business", "self_hosted"],
    ai: ["team", "business", "self_hosted"],
    security_policy: ["business", "self_hosted"],
    audit_export: ["business", "self_hosted"],
    stripe_tax: ["business", "self_hosted"],
    priority_support: ["business", "self_hosted"],
    ai_priority: ["business", "self_hosted"],
  };

  it("says exactly who may do what", () => {
    for (const [feature, plans] of Object.entries(matrix) as [Feature, Plan[]][]) {
      for (const plan of ["self_hosted", "free", "team", "business"] as Plan[]) {
        expect(planAllows(plan, feature), `${plan} → ${feature}`).toBe(plans.includes(plan));
      }
    }
  });

  it("never gates a self-hosted deployment", () => {
    for (const feature of Object.keys(matrix) as Feature[]) expect(planAllows("self_hosted", feature)).toBe(true);
  });

  it("names the cheapest plan that would allow a refused feature", () => {
    expect(lowestPlanWith("certified_invoices")).toBe("team");
    expect(lowestPlanWith("security_policy")).toBe("business");
    expect(lowestPlanWith("audit_export")).toBe("business");
    expect(lowestPlanWith("ai")).toBe("team");
  });
});

describe("reading a plan back from Stripe", () => {
  it("maps the four live lookup keys", () => {
    expect(planFromLookupKey("ptd_team_monthly")).toEqual({ plan: "team", interval: "month" });
    expect(planFromLookupKey("ptd_team_yearly")).toEqual({ plan: "team", interval: "year" });
    expect(planFromLookupKey("ptd_business_monthly")).toEqual({ plan: "business", interval: "month" });
    expect(planFromLookupKey("ptd_business_yearly")).toEqual({ plan: "business", interval: "year" });
    expect(planFromLookupKey("ptd_seat_monthly")).toBeNull();
    expect(planFromLookupKey("something_else")).toBeNull();
    expect(planFromLookupKey(null)).toBeNull();
    expect(PLAN_LOOKUP_KEYS.business.year).toBe("ptd_business_yearly");
  });

  it("names every item's role by lookup key, before any env is consulted", () => {
    expect(priceRole({ id: "whatever", lookup_key: "ptd_business_yearly" }, {} as NodeJS.ProcessEnv)).toEqual({ kind: "base", plan: "business", interval: "year" });
    expect(priceRole({ lookup_key: "ptd_seat_monthly" }, {} as NodeJS.ProcessEnv)).toEqual({ kind: "seat", interval: "month" });
    expect(priceRole({ lookup_key: "ptd_certified_invoice_metered" }, {} as NodeJS.ProcessEnv)).toEqual({ kind: "cert" });
    expect(priceRole({ lookup_key: "ptd_ai_usage_metered" }, {} as NodeJS.ProcessEnv)).toEqual({ kind: "ai" });
  });

  it("falls back to the configured ids when Stripe sent no lookup key", () => {
    expect(priceRole({ id: "price_team_y" }, ENV)).toEqual({ kind: "base", plan: "team", interval: "year" });
    expect(priceRole({ id: "price_seat_y" }, ENV)).toEqual({ kind: "seat", interval: "year" });
    expect(priceRole({ id: "price_cert" }, ENV)).toEqual({ kind: "cert" });
    expect(priceRole({ id: "price_ai" }, ENV)).toEqual({ kind: "ai" });
    expect(priceRole({ id: "price_of_something_else" }, ENV)).toBeNull();
    expect(priceRole(null, ENV)).toBeNull();
  });

  it("keeps STRIPE_PRICE_ID working as Team monthly", () => {
    const legacy = { STRIPE_PRICE_ID: "price_old_15" } as unknown as NodeJS.ProcessEnv;
    expect(planPriceId("team", "month", legacy)).toBe("price_old_15");
    expect(planPriceId("team", "year", legacy)).toBeNull();
    expect(planPriceId("business", "month", legacy)).toBeNull();
    expect(priceRole({ id: "price_old_15" }, legacy)).toEqual({ kind: "base", plan: "team", interval: "month" });
    // A deployment that only has the old variable cannot sell the new plans.
    expect(pricesConfigured(legacy)).toBe(false);
    expect(pricesConfigured(ENV)).toBe(true);
  });

  it("reads pricing v1's `hosted` plan as Team", () => {
    expect(normalisePlan("hosted")).toBe("team");
    expect(normalisePlan("team")).toBe("team");
    expect(normalisePlan("nonsense")).toBe("free");
    expect(normalisePlan(undefined, "self_hosted")).toBe("self_hosted");
    expect(isPaidPlan("hosted")).toBe(false);
  });
});

describe("describePlan", () => {
  it("gives the pricing cards one source of truth", () => {
    const [free, team, business] = describeHostedPlans(ENV);
    expect(free).toMatchObject({ plan: "free", label: "Free", prices: null, certInvoiceUsd: null, seatPrices: null });
    expect(team).toMatchObject({ plan: "team", prices: { month: 15, year: 150 }, certInvoiceUsd: 1, seatPrices: null });
    expect(business).toMatchObject({ plan: "business", prices: { month: 49, year: 490 }, certInvoiceUsd: null, seatPrices: { month: 2, year: 20 } });
    expect(describePlan("self_hosted", ENV)).toMatchObject({ label: "Self-hosted", prices: null });
  });
});
