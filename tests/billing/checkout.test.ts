import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";
import { parseForm, planSubscriptionFixture, stripeStub, subscriptionFixture } from "./stub";

vi.mock("../../db", () => ({ db: fakeDb }));

const { STRIPE_API_VERSION, StripeClient, StripeError, encodeForm, redactKey } = await import("../../server/billing/stripe");
const {
  checkoutParams, checkoutLineItems, changePlanParams, createCheckoutSession, createPortalSession, ensureCustomer, ownerEmail,
  orgSeatUsage, syncOrgFromStripe, requireStripe, requirePlanPriceId,
} = await import("../../server/billing/service");

const ORG_ID = 4;
/**
 * The eight live prices, as the hosted deployment configures them. `STRIPE_PRICE_ID`
 * is deliberately absent here — its own test below proves the fallback.
 */
const ENV = {
  PTD_HOSTED: "1",
  PTD_PUBLIC_URL: "https://ptd.danimoya.com",
  STRIPE_PRICE_TEAM_MONTHLY: "price_team_m",
  STRIPE_PRICE_TEAM_YEARLY: "price_team_y",
  STRIPE_PRICE_BUSINESS_MONTHLY: "price_bus_m",
  STRIPE_PRICE_BUSINESS_YEARLY: "price_bus_y",
  STRIPE_PRICE_SEAT_MONTHLY: "price_seat_m",
  STRIPE_PRICE_SEAT_YEARLY: "price_seat_y",
  STRIPE_PRICE_CERT_INVOICE: "price_cert",
  STRIPE_PRICE_AI_USAGE: "price_ai",
} as unknown as NodeJS.ProcessEnv;

function client(stub: ReturnType<typeof stripeStub>) {
  return new StripeClient({ secretKey: "sk_test_abcdefgh1234", apiBase: "https://api.stripe.test", fetchImpl: stub.fetchImpl });
}

beforeEach(() => {
  fakeDb.reset().setOrg({ id: ORG_ID, name: "Atelier 14", plan: "free" });
});

describe("encodeForm", () => {
  it("flattens nested objects and arrays into Stripe's bracket notation", () => {
    const encoded = encodeForm({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], metadata: { orgId: "4" } });
    expect(parseForm(encoded)).toEqual({
      mode: "subscription",
      "line_items[0][price]": "price_1",
      "line_items[0][quantity]": "1",
      "metadata[orgId]": "4",
    });
  });

  it("sends booleans as true/false and drops undefined and null keys", () => {
    expect(parseForm(encodeForm({ allow_promotion_codes: true, automatic_tax: { enabled: false }, nope: undefined, nada: null }))).toEqual({
      allow_promotion_codes: "true",
      "automatic_tax[enabled]": "false",
    });
  });

  it("percent-encodes values, so a URL survives round-tripping", () => {
    const raw = encodeForm({ success_url: "https://x.test/org/billing?tab=billing&checkout=success" });
    expect(raw).not.toContain("&checkout");
    expect(parseForm(raw).success_url).toBe("https://x.test/org/billing?tab=billing&checkout=success");
  });
});

describe("checkoutLineItems", () => {
  const items = (over: Record<string, unknown> = {}) =>
    checkoutLineItems({ orgId: ORG_ID, customerId: "cus_1", plan: "team", interval: "month", env: ENV, ...over } as never);

  it("sells Team monthly as the flat price plus the two meters", () => {
    expect(items()).toEqual([
      { price: "price_team_m", quantity: 1 },
      // No quantity on a metered price: usage arrives as meter events.
      { price: "price_cert" },
      { price: "price_ai" },
    ]);
  });

  it("sells the yearly prices — two months free — off the same call", () => {
    expect(items({ interval: "year" })[0]).toEqual({ price: "price_team_y", quantity: 1 });
    expect(items({ plan: "business", interval: "year" })[0]).toEqual({ price: "price_bus_y", quantity: 1 });
  });

  it("adds the seat price on Business, with the overage as its quantity", () => {
    expect(items({ plan: "business", seatQuantity: 12 })).toEqual([
      { price: "price_bus_m", quantity: 1 },
      { price: "price_seat_m", quantity: 12 },
      { price: "price_cert" },
      { price: "price_ai" },
    ]);
    expect(items({ plan: "business", interval: "year", seatQuantity: 4 })[1]).toEqual({ price: "price_seat_y", quantity: 4 });
  });

  it("leaves the seat line out when there is no overage — Stripe will not take a zero", () => {
    expect(items({ plan: "business", seatQuantity: 0 }).map((i) => i.price)).toEqual(["price_bus_m", "price_cert", "price_ai"]);
    // And never on Team, whose ten seats are a limit rather than a meter.
    expect(items({ plan: "team", seatQuantity: 99 }).map((i) => i.price)).toEqual(["price_team_m", "price_cert", "price_ai"]);
  });

  it("refuses to build a session for a plan this deployment has no price for", () => {
    expect(() => checkoutLineItems({ orgId: ORG_ID, customerId: "cus_1", plan: "business", interval: "month", env: {} as NodeJS.ProcessEnv })).toThrow(
      /STRIPE_PRICE_BUSINESS_MONTHLY/,
    );
  });

  it("still honours STRIPE_PRICE_ID as Team monthly, for a deployment from pricing v1", () => {
    const legacy = { STRIPE_PRICE_ID: "price_test_15" } as unknown as NodeJS.ProcessEnv;
    expect(checkoutLineItems({ orgId: ORG_ID, customerId: "cus_1", plan: "team", interval: "month", env: legacy })).toEqual([
      { price: "price_test_15", quantity: 1 },
    ]);
  });
});

