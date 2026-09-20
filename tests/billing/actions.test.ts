import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";
import { planSubscriptionFixture, stripeStub } from "./stub";

vi.mock("../../db", () => ({ db: fakeDb }));

await import("../../server/actions/billing");
const { runAction, ActionError, getAction } = await import("../../server/actions/registry");

const ORG_ID = 4;
const ctx = (role: "owner" | "admin" | "manager" | "member" = "owner") => ({
  userId: 1, email: "elena@atelier14.demo", displayName: "Elena", orgId: ORG_ID, role, authType: "human" as const, via: "web" as const,
});

const REAL_ENV = { ...process.env };
let stub: ReturnType<typeof stripeStub>;
let fetchSpy: ReturnType<typeof vi.fn>;

/** The hosted deployment's environment: eight prices, two meters, one coupon. */
function hostedEnv() {
  process.env.PTD_HOSTED = "1";
  process.env.PTD_HOSTED_MAX_MEMBERS = "100";
  process.env.STRIPE_SECRET_KEY = "sk_test_stub";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_API_BASE = "https://api.stripe.test";
  process.env.PTD_PUBLIC_URL = "https://ptd.danimoya.com";
  process.env.STRIPE_PRICE_TEAM_MONTHLY = "price_team_m";
  process.env.STRIPE_PRICE_TEAM_YEARLY = "price_team_y";
  process.env.STRIPE_PRICE_BUSINESS_MONTHLY = "price_bus_m";
  process.env.STRIPE_PRICE_BUSINESS_YEARLY = "price_bus_y";
  process.env.STRIPE_PRICE_SEAT_MONTHLY = "price_seat_m";
  process.env.STRIPE_PRICE_SEAT_YEARLY = "price_seat_y";
  process.env.STRIPE_PRICE_CERT_INVOICE = "price_cert";
  process.env.STRIPE_PRICE_AI_USAGE = "price_ai";
  process.env.STRIPE_METER_CERT_INVOICE = "ptd_certified_invoices";
  process.env.STRIPE_METER_AI_USAGE = "ptd_ai_usage_cents";
  process.env.STRIPE_COUPON_FOUNDING = "ptd-founding-member";
}

/** N humans and M agents in the organization. */
function seats(humans: number, agents = 0) {
  const rows = [
    ...Array.from({ length: humans }, (_, i) => ({ userId: i + 1, role: i === 0 ? "owner" : "member", isAgent: false, email: i === 0 ? "elena@atelier14.demo" : `h${i}@x.test` })),
    ...Array.from({ length: agents }, (_, i) => ({ userId: 1000 + i, isAgent: true })),
  ];
  fakeDb.setMembers(rows);
}

beforeEach(() => {
  fakeDb.reset().setOrg({ id: ORG_ID, name: "Atelier 14", plan: "free" });
  seats(2, 1);
  stub = stripeStub({ subscriptions: { sub_live: planSubscriptionFixture("team", "month", { id: "sub_live", customer: "cus_live", orgId: ORG_ID }) } });
  fetchSpy = vi.fn(stub.fetchImpl as never);
  vi.stubGlobal("fetch", fetchSpy);
  hostedEnv();
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  vi.unstubAllGlobals();
});

describe("role gates", () => {
  it("puts status behind admin and every mutation behind owner", () => {
    expect(getAction("billing.status")?.requiredRole).toBe("admin");
    for (const name of ["billing.checkout", "billing.change_plan", "billing.portal", "billing.sync"]) {
      expect(getAction(name)?.requiredRole).toBe("owner");
    }
  });

  it("refuses a manager reading status and an admin starting checkout", async () => {
    await expect(runAction("billing.status", {}, ctx("manager"))).rejects.toThrow(/requires role admin/);
    await expect(runAction("billing.checkout", { plan: "team" }, ctx("admin"))).rejects.toThrow(/requires role owner/);
  });

  it("audits the three actions that move money or change what is owed", () => {
    for (const name of ["billing.checkout", "billing.change_plan", "billing.portal"]) {
      expect(getAction(name)?.audited).toBe(true);
    }
  });
});

