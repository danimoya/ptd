import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";
import { eventFixture, planSubscriptionFixture, stripeStub, subscriptionFixture } from "./stub";

vi.mock("../../db", () => ({ db: fakeDb }));

const { handleStripeEvent, resetProcessedEvents } = await import("../../server/billing/webhook");
const { subscriptionHealth, subscriptionShape, subscriptionPeriodEnd } = await import("../../server/billing/service");
const { StripeClient } = await import("../../server/billing/stripe");

const ORG_ID = 7;

function client(stub: ReturnType<typeof stripeStub>) {
  return new StripeClient({ secretKey: "sk_test_stub", apiBase: "https://api.stripe.test", fetchImpl: stub.fetchImpl });
}

beforeEach(() => {
  resetProcessedEvents();
  fakeDb.reset().setOrg({ id: ORG_ID, name: "Atelier 14", plan: "free" });
});

afterEach(() => vi.restoreAllMocks());

describe("subscriptionHealth", () => {
  it("says whether a subscription is paid for — never which plan it is", () => {
    expect(subscriptionHealth("active")).toEqual({ healthy: true, pastDue: false });
    expect(subscriptionHealth("trialing")).toEqual({ healthy: true, pastDue: false });
    // Still paid-for while Stripe dunns: locking the org out loses the customer.
    expect(subscriptionHealth("past_due")).toEqual({ healthy: true, pastDue: true });
    expect(subscriptionHealth("canceled")).toEqual({ healthy: false, pastDue: false });
    expect(subscriptionHealth("unpaid")).toEqual({ healthy: false, pastDue: false });
    expect(subscriptionHealth("incomplete_expired")).toEqual({ healthy: false, pastDue: false });
    // Mid-flight: leave the plan alone rather than guess.
    expect(subscriptionHealth("incomplete").healthy).toBeNull();
    expect(subscriptionHealth("paused").healthy).toBeNull();
    expect(subscriptionHealth(undefined).healthy).toBeNull();
  });
});

describe("subscriptionShape", () => {
  const env = { STRIPE_PRICE_SEAT_MONTHLY: "price_seat_m" } as unknown as NodeJS.ProcessEnv;

  it("reads the plan and interval off the base price's lookup key", () => {
    expect(subscriptionShape(planSubscriptionFixture("team", "month") as never, env)).toMatchObject({ plan: "team", interval: "month" });
    expect(subscriptionShape(planSubscriptionFixture("team", "year") as never, env)).toMatchObject({ plan: "team", interval: "year" });
    expect(subscriptionShape(planSubscriptionFixture("business", "month") as never, env)).toMatchObject({ plan: "business", interval: "month" });
    expect(subscriptionShape(planSubscriptionFixture("business", "year") as never, env)).toMatchObject({ plan: "business", interval: "year" });
  });

  it("names each item by what it bills for, and reads the seat quantity", () => {
    const shape = subscriptionShape(planSubscriptionFixture("business", "month", { seats: 7 }) as never, env);
    expect(shape.items).toEqual({ base: "si_base", seat: "si_seat", cert: "si_cert", ai: "si_ai" });
    expect(shape.seatQuantity).toBe(7);
  });

  it("finds no plan in a subscription whose prices are not ours", () => {
    expect(subscriptionShape(subscriptionFixture() as never, {} as NodeJS.ProcessEnv).plan).toBeNull();
  });
});

describe("subscriptionPeriodEnd", () => {
  it("prefers the subscription item's period end (basil and later)", () => {
    const iso = subscriptionPeriodEnd(subscriptionFixture() as never);
    expect(iso).toBe(new Date(Date.UTC(2026, 9, 19, 12, 0, 0)).toISOString());
  });

  it("falls back to the legacy top-level field, and tolerates neither", () => {
    expect(subscriptionPeriodEnd({ id: "sub_x", current_period_end: 1_760_000_000 })).toBe(new Date(1_760_000_000_000).toISOString());
    expect(subscriptionPeriodEnd({ id: "sub_x" })).toBeNull();
  });
});

