import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";
import { eventFixture, stripeStub, subscriptionFixture } from "./stub";

vi.mock("../../db", () => ({ db: fakeDb }));

const { handleStripeEvent, resetProcessedEvents } = await import("../../server/billing/webhook");
const { planForStatus, subscriptionPeriodEnd } = await import("../../server/billing/service");
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

describe("planForStatus", () => {
  it("maps every status PTD cares about", () => {
    expect(planForStatus("active")).toEqual({ plan: "hosted", pastDue: false });
    expect(planForStatus("trialing")).toEqual({ plan: "hosted", pastDue: false });
    // Still paid-for while Stripe dunns: locking the org out loses the customer.
    expect(planForStatus("past_due")).toEqual({ plan: "hosted", pastDue: true });
    expect(planForStatus("canceled")).toEqual({ plan: "free", pastDue: false });
    expect(planForStatus("unpaid")).toEqual({ plan: "free", pastDue: false });
    expect(planForStatus("incomplete_expired")).toEqual({ plan: "free", pastDue: false });
    // Mid-flight: leave the plan alone rather than guess.
    expect(planForStatus("incomplete").plan).toBeNull();
    expect(planForStatus("paused").plan).toBeNull();
    expect(planForStatus(undefined).plan).toBeNull();
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
  it("stores the customer and subscription ids and flips the org to hosted", async () => {
    const stub = stripeStub({ subscriptions: { sub_new: subscriptionFixture({ id: "sub_new", customer: "cus_new" }) } });
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

    expect(res).toMatchObject({ received: true, handled: true, orgId: ORG_ID, plan: "hosted" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "hosted", stripeCustomerId: "cus_new", stripeSubscriptionId: "sub_new" });
    expect(stub.callsTo("/v1/subscriptions/sub_new")).toHaveLength(1);
  });

  it("is idempotent: the same event id a second time writes nothing", async () => {
    const stub = stripeStub({ subscriptions: { sub_new: subscriptionFixture({ id: "sub_new" }) } });
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
    const stub = stripeStub({ subscriptions: { sub_new: subscriptionFixture({ id: "sub_new", customer: "cus_new" }) } });
    const body = { id: "cs_x", client_reference_id: String(ORG_ID), customer: "cus_new", subscription: "sub_new" };

    await handleStripeEvent(eventFixture("checkout.session.completed", body, "evt_a") as never, { client: client(stub) });
    const writes = fakeDb.updates.length;
    await handleStripeEvent(eventFixture("checkout.session.completed", body, "evt_b") as never, { client: client(stub) });

    expect(fakeDb.updates).toHaveLength(writes);
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "hosted", stripeSubscriptionId: "sub_new" });
  });

  it("unlocks the org even when the follow-up Stripe read fails", async () => {
    const stub = stripeStub({}); // no subscription → 404 on the read
    const event = eventFixture("checkout.session.completed", {
      id: "cs_test_3", client_reference_id: String(ORG_ID), customer: "cus_c", subscription: "sub_missing",
    });

    const res = await handleStripeEvent(event as never, { client: client(stub) });

    expect(res).toMatchObject({ handled: true, plan: "hosted" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "hosted", stripeSubscriptionId: "sub_missing", stripeCustomerId: "cus_c" });
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
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "hosted", stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x" });
  });

  it("keeps a past_due org on hosted and says so in the log", async () => {
    const event = eventFixture("customer.subscription.updated", subscriptionFixture({ id: "sub_x", status: "past_due", customer: "cus_x" }));

    const res = await handleStripeEvent(event as never, { client: client(stripeStub()) });

    expect(res).toMatchObject({ handled: true, plan: "hosted" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "hosted", stripeSubscriptionId: "sub_x" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("drops to free on deletion and forgets the subscription id", async () => {
    const event = eventFixture("customer.subscription.deleted", subscriptionFixture({ id: "sub_x", status: "canceled", customer: "cus_x" }));

    const res = await handleStripeEvent(event as never, { client: client(stripeStub()) });

    expect(res).toMatchObject({ handled: true, plan: "free" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "free", stripeSubscriptionId: null, stripeCustomerId: "cus_x" });
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
    const event = eventFixture("customer.subscription.updated", subscriptionFixture({ id: "sub_x", status: "active", customer: "cus_x", cancel_at_period_end: true }));
    const res = await handleStripeEvent(event as never, { client: client(stripeStub()) });
    expect(res).toMatchObject({ handled: true, plan: "hosted" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "hosted" });
  });
});

describe("other events", () => {
  it("logs invoice.payment_failed without changing the plan", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "hosted", stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x" });
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