describe("billing.status on free", () => {
  it("reports the plan, the price list, the 3-seat ceiling and the member cap", async () => {
    const res = (await runAction("billing.status", {}, ctx("admin"))) as Record<string, any>;
    expect(res).toMatchObject({
      hosted: true,
      plan: "free",
      planLabel: "Free",
      interval: null,
      prices: { team: { month: 15, year: 150 }, business: { month: 49, year: 490 } },
      seatPrices: { month: 2, year: 20 },
      certInvoiceUsd: 1,
      aiMarkup: 1.2,
      limits: { humanSeats: 3, totalMembers: 3, includedHumanSeats: 3, billableSeats: false, members: 3 },
      usage: { humans: 2, agents: 1, total: 3, seatOverage: 0, seatCostUsd: 0 },
      subscription: null,
      portalAvailable: false,
      configured: true,
      // Redeemed at Checkout, and only while the organization has not bought yet.
      foundingCode: "FOUNDING",
    });
    // Nothing to read from Stripe for an org with no subscription.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("carries the three hosted plans, so the cards are drawn from the server's own table", async () => {
    const res = (await runAction("billing.status", {}, ctx("admin"))) as Record<string, any>;
    expect(res.plans.map((p: any) => p.plan)).toEqual(["free", "team", "business"]);
    expect(res.plans[1]).toMatchObject({ label: "Team", prices: { month: 15, year: 150 }, limits: { humanSeats: 10, totalMembers: 100 } });
    expect(res.plans[2]).toMatchObject({ label: "Business", limits: { humanSeats: null, includedHumanSeats: 50, totalMembers: 100, billableSeats: true } });
    expect(res.features).toEqual(["surfaces"]);
  });

  it("says the deployment is unconfigured when a plan price is missing, rather than pretending checkout works", async () => {
    delete process.env.STRIPE_PRICE_BUSINESS_YEARLY;
    expect((await runAction("billing.status", {}, ctx("admin"))) as Record<string, any>).toMatchObject({ configured: false });
  });
});

describe("billing.status on a paid plan", () => {
  it("reads the live subscription, the interval and the item ids", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "team", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live" });
    seats(4, 6);

    const res = (await runAction("billing.status", {}, ctx("admin"))) as Record<string, any>;

    expect(res).toMatchObject({
      plan: "team",
      interval: "month",
      limits: { humanSeats: 10, totalMembers: 100, members: null },
      usage: { humans: 4, agents: 6, total: 10, seatOverage: 0 },
      portalAvailable: true,
      // Already subscribed: the founding code belongs on a first purchase only.
      foundingCode: null,
    });
    expect(res.subscription).toMatchObject({
      id: "sub_live",
      status: "active",
      cancelAtPeriodEnd: false,
      pastDue: false,
      currentPeriodEnd: new Date(Date.UTC(2026, 9, 19, 12, 0, 0)).toISOString(),
      items: { base: "si_base", cert: "si_cert", ai: "si_ai" },
    });
  });

  it("prices the seat overage on Business: 62 humans is 12 billable seats", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "business", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_bus" });
    fakeDb.setIntegration({ orgId: ORG_ID, kind: "billing", config: { interval: "month", items: { base: "si_base", seat: "si_seat" }, status: "active", seatQuantity: 12 } });
    seats(62, 5);
    stub.subscriptions.sub_bus = planSubscriptionFixture("business", "month", { id: "sub_bus", customer: "cus_live", seats: 12 });

    const res = (await runAction("billing.status", {}, ctx("admin"))) as Record<string, any>;

    expect(res).toMatchObject({
      plan: "business",
      limits: { humanSeats: null, includedHumanSeats: 50, totalMembers: 100 },
      usage: { humans: 62, agents: 5, total: 67, seatOverage: 12, seatCostUsd: 24 },
    });
    expect(res.subscription.seatQuantity).toBe(12);
  });

  it("reports the add-ons this period: invoices issued and AI cents at cost plus 20%", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "team", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live" });
    seats(3);
    fakeDb.setInvoices([{ orgId: ORG_ID }, { orgId: ORG_ID }, { orgId: ORG_ID }]);
    fakeDb.setAiUsage([{ orgId: ORG_ID, costUsd: 0.01 }, { orgId: ORG_ID, costUsd: 0.05 }]);

    const res = (await runAction("billing.status", {}, ctx("admin"))) as Record<string, any>;

    // 3 invoices × $1 on Team; (1c + 5c) × 1.2 = 1 + 6 = 7 cents.
    expect(res.addons).toMatchObject({ certifiedInvoices: 3, certifiedInvoicesUsd: 3, aiCents: 7, aiCalls: 2 });
    expect(res.addons.since).toBe(new Date(Date.UTC(2026, 8, 19, 12, 0, 0)).toISOString());
  });

  it("charges nothing for certified invoices on Business, where they are included", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "business", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_bus" });
    stub.subscriptions.sub_bus = planSubscriptionFixture("business", "month", { id: "sub_bus", customer: "cus_live" });
    seats(3);
    fakeDb.setInvoices([{ orgId: ORG_ID }, { orgId: ORG_ID }]);
    const res = (await runAction("billing.status", {}, ctx("admin"))) as Record<string, any>;
    expect(res.addons).toMatchObject({ certifiedInvoices: 2, certifiedInvoicesUsd: 0 });
  });

  it("still renders when Stripe is unreachable, with a warning instead of a blank tab", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "team", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_missing" });
    fakeDb.setIntegration({ orgId: ORG_ID, kind: "billing", config: { interval: "year", items: { base: "si_base" }, status: "active", currentPeriodEnd: "2027-01-01T00:00:00.000Z" } });
    seats(2);

    const res = (await runAction("billing.status", {}, ctx("admin"))) as Record<string, any>;

    expect(res.plan).toBe("team");
    expect(res.interval).toBe("year");
    expect(res.subscription).toMatchObject({ status: "active", currentPeriodEnd: "2027-01-01T00:00:00.000Z" });
    expect(res.warning).toMatch(/No such subscription/);
  });
});