describe("checkoutParams", () => {
  const params = (over: Record<string, unknown> = {}) =>
    checkoutParams({ orgId: ORG_ID, customerId: "cus_1", plan: "team", interval: "month", env: ENV, ...over } as never);

  it("is a subscription session for one organization, with promotion codes open", () => {
    expect(params()).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      client_reference_id: "4",
      line_items: [{ price: "price_team_m", quantity: 1 }, { price: "price_cert" }, { price: "price_ai" }],
      // FOUNDING is a promotion code on the coupon, redeemed here rather than applied by PTD.
      allow_promotion_codes: true,
      automatic_tax: { enabled: false },
      subscription_data: { metadata: { orgId: "4", product: "ptd-hosted", plan: "team", interval: "month" } },
      metadata: { orgId: "4", plan: "team", interval: "month" },
    });
  });

  it("never pins payment_method_types (dynamic payment methods stay on)", () => {
    expect(params()).not.toHaveProperty("payment_method_types");
  });

  it("keeps Stripe's {CHECKOUT_SESSION_ID} template literal in success_url", () => {
    const p = params();
    expect(p.success_url).toBe("https://ptd.danimoya.com/org/billing?tab=billing&checkout=success&plan=team&session_id={CHECKOUT_SESSION_ID}");
    expect(p.cancel_url).toBe("https://ptd.danimoya.com/org/billing?tab=billing&checkout=cancelled");
  });

  it("survives form encoding with the template intact", () => {
    expect(parseForm(encodeForm(params())).success_url).toContain("{CHECKOUT_SESSION_ID}");
  });
});

describe("createCheckoutSession", () => {
  it("POSTs the session to Stripe with the pinned version and bearer auth, and returns the URL", async () => {
    const stub = stripeStub();
    const res = await createCheckoutSession(client(stub), { orgId: ORG_ID, customerId: "cus_1", plan: "team", interval: "month", env: ENV });

    expect(res).toEqual({ id: "cs_test_stub", url: "https://checkout.stripe.com/c/pay/cs_test_stub" });
    const call = stub.callsTo("/v1/checkout/sessions")[0];
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer sk_test_abcdefgh1234");
    expect(call.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.body).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      client_reference_id: "4",
      "line_items[0][price]": "price_team_m",
      "line_items[0][quantity]": "1",
      "line_items[1][price]": "price_cert",
      "line_items[2][price]": "price_ai",
      allow_promotion_codes: "true",
      "automatic_tax[enabled]": "false",
      "subscription_data[metadata][orgId]": "4",
    });
    expect(Object.keys(call.body).some((k) => k.startsWith("payment_method_types"))).toBe(false);
  });

  it("surfaces a Stripe error instead of returning a broken URL", async () => {
    const failing = new StripeClient({
      secretKey: "sk_test_x",
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "No such price", code: "resource_missing" } }) }) as never,
    });
    await expect(createCheckoutSession(failing, { orgId: ORG_ID, customerId: "cus_1", plan: "team", interval: "month", env: ENV })).rejects.toThrow(
      /No such price/,
    );
  });

  it("sends a Business/month session with the seat overage on the wire", async () => {
    const stub = stripeStub();
    await createCheckoutSession(client(stub), { orgId: ORG_ID, customerId: "cus_1", plan: "business", interval: "month", seatQuantity: 7, env: ENV });
    expect(stub.callsTo("/v1/checkout/sessions")[0].body).toMatchObject({
      "line_items[0][price]": "price_bus_m",
      "line_items[0][quantity]": "1",
      "line_items[1][price]": "price_seat_m",
      "line_items[1][quantity]": "7",
      "line_items[2][price]": "price_cert",
      "line_items[3][price]": "price_ai",
      "metadata[plan]": "business",
      "metadata[interval]": "month",
    });
    expect(Object.keys(stub.callsTo("/v1/checkout/sessions")[0].body)).not.toContain("line_items[2][quantity]");
  });
});

