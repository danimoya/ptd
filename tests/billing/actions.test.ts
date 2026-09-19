import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";
import { stripeStub, subscriptionFixture } from "./stub";

vi.mock("../../db", () => ({ db: fakeDb }));

await import("../../server/actions/billing");
const { runAction, ActionError } = await import("../../server/actions/registry");
const { getAction } = await import("../../server/actions/registry");

const ORG_ID = 4;
const ctx = (role: "owner" | "admin" | "manager" | "member" = "owner") => ({
  userId: 1, email: "elena@atelier14.demo", displayName: "Elena", orgId: ORG_ID, role, authType: "human" as const, via: "web" as const,
});

const REAL_ENV = { ...process.env };
let stub: ReturnType<typeof stripeStub>;
let fetchSpy: ReturnType<typeof vi.fn>;

function hostedEnv() {
  process.env.PTD_HOSTED = "1";
  process.env.STRIPE_SECRET_KEY = "sk_test_stub";
  process.env.STRIPE_PRICE_ID = "price_test_15";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_API_BASE = "https://api.stripe.test";
  process.env.PTD_PUBLIC_URL = "https://ptd.danimoya.com";
}

beforeEach(() => {
  fakeDb.reset().setOrg({ id: ORG_ID, name: "Atelier 14", plan: "free" });
  fakeDb.setMembers([{ userId: 1, role: "owner", isAgent: false, email: "elena@atelier14.demo" }, { userId: 2, isAgent: true }]);
  stub = stripeStub({ subscriptions: { sub_live: subscriptionFixture({ id: "sub_live", customer: "cus_live" }) } });
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
    expect(getAction("billing.checkout")?.requiredRole).toBe("owner");
    expect(getAction("billing.portal")?.requiredRole).toBe("owner");
    expect(getAction("billing.sync")?.requiredRole).toBe("owner");
  });

  it("refuses a manager reading status and an admin starting checkout", async () => {
    await expect(runAction("billing.status", {}, ctx("manager"))).rejects.toThrow(/requires role admin/);
    await expect(runAction("billing.checkout", {}, ctx("admin"))).rejects.toThrow(/requires role owner/);
  });
});

describe("billing.status", () => {
  it("reports the free plan, the $15 price, seat usage and the 3-seat ceiling", async () => {
    const res = await runAction("billing.status", {}, ctx("admin"));
    expect(res).toMatchObject({
      hosted: true,
      plan: "free",
      priceUsd: 15,
      interval: "month",
      limits: { members: 3 },
      usage: { members: 2, agents: 1, humans: 1 },
      subscription: null,
      portalAvailable: false,
      configured: true,
    });
    // Nothing to read from Stripe for an org with no subscription.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads the live subscription for a paid org and drops the seat ceiling", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "hosted", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live" });
    fakeDb.setMembers([{ userId: 1, role: "owner", isAgent: false }]);

    const res = (await runAction("billing.status", {}, ctx("admin"))) as Record<string, any>;

    expect(res.limits).toEqual({ members: null });
    expect(res.portalAvailable).toBe(true);
    expect(res.subscription).toMatchObject({
      id: "sub_live",
      status: "active",
      cancelAtPeriodEnd: false,
      pastDue: false,
      currentPeriodEnd: new Date(Date.UTC(2026, 9, 19, 12, 0, 0)).toISOString(),
    });
  });

  it("still renders when Stripe is unreachable, with a warning instead of a blank tab", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "hosted", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_missing" });
    const res = (await runAction("billing.status", {}, ctx("admin"))) as Record<string, any>;
    expect(res.plan).toBe("hosted");
    expect(res.subscription).toBeNull();
    expect(res.warning).toMatch(/No such subscription/);
  });

  it("flags a missing Stripe configuration rather than pretending checkout works", async () => {
    delete process.env.STRIPE_PRICE_ID;
    expect((await runAction("billing.status", {}, ctx("admin"))) as Record<string, any>).toMatchObject({ configured: false });
  });
});

describe("billing.checkout", () => {
  it("creates the customer and the session, and returns the Stripe URL", async () => {
    const res = (await runAction("billing.checkout", {}, ctx())) as Record<string, any>;

    expect(res).toMatchObject({ hosted: true, url: "https://checkout.stripe.com/c/pay/cs_test_stub", sessionId: "cs_test_stub" });
    expect(stub.callsTo("/v1/customers")[0].body).toMatchObject({ email: "elena@atelier14.demo", "metadata[orgId]": "4" });
    expect(stub.callsTo("/v1/checkout/sessions")[0].body).toMatchObject({
      mode: "subscription",
      client_reference_id: "4",
      "line_items[0][price]": "price_test_15",
      success_url: "https://ptd.danimoya.com/org/billing?tab=billing&checkout=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://ptd.danimoya.com/org/billing?tab=billing&checkout=cancelled",
    });
  });

  it("sends an already-subscribed org to the portal instead of selling a second subscription", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "hosted", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live" });
    await expect(runAction("billing.checkout", {}, ctx())).rejects.toThrow(/already has a subscription/);
    expect(stub.callsTo("/v1/checkout/sessions")).toHaveLength(0);
  });

  it("turns a missing key into an action error, not a 500", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await expect(runAction("billing.checkout", {}, ctx())).rejects.toThrow(/Billing is not configured/);
  });

  it("turns a Stripe rejection into a conflict with Stripe's own message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "No such price: 'price_test_15'" } }) })));
    const err = await runAction("billing.checkout", {}, ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as InstanceType<typeof ActionError>).code).toBe("conflict");
    expect((err as Error).message).toMatch(/No such price/);
  });
});

describe("billing.portal", () => {
  it("returns a portal URL for an org that has a customer", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "hosted", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live" });
    expect(await runAction("billing.portal", {}, ctx())).toEqual({ hosted: true, url: "https://billing.stripe.com/p/session/stub" });
  });

  it("refuses before there is a customer at all", async () => {
    await expect(runAction("billing.portal", {}, ctx())).rejects.toThrow(/No Stripe customer yet/);
  });
});

describe("billing.sync", () => {
  it("applies the subscription behind a Checkout Session id (the success redirect)", async () => {
    stub = stripeStub({
      subscriptions: { sub_live: subscriptionFixture({ id: "sub_live", customer: "cus_live" }) },
      checkoutSessions: { cs_done: { id: "cs_done", client_reference_id: "4", customer: "cus_live", subscription: "sub_live" } },
    });
    vi.stubGlobal("fetch", vi.fn(stub.fetchImpl as never));

    const res = (await runAction("billing.sync", { sessionId: "cs_done" }, ctx())) as Record<string, any>;

    expect(res).toMatchObject({ hosted: true, synced: true, plan: "hosted", changed: true });
    expect(res.subscription).toMatchObject({ status: "active", pastDue: false, cancelAtPeriodEnd: false });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "hosted", stripeSubscriptionId: "sub_live" });
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

  it("makes all four actions inert no-ops: no Stripe call, no database read", async () => {
    for (const name of ["billing.status", "billing.checkout", "billing.portal", "billing.sync"]) {
      expect(await runAction(name, {}, ctx())).toEqual({ hosted: false });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stub.calls).toHaveLength(0);
    expect(fakeDb.selects).toHaveLength(0);
    expect(fakeDb.updates).toHaveLength(0);
  });

  it("stays inert even with Stripe keys present in the environment", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_should_never_be_used";
    expect(await runAction("billing.checkout", {}, ctx())).toEqual({ hosted: false });
    expect(stub.calls).toHaveLength(0);
  });
});