describe("billing.checkout", () => {
  it("sells Team monthly: customer, session, and the URL for the browser", async () => {
    const res = (await runAction("billing.checkout", { plan: "team" }, ctx())) as Record<string, any>;

    expect(res).toMatchObject({ hosted: true, url: "https://checkout.stripe.com/c/pay/cs_test_stub", sessionId: "cs_test_stub", plan: "team", interval: "month", priceUsd: 15 });
    expect(stub.callsTo("/v1/customers")[0].body).toMatchObject({ email: "elena@atelier14.demo", "metadata[orgId]": "4" });
    expect(stub.callsTo("/v1/checkout/sessions")[0].body).toMatchObject({
      mode: "subscription",
      client_reference_id: "4",
      "line_items[0][price]": "price_team_m",
      "line_items[0][quantity]": "1",
      "line_items[1][price]": "price_cert",
      "line_items[2][price]": "price_ai",
      allow_promotion_codes: "true",
      cancel_url: "https://ptd.danimoya.com/org/billing?tab=billing&checkout=cancelled",
    });
  });

  it("sells Team yearly — two months free — when the interval says so", async () => {
    const res = (await runAction("billing.checkout", { plan: "team", interval: "year" }, ctx())) as Record<string, any>;
    expect(res).toMatchObject({ plan: "team", interval: "year", priceUsd: 150 });
    expect(stub.callsTo("/v1/checkout/sessions")[0].body["line_items[0][price]"]).toBe("price_team_y");
  });

  it("sells Business with the seat overage already on the session", async () => {
    seats(58, 2);
    const res = (await runAction("billing.checkout", { plan: "business" }, ctx())) as Record<string, any>;
    expect(res).toMatchObject({ plan: "business", interval: "month", seatQuantity: 8, priceUsd: 49 });
    expect(stub.callsTo("/v1/checkout/sessions")[0].body).toMatchObject({
      "line_items[0][price]": "price_bus_m",
      "line_items[1][price]": "price_seat_m",
      "line_items[1][quantity]": "8",
    });
  });

  it("refuses a plan it does not sell", async () => {
    await expect(runAction("billing.checkout", { plan: "enterprise" }, ctx())).rejects.toThrow(/plan/);
  });

  it("sends an already-subscribed org to change_plan instead of selling a second subscription", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "team", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live" });
    await expect(runAction("billing.checkout", { plan: "business" }, ctx())).rejects.toThrow(/billing.change_plan/);
    expect(stub.callsTo("/v1/checkout/sessions")).toHaveLength(0);
  });

  it("turns a missing key into an action error, not a 500", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await expect(runAction("billing.checkout", { plan: "team" }, ctx())).rejects.toThrow(/Billing is not configured/);
  });

  it("turns a Stripe rejection into a conflict with Stripe's own message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "No such price: 'price_team_m'" } }) })));
    const err = await runAction("billing.checkout", { plan: "team" }, ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as InstanceType<typeof ActionError>).code).toBe("conflict");
    expect((err as Error).message).toMatch(/No such price/);
  });
});