describe("changePlanParams", () => {
  it("replaces the base item in place and prorates, rather than starting a second subscription", () => {
    const params = changePlanParams({
      plan: "business",
      interval: "month",
      items: { base: "si_base", cert: "si_cert", ai: "si_ai" },
      seatQuantity: 3,
      env: ENV,
    });
    expect(params.proration_behavior).toBe("create_prorations");
    expect(params.items).toEqual([
      { id: "si_base", price: "price_bus_m", quantity: 1 },
      { price: "price_seat_m", quantity: 3 },
      { id: "si_cert", price: "price_cert" },
      { id: "si_ai", price: "price_ai" },
    ]);
  });

  it("deletes the seat item on the way down to Team — nothing else stops it billing", () => {
    const params = changePlanParams({ plan: "team", interval: "year", items: { base: "si_base", seat: "si_seat" }, env: ENV });
    expect(params.items).toEqual([
      { id: "si_base", price: "price_team_y", quantity: 1 },
      { id: "si_seat", deleted: true },
      { price: "price_cert" },
      { price: "price_ai" },
    ]);
  });

  it("moves the meters to the new interval too", () => {
    const params = changePlanParams({ plan: "business", interval: "year", items: { base: "si_base", seat: "si_seat" }, seatQuantity: 5, env: ENV });
    expect(params.items).toEqual([
      { id: "si_base", price: "price_bus_y", quantity: 1 },
      { id: "si_seat", price: "price_seat_y", quantity: 5 },
      { price: "price_cert" },
      { price: "price_ai" },
    ]);
  });
});

describe("ensureCustomer", () => {
  it("creates the customer with the owner's email and the org in metadata, then stores the id", async () => {
    const stub = stripeStub({ newCustomerId: "cus_created" });
    const org = { id: ORG_ID, name: "Atelier 14", plan: "free" as const, stripeCustomerId: null, stripeSubscriptionId: null };

    const id = await ensureCustomer(client(stub), org, { email: "elena@atelier14.demo" });

    expect(id).toBe("cus_created");
    const call = stub.callsTo("/v1/customers")[0];
    expect(call.body).toMatchObject({ email: "elena@atelier14.demo", name: "Atelier 14", "metadata[orgId]": "4", "metadata[product]": "ptd" });
    expect(call.headers["idempotency-key"]).toBe("ptd-customer-org-4");
    expect(fakeDb.updates).toEqual([{ table: "organizations", values: { stripeCustomerId: "cus_created" } }]);
  });

  it("reuses a stored customer without creating a second one", async () => {
    const stub = stripeStub({ customers: { cus_known: { id: "cus_known", object: "customer" } } });
    const org = { id: ORG_ID, name: "A", plan: "free" as const, stripeCustomerId: "cus_known", stripeSubscriptionId: null };

    expect(await ensureCustomer(client(stub), org, { email: "e@x.test" })).toBe("cus_known");
    expect(stub.callsTo("/v1/customers")).toHaveLength(0);
    expect(fakeDb.updates).toHaveLength(0);
  });

  it("replaces a customer Stripe no longer has (deleted in the dashboard)", async () => {
    const stub = stripeStub({ newCustomerId: "cus_fresh" });
    const org = { id: ORG_ID, name: "A", plan: "free" as const, stripeCustomerId: "cus_gone", stripeSubscriptionId: null };

    expect(await ensureCustomer(client(stub), org, { email: "e@x.test" })).toBe("cus_fresh");
  });
});

describe("createPortalSession", () => {
  it("asks for a portal session that returns to the billing tab", async () => {
    const stub = stripeStub();
    const res = await createPortalSession(client(stub), { customerId: "cus_1", env: ENV });

    expect(res.url).toBe("https://billing.stripe.com/p/session/stub");
    expect(stub.callsTo("/v1/billing_portal/sessions")[0].body).toEqual({
      customer: "cus_1",
      return_url: "https://ptd.danimoya.com/org/billing?tab=billing&portal=return",
    });
  });
});

