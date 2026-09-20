/**
 * `syncSeatQuantity` — the one function that turns "who is in the organization" into
 * "what Stripe bills for". It is called from the invitation accept, the agent
 * signup, the member removal and the subscription webhook, all of which are paths
 * that must not fail because Stripe is slow, so the interesting properties here are
 * as much about what it *does not* do as about the update it sends.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";
import { planSubscriptionFixture, stripeStub } from "./stub";

vi.mock("../../db", () => ({ db: fakeDb }));

const { syncSeatQuantity } = await import("../../server/billing/service");
const { StripeClient } = await import("../../server/billing/stripe");

const ORG_ID = 4;
const HOSTED = {
  PTD_HOSTED: "1",
  STRIPE_SECRET_KEY: "sk_test_stub",
  STRIPE_PRICE_SEAT_MONTHLY: "price_seat_m",
  STRIPE_PRICE_SEAT_YEARLY: "price_seat_y",
  STRIPE_PRICE_BUSINESS_MONTHLY: "price_bus_m",
  STRIPE_PRICE_BUSINESS_YEARLY: "price_bus_y",
} as unknown as NodeJS.ProcessEnv;
const SELF = { STRIPE_SECRET_KEY: "sk_test_stub" } as unknown as NodeJS.ProcessEnv;

function client(stub: ReturnType<typeof stripeStub>) {
  return new StripeClient({ secretKey: "sk_test_stub", apiBase: "https://api.stripe.test", fetchImpl: stub.fetchImpl });
}

function seats(humans: number, agents = 0) {
  fakeDb.setMembers([
    ...Array.from({ length: humans }, (_, i) => ({ userId: i + 1, isAgent: false })),
    ...Array.from({ length: agents }, (_, i) => ({ userId: 1000 + i, isAgent: true })),
  ]);
}

function business(config: Record<string, unknown> = {}) {
  fakeDb.reset().setOrg({ id: ORG_ID, plan: "business", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_bus" });
  fakeDb.setIntegration({
    orgId: ORG_ID,
    kind: "billing",
    config: { interval: "month", items: { base: "si_base", seat: "si_seat" }, status: "active", seatQuantity: 0, ...config },
  });
}

let stub: ReturnType<typeof stripeStub>;

beforeEach(() => {
  stub = stripeStub({ subscriptions: { sub_bus: planSubscriptionFixture("business", "month", { id: "sub_bus", customer: "cus_live", seats: 0 }) } });
});

describe("what it bills", () => {
  it("sets the quantity to humans − 50 and prorates", async () => {
    business();
    seats(57, 9);

    const res = await syncSeatQuantity(ORG_ID, { env: HOSTED, client: client(stub) });

    expect(res).toMatchObject({ synced: true, plan: "business", humans: 57, quantity: 7, previous: 0 });
    const call = stub.callsTo("/v1/subscriptions/sub_bus")[0];
    expect(call.body).toMatchObject({ "items[0][id]": "si_seat", "items[0][quantity]": "7", proration_behavior: "create_prorations" });
    // Idempotency key names the quantity, so a retry of the same change is free.
    expect(call.headers["idempotency-key"]).toBe("ptd-seats-4-sub_bus-7");
    expect(fakeDb.billingConfig(ORG_ID)).toMatchObject({ seatQuantity: 7 });
  });

  it("agents never move the quantity, however many there are", async () => {
    business();
    seats(50, 40);
    expect(await syncSeatQuantity(ORG_ID, { env: HOSTED, client: client(stub) })).toMatchObject({ quantity: 0, note: "unchanged" });
    expect(stub.calls).toHaveLength(0);
  });

  it("adds the seat item when the subscription has none yet", async () => {
    business({ items: { base: "si_base" }, seatQuantity: null });
    seats(53);

    const res = await syncSeatQuantity(ORG_ID, { env: HOSTED, client: client(stub) });

    expect(res).toMatchObject({ synced: true, quantity: 3 });
    expect(stub.callsTo("/v1/subscriptions/sub_bus")[0].body).toMatchObject({ "items[0][price]": "price_seat_m", "items[0][quantity]": "3" });
    // Stripe answered with the new item's id, and it was recorded.
    expect(fakeDb.billingConfig(ORG_ID)).toMatchObject({ items: { seat: "si_stub_5" }, seatQuantity: 3 });
  });

  it("uses the yearly seat price on a yearly subscription", async () => {
    business({ interval: "year", items: { base: "si_base" }, seatQuantity: null });
    seats(51);
    await syncSeatQuantity(ORG_ID, { env: HOSTED, client: client(stub) });
    expect(stub.callsTo("/v1/subscriptions/sub_bus")[0].body["items[0][price]"]).toBe("price_seat_y");
  });

  it("takes the quantity back down when a member is removed", async () => {
    business({ seatQuantity: 7 });
    seats(52);
    const res = await syncSeatQuantity(ORG_ID, { env: HOSTED, client: client(stub) });
    expect(res).toMatchObject({ synced: true, quantity: 2, previous: 7 });
    expect(stub.callsTo("/v1/subscriptions/sub_bus")[0].body["items[0][quantity]"]).toBe("2");
  });

  it("zeroes the item when the organization falls back under 50", async () => {
    business({ seatQuantity: 4 });
    seats(48);
    const res = await syncSeatQuantity(ORG_ID, { env: HOSTED, client: client(stub) });
    expect(res).toMatchObject({ synced: true, quantity: 0, previous: 4 });
    expect(stub.callsTo("/v1/subscriptions/sub_bus")[0].body["items[0][quantity]"]).toBe("0");
  });
});

describe("what it refuses to do", () => {
  it("makes no call when the quantity has not moved — which is what stops a webhook loop", async () => {
    business({ seatQuantity: 5 });
    seats(55);
    expect(await syncSeatQuantity(ORG_ID, { env: HOSTED, client: client(stub) })).toMatchObject({ synced: false, note: "unchanged", quantity: 5 });
    expect(stub.calls).toHaveLength(0);
  });

  it("does nothing on Team, whose ten seats are a limit rather than a meter", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "team", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_bus" });
    seats(9, 3);
    expect(await syncSeatQuantity(ORG_ID, { env: HOSTED, client: client(stub) })).toMatchObject({ synced: false, plan: "team", note: /only billed on business/ });
    expect(stub.calls).toHaveLength(0);
  });

  it("does nothing on free, on a self-hosted deployment, or for an org that does not exist", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "free" });
    expect(await syncSeatQuantity(ORG_ID, { env: HOSTED, client: client(stub) })).toMatchObject({ synced: false, plan: "free" });
    business();
    seats(60);
    expect(await syncSeatQuantity(ORG_ID, { env: SELF, client: client(stub) })).toMatchObject({ synced: false, note: "self-hosted" });
    fakeDb.reset();
    fakeDb.queueEmpty("organizations");
    expect(await syncSeatQuantity(ORG_ID, { env: HOSTED, client: client(stub) })).toMatchObject({ synced: false, note: "no such organization" });
    expect(stub.calls).toHaveLength(0);
  });

  it("says so, rather than calling Stripe, when the seat price is not configured", async () => {
    business({ items: { base: "si_base" }, seatQuantity: null });
    seats(60);
    const res = await syncSeatQuantity(ORG_ID, { env: { ...HOSTED, STRIPE_PRICE_SEAT_MONTHLY: "" } as NodeJS.ProcessEnv, client: client(stub) });
    expect(res).toMatchObject({ synced: false, note: "no seat price configured for month" });
    expect(stub.calls).toHaveLength(0);
  });

  it("never throws when Stripe fails — an invitation must not die with it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    business({ seatQuantity: 0 });
    seats(60);
    const failing = new StripeClient({
      secretKey: "sk_test_x",
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: { message: "Stripe is down" } }) }) as never,
    });
    const res = await syncSeatQuantity(ORG_ID, { env: HOSTED, client: failing });
    expect(res).toMatchObject({ synced: false });
    expect(res.note).toMatch(/Stripe is down/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