describe("checkout.session.completed", () => {
  it("stores the customer and subscription ids and reads the plan off the price", async () => {
    const stub = stripeStub({ subscriptions: { sub_new: planSubscriptionFixture("team", "month", { id: "sub_new", customer: "cus_new" }) } });
    const event = eventFixture("checkout.session.completed", {
      id: "cs_test_1",
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      client_reference_id: String(ORG_ID),
      customer: "cus_new",
      subscription: "sub_new",
    });

    const res = await handleStripeEvent(event as never, { client: client(stub) });

    expect(res).toMatchObject({ received: true, handled: true, orgId: ORG_ID, plan: "team", interval: "month" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "team", stripeCustomerId: "cus_new", stripeSubscriptionId: "sub_new" });
    expect(stub.callsTo("/v1/subscriptions/sub_new")).toHaveLength(1);
    // The item ids and the period are kept for the plan change and the tab.
    expect(fakeDb.billingConfig(ORG_ID)).toMatchObject({ interval: "month", items: { base: "si_base", cert: "si_cert", ai: "si_ai" }, status: "active" });
  });

  it("puts a business/yearly checkout on business, with the interval recorded", async () => {
    const stub = stripeStub({ subscriptions: { sub_b: planSubscriptionFixture("business", "year", { id: "sub_b", customer: "cus_b", seats: 3 }) } });
    const event = eventFixture("checkout.session.completed", {
      id: "cs_bus", client_reference_id: String(ORG_ID), customer: "cus_b", subscription: "sub_b",
    });

    const res = await handleStripeEvent(event as never, { client: client(stub) });

    expect(res).toMatchObject({ handled: true, plan: "business", interval: "year" });
    expect(fakeDb.billingConfig(ORG_ID)).toMatchObject({ interval: "year", seatQuantity: 3, items: { seat: "si_seat" } });
  });

  it("is idempotent: the same event id a second time writes nothing", async () => {
    const stub = stripeStub({ subscriptions: { sub_new: planSubscriptionFixture("team", "month", { id: "sub_new" }) } });
    const event = eventFixture("checkout.session.completed", {
      id: "cs_test_2", client_reference_id: String(ORG_ID), customer: "cus_new", subscription: "sub_new",
    }, "evt_dupe");

    await handleStripeEvent(event as never, { client: client(stub) });
    const writes = fakeDb.updates.length;
    const second = await handleStripeEvent(event as never, { client: client(stub) });

    expect(second).toMatchObject({ handled: true, duplicate: true });
    expect(fakeDb.updates).toHaveLength(writes);
  });

  it("re-running the same state under a fresh event id is also a no-op write", async () => {
    const stub = stripeStub({ subscriptions: { sub_new: planSubscriptionFixture("team", "month", { id: "sub_new", customer: "cus_new" }) } });
    const body = { id: "cs_x", client_reference_id: String(ORG_ID), customer: "cus_new", subscription: "sub_new" };

    await handleStripeEvent(eventFixture("checkout.session.completed", body, "evt_a") as never, { client: client(stub) });
    const writes = fakeDb.updates.length;
    await handleStripeEvent(eventFixture("checkout.session.completed", body, "evt_b") as never, { client: client(stub) });

    expect(fakeDb.updates).toHaveLength(writes);
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "team", stripeSubscriptionId: "sub_new" });
  });

  it("unlocks the org even when the follow-up Stripe read fails", async () => {
    const stub = stripeStub({}); // no subscription → 404 on the read
    const event = eventFixture("checkout.session.completed", {
      id: "cs_test_3", client_reference_id: String(ORG_ID), customer: "cus_c", subscription: "sub_missing",
    });

    const res = await handleStripeEvent(event as never, { client: client(stub) });

    // Stripe unreachable: the session completing is proof enough to unlock the org,
    // and Team is the plan to assume when nothing says otherwise.
    expect(res).toMatchObject({ handled: true, plan: "team" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "team", stripeSubscriptionId: "sub_missing", stripeCustomerId: "cus_c" });
  });

  it("does nothing when no organization can be resolved", async () => {
    fakeDb.queueEmpty("organizations", 4);
    const stub = stripeStub({ subscriptions: { sub_z: subscriptionFixture({ id: "sub_z" }) } });
    const event = eventFixture("checkout.session.completed", { id: "cs_test_4", customer: "cus_unknown", subscription: "sub_z" });

    const res = await handleStripeEvent(event as never, { client: client(stub) });

    expect(res).toMatchObject({ handled: false, note: "no organization matched the session" });
    expect(fakeDb.updates).toHaveLength(0);
  });
});