describe("syncOrgFromStripe", () => {
  it("resolves the subscription from the Checkout Session id and applies it", async () => {
    const stub = stripeStub({
      subscriptions: { sub_sync: subscriptionFixture({ id: "sub_sync", customer: "cus_sync" }) },
      checkoutSessions: { cs_done: { id: "cs_done", client_reference_id: String(ORG_ID), customer: "cus_sync", subscription: "sub_sync", status: "complete", payment_status: "paid" } },
    });

    const applied = await syncOrgFromStripe(client(stub), ORG_ID, { sessionId: "cs_done" });

    expect(applied).toMatchObject({ plan: "team", status: "active", cancelAtPeriodEnd: false });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "team", stripeSubscriptionId: "sub_sync", stripeCustomerId: "cus_sync" });
  });

  it("ignores a session that belongs to another organization", async () => {
    const stub = stripeStub({
      subscriptions: { sub_other: subscriptionFixture({ id: "sub_other" }) },
      checkoutSessions: { cs_other: { id: "cs_other", client_reference_id: "999", customer: "cus_other", subscription: "sub_other" } },
    });

    expect(await syncOrgFromStripe(client(stub), ORG_ID, { sessionId: "cs_other" })).toBeNull();
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "free", stripeSubscriptionId: null });
  });

  it("falls back to the customer's subscription list when no id is on file", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "free", stripeCustomerId: "cus_list", stripeSubscriptionId: null });
    const stub = stripeStub({ subscriptions: { sub_listed: subscriptionFixture({ id: "sub_listed", customer: "cus_list" }) } });

    const applied = await syncOrgFromStripe(client(stub), ORG_ID);

    expect(applied).toMatchObject({ plan: "team" });
    expect(stub.callsTo("/v1/subscriptions")[0].body).toMatchObject({ customer: "cus_list", status: "all", limit: "10" });
  });

  it("returns null when Stripe has nothing for the org", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "free", stripeCustomerId: null, stripeSubscriptionId: null });
    expect(await syncOrgFromStripe(client(stripeStub()), ORG_ID)).toBeNull();
  });
});

describe("org helpers", () => {
  it("prefers a human owner's email over an agent owner's", async () => {
    fakeDb.setMembers([
      { userId: 1, role: "owner", isAgent: true, email: "agent_bot@agents.ptd.local" },
      { userId: 2, role: "owner", isAgent: false, email: "elena@atelier14.demo" },
    ]);
    expect(await ownerEmail(ORG_ID, "fallback@x.test")).toBe("elena@atelier14.demo");
  });

  it("falls back to the caller's own address when the org has no owner row", async () => {
    fakeDb.setMembers([]);
    expect(await ownerEmail(ORG_ID, "fallback@x.test")).toBe("fallback@x.test");
  });

  it("counts humans and agents as one seat each", async () => {
    fakeDb.setMembers([
      { userId: 1, isAgent: false }, { userId: 2, isAgent: false }, { userId: 3, isAgent: true },
    ]);
    expect(await orgSeatUsage(ORG_ID)).toEqual({ members: 3, humans: 2, agents: 1 });
  });
});

describe("configuration", () => {
  it("refuses to build a client or read a price without the env", () => {
    expect(() => requireStripe({} as NodeJS.ProcessEnv)).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => requirePlanPriceId("team", "month", {} as NodeJS.ProcessEnv)).toThrow(/STRIPE_PRICE_TEAM_MONTHLY/);
    expect(requirePlanPriceId("business", "year", ENV)).toBe("price_bus_y");
  });

  it("redacts keys for logs", () => {
    expect(redactKey("sk_test_abcdefgh1234")).toBe("sk_test_…1234");
    expect(redactKey(undefined)).toBe("(unset)");
    expect(redactKey("sk_test_abcdefgh1234")).not.toContain("abcdefgh");
  });

  it("does not expose the secret key on the client object", () => {
    const c = client(stripeStub());
    expect(JSON.stringify(c)).not.toContain("sk_test_abcdefgh1234");
    expect(Object.keys(c)).not.toContain("secretKey");
  });

  it("wraps a transport failure as a StripeError rather than leaking the raw throw", async () => {
    const c = new StripeClient({ secretKey: "sk_test_x", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    await expect(c.get("/v1/subscriptions/sub_1")).rejects.toBeInstanceOf(StripeError);
  });
});