describe("billing.change_plan", () => {
  beforeEach(() => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "team", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live" });
    fakeDb.setIntegration({ orgId: ORG_ID, kind: "billing", config: { interval: "month", items: { base: "si_base", cert: "si_cert", ai: "si_ai" }, status: "active" } });
    seats(55, 3);
  });

  it("moves Team → Business in place, prorates, and sets the seat quantity from the roll", async () => {
    const res = (await runAction("billing.change_plan", { plan: "business" }, ctx())) as Record<string, any>;

    expect(res).toMatchObject({ hosted: true, plan: "business", interval: "month", seatQuantity: 5, priceUsd: 49 });
    const call = stub.callsTo("/v1/subscriptions/sub_live")[0];
    expect(call.method).toBe("POST");
    expect(call.body).toMatchObject({
      "items[0][id]": "si_base",
      "items[0][price]": "price_bus_m",
      "items[1][price]": "price_seat_m",
      "items[1][quantity]": "5",
      proration_behavior: "create_prorations",
    });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "business" });
  });

  it("switches the interval to yearly without touching the plan", async () => {
    const res = (await runAction("billing.change_plan", { plan: "team", interval: "year" }, ctx())) as Record<string, any>;
    expect(res).toMatchObject({ plan: "team", interval: "year", priceUsd: 150 });
    expect(stub.callsTo("/v1/subscriptions/sub_live")[0].body["items[0][price]"]).toBe("price_team_y");
  });

  it("refuses a change to what the organization is already on", async () => {
    await expect(runAction("billing.change_plan", { plan: "team", interval: "month" }, ctx())).rejects.toThrow(/already on Team/);
    expect(stub.callsTo("/v1/subscriptions/sub_live")).toHaveLength(0);
  });

  it("sends an organization with no subscription to checkout", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "free" });
    await expect(runAction("billing.change_plan", { plan: "business" }, ctx())).rejects.toThrow(/billing.checkout/);
  });
});

describe("billing.portal", () => {
  it("returns a portal URL for an org that has a customer", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "team", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live" });
    expect(await runAction("billing.portal", {}, ctx())).toEqual({ hosted: true, url: "https://billing.stripe.com/p/session/stub" });
  });

  it("refuses before there is a customer at all", async () => {
    await expect(runAction("billing.portal", {}, ctx())).rejects.toThrow(/No Stripe customer yet/);
  });
});

describe("billing.sync", () => {
  it("applies the subscription behind a Checkout Session id (the success redirect)", async () => {
    stub = stripeStub({
      subscriptions: { sub_live: planSubscriptionFixture("business", "year", { id: "sub_live", customer: "cus_live", seats: 2 }) },
      checkoutSessions: { cs_done: { id: "cs_done", client_reference_id: "4", customer: "cus_live", subscription: "sub_live" } },
    });
    vi.stubGlobal("fetch", vi.fn(stub.fetchImpl as never));

    const res = (await runAction("billing.sync", { sessionId: "cs_done" }, ctx())) as Record<string, any>;

    expect(res).toMatchObject({ hosted: true, synced: true, plan: "business", interval: "year", changed: true });
    expect(res.subscription).toMatchObject({ status: "active", pastDue: false, cancelAtPeriodEnd: false, seatQuantity: 2 });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "business", stripeSubscriptionId: "sub_live" });
    expect(fakeDb.billingConfig(ORG_ID)).toMatchObject({ interval: "year", items: { base: "si_base", seat: "si_seat" } });
  });

  it("answers honestly when Stripe has nothing for the org yet", async () => {
    expect(await runAction("billing.sync", {}, ctx())).toMatchObject({ hosted: true, synced: false, plan: "free", subscription: null });
  });
});

describe("PTD_HOSTED unset (every self-hosted deployment)", () => {
  beforeEach(() => {
    delete process.env.PTD_HOSTED;
    fakeDb.selects = [];
    fakeDb.updates = [];
  });

  it("makes all five actions inert no-ops: no Stripe call, no database read", async () => {
    const args: Record<string, unknown> = { plan: "team" };
    for (const name of ["billing.status", "billing.checkout", "billing.change_plan", "billing.portal", "billing.sync"]) {
      expect(await runAction(name, args, ctx())).toEqual({ hosted: false });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stub.calls).toHaveLength(0);
    expect(fakeDb.selects).toHaveLength(0);
    expect(fakeDb.updates).toHaveLength(0);
  });

  it("stays inert even with Stripe keys present in the environment", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_should_never_be_used";
    expect(await runAction("billing.checkout", { plan: "business" }, ctx())).toEqual({ hosted: false });
    expect(stub.calls).toHaveLength(0);
  });
});
