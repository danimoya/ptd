import { describe, expect, it, vi } from "vitest";

// checkoutParams is pure, but the module it lives in talks to drizzle.
vi.mock("../../db", async () => {
  const { FakeDb } = await import("../track/fake-db");
  return { db: new FakeDb() };
});

import { checkoutParams, createCheckoutSession, createPortalSession, taxEnabled } from "../../server/billing/service";
import { StripeClient, encodeForm } from "../../server/billing/stripe";

const base = { orgId: 7, customerId: "cus_123", priceId: "price_abc" };
const envBase = { PTD_PUBLIC_URL: "https://ptd.example.com" } as NodeJS.ProcessEnv;
const withTax = { ...envBase, STRIPE_TAX_ENABLED: "1" } as NodeJS.ProcessEnv;

/** A Stripe client that records the request instead of making it. */
function recorder(answer: Record<string, unknown> = { id: "cs_1", url: "https://checkout.stripe.com/x" }) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const client = new StripeClient({
    secretKey: "sk_test_x",
    apiBase: "https://stripe.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: String(init?.body ?? ""), headers: (init?.headers ?? {}) as Record<string, string> });
      return { ok: true, status: 200, text: async () => JSON.stringify(answer) } as unknown as Response;
    },
  });
  return { client, calls };
}

describe("taxEnabled", () => {
  it("is a switch, and only the string 1 flips it", () => {
    expect(taxEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(taxEnabled({ STRIPE_TAX_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(true);
    for (const value of ["", "0", "true", "yes", "on"]) {
      expect(taxEnabled({ STRIPE_TAX_ENABLED: value } as NodeJS.ProcessEnv)).toBe(false);
    }
  });
});

describe("checkout body without Stripe Tax", () => {
  const params = checkoutParams({ ...base, env: envBase });

  it("says automatic tax is off, and asks for nothing it would not use", () => {
    expect(params.automatic_tax).toEqual({ enabled: false });
    expect(params).not.toHaveProperty("billing_address_collection");
    expect(params).not.toHaveProperty("tax_id_collection");
    expect(params).not.toHaveProperty("customer_update");
  });

  it("keeps the rest of the session as it was", () => {
    expect(params.mode).toBe("subscription");
    expect(params.customer).toBe("cus_123");
    expect(params.client_reference_id).toBe("7");
    expect(params.line_items).toEqual([{ price: "price_abc", quantity: 1 }]);
    expect(params.allow_promotion_codes).toBe(true);
    expect(String(params.success_url)).toContain("session_id={CHECKOUT_SESSION_ID}");
  });
});

describe("checkout body with STRIPE_TAX_ENABLED=1", () => {
  const params = checkoutParams({ ...base, env: withTax });

  it("turns automatic tax on and adds the three settings it needs to work", () => {
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.billing_address_collection).toBe("required");
    expect(params.tax_id_collection).toEqual({ enabled: true });
    // Without this Stripe refuses the session: it may not write back the address
    // it just collected.
    expect(params.customer_update).toEqual({ address: "auto" });
  });

  it("form-encodes to exactly the fields Stripe expects", () => {
    const body = encodeForm(params);
    const fields = Object.fromEntries(new URLSearchParams(body));
    expect(fields["automatic_tax[enabled]"]).toBe("true");
    expect(fields["billing_address_collection"]).toBe("required");
    expect(fields["tax_id_collection[enabled]"]).toBe("true");
    expect(fields["customer_update[address]"]).toBe("auto");
    expect(fields["line_items[0][price]"]).toBe("price_abc");
    expect(fields["line_items[0][quantity]"]).toBe("1");
    expect(fields["client_reference_id"]).toBe("7");
  });

  it("is what actually reaches /v1/checkout/sessions", async () => {
    const { client, calls } = recorder();
    await createCheckoutSession(client, { ...base, env: withTax });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://stripe.test/v1/checkout/sessions");
    const fields = Object.fromEntries(new URLSearchParams(calls[0].body));
    expect(fields["automatic_tax[enabled]"]).toBe("true");
    expect(fields["tax_id_collection[enabled]"]).toBe("true");
    expect(fields["customer_update[address]"]).toBe("auto");
    expect(fields["billing_address_collection"]).toBe("required");
  });

  it("leaves the off case off, all the way to the wire", async () => {
    const { client, calls } = recorder();
    await createCheckoutSession(client, { ...base, env: envBase });
    const fields = Object.fromEntries(new URLSearchParams(calls[0].body));
    expect(fields["automatic_tax[enabled]"]).toBe("false");
    expect(fields["tax_id_collection[enabled]"]).toBeUndefined();
    expect(fields["customer_update[address]"]).toBeUndefined();
    expect(fields["billing_address_collection"]).toBeUndefined();
  });
});

describe("the billing portal", () => {
  it("is unchanged by the tax switch: a customer and a return URL, nothing else", async () => {
    for (const env of [envBase, withTax]) {
      const { client, calls } = recorder({ id: "bps_1", url: "https://billing.stripe.com/x" });
      await createPortalSession(client, { customerId: "cus_123", env });
      expect(calls[0].url).toBe("https://stripe.test/v1/billing_portal/sessions");
      expect(Object.keys(Object.fromEntries(new URLSearchParams(calls[0].body))).sort()).toEqual(["customer", "return_url"]);
    }
  });
});
