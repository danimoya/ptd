import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { fakeDb } from "./fake-db";
import { eventFixture, signPayload, stripeStub, subscriptionFixture } from "./stub";

vi.mock("../../db", () => ({ db: fakeDb }));

const { registerBillingRoutes, BILLING_WEBHOOK_PATH } = await import("../../server/billing/routes");
const { resetProcessedEvents } = await import("../../server/billing/webhook");
const { currentBaseUrl } = await import("../../server/billing/base");

const ORG_ID = 4;
const SECRET = "whsec_route_test";
const REAL_ENV = { ...process.env };

/**
 * The same middleware order as server/index.ts: the global JSON parser is mounted
 * before any route exists, which is exactly the situation the webhook's raw-body
 * capture has to survive.
 */
function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerBillingRoutes(app);
  // Registered after billing, to prove the hoisted middleware still runs first.
  app.get("/api/whereami", (_req, res) => res.json({ base: currentBaseUrl() }));
  app.post("/api/echo", (req, res) => res.json({ body: req.body }));
  return app;
}

beforeEach(() => {
  resetProcessedEvents();
  fakeDb.reset().setOrg({ id: ORG_ID, name: "Atelier 14", plan: "free" });
  process.env.PTD_HOSTED = "1";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test_stub";
  process.env.STRIPE_API_BASE = "https://api.stripe.test";
  const stub = stripeStub({ subscriptions: { sub_hook: subscriptionFixture({ id: "sub_hook", customer: "cus_hook" }) } });
  vi.stubGlobal("fetch", vi.fn(stub.fetchImpl as never));
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  vi.unstubAllGlobals();
});

function post(app: express.Express, payload: string, signature?: string) {
  const req = request(app).post(BILLING_WEBHOOK_PATH).set("Content-Type", "application/json");
  if (signature !== undefined) req.set("Stripe-Signature", signature);
  return req.send(payload);
}

describe("POST /api/billing/webhook", () => {
  it("verifies a signed checkout.session.completed against the raw bytes and flips the org to hosted", async () => {
    const payload = JSON.stringify(eventFixture("checkout.session.completed", {
      id: "cs_route", client_reference_id: String(ORG_ID), customer: "cus_hook", subscription: "sub_hook",
    }, "evt_route_1"));

    const res = await post(buildApp(), payload, signPayload(payload, SECRET));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, handled: true, orgId: ORG_ID, plan: "hosted" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "hosted", stripeSubscriptionId: "sub_hook" });
  });

  it("flips the org back to free on customer.subscription.deleted", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "hosted", stripeCustomerId: "cus_hook", stripeSubscriptionId: "sub_hook" });
    const payload = JSON.stringify(eventFixture("customer.subscription.deleted", subscriptionFixture({ id: "sub_hook", status: "canceled", customer: "cus_hook" }), "evt_route_2"));

    const res = await post(buildApp(), payload, signPayload(payload, SECRET));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handled: true, plan: "free" });
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "free", stripeSubscriptionId: null });
  });

  it("answers 400 for a bad signature, a stale timestamp and a missing header — and writes nothing", async () => {
    const payload = JSON.stringify(eventFixture("checkout.session.completed", { id: "cs_x", client_reference_id: String(ORG_ID), subscription: "sub_hook" }, "evt_route_3"));
    const app = buildApp();

    const bad = await post(app, payload, `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`);
    const stale = await post(app, payload, signPayload(payload, SECRET, Math.floor(Date.now() / 1000) - 3600));
    const none = await post(app, payload);

    for (const res of [bad, stale, none]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_signature");
    }
    expect(fakeDb.updates).toHaveLength(0);
    expect(fakeDb.org(ORG_ID)).toMatchObject({ plan: "free" });
  });

  it("rejects a body signed with the wrong secret", async () => {
    const payload = JSON.stringify(eventFixture("customer.subscription.updated", subscriptionFixture(), "evt_route_4"));
    const res = await post(buildApp(), payload, signPayload(payload, "whsec_not_ours"));
    expect(res.status).toBe(400);
  });

  it("answers 200 to an unknown event type", async () => {
    const payload = JSON.stringify(eventFixture("payment_intent.succeeded", { id: "pi_1" }, "evt_route_5"));
    const res = await post(buildApp(), payload, signPayload(payload, SECRET));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, handled: false, note: "ignored" });
  });

  it("answers 200 to a redelivery without writing twice", async () => {
    const payload = JSON.stringify(eventFixture("checkout.session.completed", {
      id: "cs_route", client_reference_id: String(ORG_ID), customer: "cus_hook", subscription: "sub_hook",
    }, "evt_route_6"));
    const app = buildApp();
    const signature = signPayload(payload, SECRET);

    await post(app, payload, signature);
    const writes = fakeDb.updates.length;
    const again = await post(app, payload, signature);

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true });
    expect(fakeDb.updates).toHaveLength(writes);
  });
});

describe("middleware behaviour", () => {
  it("leaves ordinary JSON routes parsed as objects", async () => {
    const res = await request(buildApp()).post("/api/echo").send({ hello: "world" });
    expect(res.body).toEqual({ body: { hello: "world" } });
  });

  it("records the request's public base URL for the action layer", async () => {
    const res = await request(buildApp()).get("/api/whereami").set("Host", "ptd.danimoya.com").set("X-Forwarded-Proto", "https");
    expect(res.body.base).toBe("https://ptd.danimoya.com");
  });
});

describe("PTD_HOSTED unset", () => {
  it("registers no webhook route at all", async () => {
    delete process.env.PTD_HOSTED;
    const app = buildApp();
    const payload = JSON.stringify(eventFixture("checkout.session.completed", { id: "cs_x" }, "evt_off"));

    const res = await post(app, payload, signPayload(payload, SECRET));

    expect(res.status).toBe(404);
    expect(fakeDb.updates).toHaveLength(0);
  });
});