describe("customer.subscription.*", () => {
  beforeEach(() => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "team", stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x" });
  });

  it("keeps a past_due org on its plan and says so in the log", async () => {
    const event = eventFixture("customer.subscription.updated", planSubscriptionFixture("team", "month", { id: "sub_x", status: "past_due", customer: "cus_x" }));

    const res = await handleStripeEvent(event as never, { client: client(stripeStub()) });

    expect(res).toMatchObject({ handled: true, plan: "team" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "team", stripeSubscriptionId: "sub_x" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("moves the org when the base price changes — team → business, and back", async () => {
    const up = eventFixture("customer.subscription.updated", planSubscriptionFixture("business", "month", { id: "sub_x", customer: "cus_x" }), "evt_up");
    expect(await handleStripeEvent(up as never, { client: client(stripeStub()) })).toMatchObject({ handled: true, plan: "business" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "business" });

    const down = eventFixture("customer.subscription.updated", planSubscriptionFixture("team", "year", { id: "sub_x", customer: "cus_x" }), "evt_down");
    expect(await handleStripeEvent(down as never, { client: client(stripeStub()) })).toMatchObject({ handled: true, plan: "team", interval: "year" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "team" });
  });

  it("reads a pricing-v1 `hosted` row as team rather than demoting it to free", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "hosted", stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x" });
    const event = eventFixture("customer.subscription.updated", subscriptionFixture({ id: "sub_x", status: "active", customer: "cus_x" }), "evt_legacy");
    const res = await handleStripeEvent(event as never, { client: client(stripeStub()) });
    expect(res).toMatchObject({ handled: true, plan: "team" });
  });

  it("drops to free on deletion and forgets the subscription id", async () => {
    fakeDb.setIntegration({ orgId: ORG_ID, kind: "billing", config: { interval: "month", items: { base: "si_base" }, status: "active" } });
    const event = eventFixture("customer.subscription.deleted", planSubscriptionFixture("team", "month", { id: "sub_x", status: "canceled", customer: "cus_x" }));

    const res = await handleStripeEvent(event as never, { client: client(stripeStub()) });

    expect(res).toMatchObject({ handled: true, plan: "free" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "free", stripeSubscriptionId: null, stripeCustomerId: "cus_x" });
    // The items went with the subscription; keeping them would invite a stale update.
    expect(fakeDb.integration("billing", ORG_ID)).toBeUndefined();
  });

  it("drops to free on a canceled update too, and keeps the customer for the next signup", async () => {
    const event = eventFixture("customer.subscription.updated", subscriptionFixture({ id: "sub_x", status: "canceled", customer: "cus_x" }));
    await handleStripeEvent(event as never, { client: client(stripeStub()) });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "free", stripeCustomerId: "cus_x" });
  });

  it("holds the plan for an incomplete subscription instead of guessing", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "free", stripeCustomerId: "cus_x", stripeSubscriptionId: null });
    const event = eventFixture("customer.subscription.created", subscriptionFixture({ id: "sub_i", status: "incomplete", customer: "cus_x" }));

    const res = await handleStripeEvent(event as never, { client: client(stripeStub()) });

    expect(res).toMatchObject({ handled: true, plan: "free" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "free" });
  });

  it("records cancel_at_period_end while keeping access until the period ends", async () => {
    const event = eventFixture("customer.subscription.updated", planSubscriptionFixture("team", "month", { id: "sub_x", status: "active", customer: "cus_x" }) as never);
    (event.data.object as Record<string, unknown>).cancel_at_period_end = true;
    const res = await handleStripeEvent(event as never, { client: client(stripeStub()) });
    expect(res).toMatchObject({ handled: true, plan: "team" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "team" });
    expect(fakeDb.billingConfig(ORG_ID)).toMatchObject({ cancelAtPeriodEnd: true });
  });
});

describe("other events", () => {
  it("logs invoice.payment_failed without changing the plan", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "team", stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x" });
    const event = eventFixture("invoice.payment_failed", { id: "in_1", customer: "cus_x", attempt_count: 2, next_payment_attempt: 1_760_000_000 });

    const res = await handleStripeEvent(event as never, { client: client(stripeStub()) });

    expect(res).toMatchObject({ handled: true, note: "logged" });
    expect(fakeDb.updates).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });

  it("acknowledges an unknown event type and touches nothing", async () => {
    const res = await handleStripeEvent(eventFixture("radar.early_fraud_warning.created", { id: "issfr_1" }) as never, { client: client(stripeStub()) });
    expect(res).toMatchObject({ received: true, handled: false, note: "ignored" });
    expect(fakeDb.updates).toHaveLength(0);
  });

  it("never throws when the handler itself blows up — Stripe must be able to retry", async () => {
    const boom = { get: () => Promise.reject(new Error("nope")) } as never;
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "free" });
    const event = eventFixture("customer.subscription.updated", { id: "sub_err", status: "active", customer: "cus_x", get metadata(): never { throw new Error("kaboom"); } });

    const res = await handleStripeEvent(event as never, { client: boom });

    expect(res).toMatchObject({ received: true, handled: false });
    expect(res.note).toMatch(/retry/);
  });
});
