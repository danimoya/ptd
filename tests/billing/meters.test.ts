/**
 * The two metered add-ons: the bodies that reach Stripe, and the identifiers that
 * stop a retry being a second charge.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";
import { stripeStub } from "./stub";

vi.mock("../../db", () => ({ db: fakeDb }));

const { meterEventParams, postMeterEvent } = await import("../../server/billing/service");
const { StripeClient } = await import("../../server/billing/stripe");
const { aiUsageIdentifier, certInvoiceIdentifier, meterAiUsage, meterCertifiedInvoice, meterIssuedInvoice } = await import("../../server/billing/metering");

const HOSTED = { PTD_HOSTED: "1", STRIPE_SECRET_KEY: "sk_test_stub", STRIPE_METER_CERT_INVOICE: "ptd_certified_invoices", STRIPE_METER_AI_USAGE: "ptd_ai_usage_cents" } as unknown as NodeJS.ProcessEnv;
const SELF = { STRIPE_SECRET_KEY: "sk_test_stub" } as unknown as NodeJS.ProcessEnv;

function client(stub: ReturnType<typeof stripeStub>) {
  return new StripeClient({ secretKey: "sk_test_stub", apiBase: "https://api.stripe.test", fetchImpl: stub.fetchImpl });
}

const AI_CALL = {
  orgId: 4,
  at: "2026-09-20T10:00:00.000Z",
  label: "task.suggest_priority",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  inputTokens: 1200,
  outputTokens: 180,
  costUsd: 0.0123,
};

beforeEach(() => {
  fakeDb.reset().setOrg({ id: 4, plan: "team", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live" });
});

describe("meterEventParams", () => {
  it("is exactly the documented body: event_name, the two payload keys, an identifier", () => {
    expect(meterEventParams({ eventName: "ptd_certified_invoices", customerId: "cus_live", value: 1, identifier: "ptd-cert-PTD-CTR-2026-09-0007" })).toEqual({
      event_name: "ptd_certified_invoices",
      payload: { stripe_customer_id: "cus_live", value: "1" },
      identifier: "ptd-cert-PTD-CTR-2026-09-0007",
    });
  });

  it("sends whole units, and a timestamp only when one is given", () => {
    const at = new Date("2026-09-20T10:00:00.000Z");
    const params = meterEventParams({ eventName: "ptd_ai_usage_cents", customerId: "cus_live", value: 6.4, identifier: "x", at });
    expect(params.payload).toEqual({ stripe_customer_id: "cus_live", value: "6" });
    expect(params.timestamp).toBe(Math.floor(at.getTime() / 1000));
    expect(meterEventParams({ eventName: "m", customerId: "c", value: 3, identifier: "y" })).not.toHaveProperty("timestamp");
  });

  it("never sends a negative value, and clips the identifier to Stripe's 100 characters", () => {
    const params = meterEventParams({ eventName: "m", customerId: "c", value: -8, identifier: "z".repeat(140) });
    expect(params.payload).toMatchObject({ value: "0" });
    expect(String(params.identifier)).toHaveLength(100);
  });

  it("POSTs to /v1/billing/meter_events with the identifier as the idempotency key", async () => {
    const stub = stripeStub();
    await postMeterEvent(client(stub), { eventName: "ptd_certified_invoices", customerId: "cus_live", value: 1, identifier: "ptd-cert-REF" });
    const call = stub.callsTo("/v1/billing/meter_events")[0];
    expect(call.method).toBe("POST");
    expect(call.body).toMatchObject({ event_name: "ptd_certified_invoices", "payload[stripe_customer_id]": "cus_live", "payload[value]": "1", identifier: "ptd-cert-REF" });
    expect(call.headers["idempotency-key"]).toBe("meter-ptd-cert-REF");
  });
});

describe("identifiers", () => {
  it("names a certified invoice by its own reference", () => {
    expect(certInvoiceIdentifier("PTD-CTR-2026-09-0007")).toBe("ptd-cert-PTD-CTR-2026-09-0007");
  });

  it("names an AI call by a digest of the call, so the same call is never billed twice", () => {
    const first = aiUsageIdentifier(AI_CALL as never);
    expect(first).toBe(aiUsageIdentifier({ ...AI_CALL } as never));
    expect(first.startsWith("ptd-ai-4-")).toBe(true);
    expect(first.length).toBeLessThanOrEqual(100);
    // Any difference in the call — including its cost — is a different event.
    expect(aiUsageIdentifier({ ...AI_CALL, costUsd: 0.0124 } as never)).not.toBe(first);
    expect(aiUsageIdentifier({ ...AI_CALL, at: "2026-09-20T10:00:01.000Z" } as never)).not.toBe(first);
    expect(aiUsageIdentifier({ ...AI_CALL, orgId: 5 } as never)).not.toBe(first);
  });
});

describe("meterCertifiedInvoice", () => {
  it("sends one event of value 1 keyed on the reference", async () => {
    const stub = stripeStub();
    const out = await meterCertifiedInvoice({ orgId: 4, customerId: "cus_live", reference: "PTD-CTR-2026-09-0007" }, { client: client(stub), env: HOSTED });
    expect(out).toEqual({ metered: true, identifier: "ptd-cert-PTD-CTR-2026-09-0007", value: 1 });
    expect(stub.callsTo("/v1/billing/meter_events")).toHaveLength(1);
    expect(stub.callsTo("/v1/billing/meter_events")[0].body).toMatchObject({ event_name: "ptd_certified_invoices", "payload[value]": "1" });
  });

  it("makes no call at all on a self-hosted deployment", async () => {
    const stub = stripeStub();
    expect(await meterCertifiedInvoice({ orgId: 4, customerId: "cus_live", reference: "R" }, { client: client(stub), env: SELF })).toMatchObject({ metered: false, note: "self-hosted" });
    expect(stub.calls).toHaveLength(0);
  });

  it("never throws when Stripe refuses — the invoice is already signed and locked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = new StripeClient({
      secretKey: "sk_test_x",
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "No such meter" } }) }) as never,
    });
    const out = await meterCertifiedInvoice({ orgId: 4, customerId: "cus_live", reference: "PTD-2026-09-0001" }, { client: failing, env: HOSTED });
    expect(out.metered).toBe(false);
    expect(out.note).toMatch(/No such meter/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("meterAiUsage", () => {
  it("bills cost × 1.2 in whole cents", async () => {
    const stub = stripeStub();
    const out = await meterAiUsage({ orgId: 4, customerId: "cus_live", costUsd: 0.05, identifier: "ptd-ai-4-abc" }, { client: client(stub), env: HOSTED });
    expect(out).toEqual({ metered: true, identifier: "ptd-ai-4-abc", value: 6 });
    expect(stub.callsTo("/v1/billing/meter_events")[0].body).toMatchObject({ event_name: "ptd_ai_usage_cents", "payload[value]": "6" });
  });

  it("sends nothing for a call too cheap to round to a cent", async () => {
    const stub = stripeStub();
    expect(await meterAiUsage({ orgId: 4, customerId: "cus_live", costUsd: 0.0001, identifier: "x" }, { client: client(stub), env: HOSTED })).toMatchObject({
      metered: false,
      note: "nothing to bill",
      value: 0,
    });
    expect(stub.calls).toHaveLength(0);
  });

  it("meters nothing when self-hosted", async () => {
    const stub = stripeStub();
    expect(await meterAiUsage({ orgId: 4, customerId: "cus_live", costUsd: 5, identifier: "x" }, { client: client(stub), env: SELF })).toMatchObject({ metered: false });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("meterIssuedInvoice — what an invoice action reports", () => {
  it("bills a dollar on Team and says which event carried it", async () => {
    const stub = stripeStub();
    const note = await meterIssuedInvoice(
      { plan: "team", metered: true, customerId: "cus_live" },
      { orgId: 4, reference: "PTD-CTR-2026-09-0007" },
      { client: client(stub), env: HOSTED },
    );
    expect(note).toEqual({ plan: "team", metered: true, usd: 1, identifier: "ptd-cert-PTD-CTR-2026-09-0007" });
  });

  it("bills nothing on Business and says the invoice is included", async () => {
    const stub = stripeStub();
    const note = await meterIssuedInvoice({ plan: "business", metered: false, customerId: "cus_live" }, { orgId: 4, reference: "R" }, { client: client(stub), env: HOSTED });
    expect(note).toEqual({ plan: "business", metered: false, usd: 0, note: "included in Business" });
    expect(stub.calls).toHaveLength(0);
  });

  it("bills nothing, and says nothing, on a self-hosted deployment", async () => {
    const stub = stripeStub();
    expect(await meterIssuedInvoice({ plan: null, metered: false, customerId: null }, { orgId: 4, reference: "R" }, { client: client(stub), env: SELF })).toEqual({
      plan: null,
      metered: false,
      usd: 0,
    });
    expect(stub.calls).toHaveLength(0);
  });
});
