/**
 * PTD-provided AI, billed on at cost plus 20%.
 *
 * The provider layer is handed a prompt, not an organization, so the chain under
 * test here is: the action sets the usage scope → `completeJSON` finishes and
 * reports the call through the metering hook → the billing layer turns it into one
 * `ptd_ai_usage_cents` event for the organization's Stripe customer. Importing
 * `server/actions/ai` is what installs that hook, exactly as the running server does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";
import { stripeStub } from "./stub";

vi.mock("../../db", () => ({ db: fakeDb }));

// Installs the metering hook as a side effect of registering the AI actions.
await import("../../server/actions/ai");
const { completeJSON } = await import("../../server/ai/provider");
const { withUsageScope } = await import("../../server/ai/usage");

const ORG_ID = 4;
const REAL_ENV = { ...process.env };
let stub: ReturnType<typeof stripeStub>;

/** An Anthropic answer that costs a known number of dollars. */
function anthropicAnswer(inputTokens: number, outputTokens: number) {
  return async () =>
    ({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          content: [{ type: "tool_use", name: "suggestion", input: { ok: true } }],
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        }),
    }) as unknown as Response;
}

const SPEC = {
  name: "suggestion",
  description: "test",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  parse: (value: unknown) => value as { ok: boolean },
};

/** The hook is fire-and-forget, so give the microtasks a chance to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (stub.callsTo("/v1/billing/meter_events").length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  fakeDb.reset().setOrg({ id: ORG_ID, name: "Atelier 14", plan: "team", stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live" });
  stub = stripeStub();
  vi.stubGlobal("fetch", vi.fn(stub.fetchImpl as never));
  process.env.PTD_HOSTED = "1";
  process.env.STRIPE_SECRET_KEY = "sk_test_stub";
  process.env.STRIPE_API_BASE = "https://api.stripe.test";
  process.env.STRIPE_METER_AI_USAGE = "ptd_ai_usage_cents";
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  vi.unstubAllGlobals();
});

const config = (source: "org" | "env") => ({
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  apiKey: "sk-ant-test",
  baseUrl: "https://api.anthropic.test",
  timeoutMs: 5_000,
  source,
});

describe("a Team organization using PTD's key", () => {
  it("meters one event of cost × 1.2, in whole cents", async () => {
    // claude-sonnet-4-6 is $3/$15 per million, so 1,000 + 1,000 tokens is $0.018.
    const call = () =>
      completeJSON(
        { system: "s", user: "u", schema: SPEC, label: "task.suggest_priority" },
        { config: config("env"), fetchImpl: anthropicAnswer(1_000, 1_000) },
      );

    const result = await withUsageScope({ orgId: ORG_ID, userId: 1 }, call);
    expect(result.data).toEqual({ ok: true });
    await settle();

    const events = stub.callsTo("/v1/billing/meter_events");
    expect(events).toHaveLength(1);
    const cents = Math.round(result.usage.costUsd * 100 * 1.2);
    expect(cents).toBeGreaterThan(0);
    expect(events[0].body).toMatchObject({
      event_name: "ptd_ai_usage_cents",
      "payload[stripe_customer_id]": "cus_live",
      "payload[value]": String(cents),
    });
    // The identifier names this one call, so a retry cannot bill it twice.
    expect(events[0].body.identifier).toMatch(/^ptd-ai-4-[0-9a-f]{24}$/);
  });

  it("meters nothing when the organization brought its own key", async () => {
    await withUsageScope({ orgId: ORG_ID, userId: 1 }, () =>
      completeJSON({ system: "s", user: "u", schema: SPEC, label: "task.suggest_priority" }, { config: config("org"), fetchImpl: anthropicAnswer(1_000, 1_000) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.callsTo("/v1/billing/meter_events")).toHaveLength(0);
  });

  it("meters nothing on free, and nothing for an organization with no subscription", async () => {
    for (const org of [{ plan: "free" }, { plan: "team", stripeSubscriptionId: null }]) {
      fakeDb.reset().setOrg({ id: ORG_ID, stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live", ...org });
      await withUsageScope({ orgId: ORG_ID, userId: 1 }, () =>
        completeJSON({ system: "s", user: "u", schema: SPEC, label: "task.suggest_priority" }, { config: config("env"), fetchImpl: anthropicAnswer(500, 500) }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stub.callsTo("/v1/billing/meter_events")).toHaveLength(0);
    }
  });

  it("meters nothing on a self-hosted deployment", async () => {
    delete process.env.PTD_HOSTED;
    await withUsageScope({ orgId: ORG_ID, userId: 1 }, () =>
      completeJSON({ system: "s", user: "u", schema: SPEC, label: "task.suggest_priority" }, { config: config("env"), fetchImpl: anthropicAnswer(1_000, 1_000) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.callsTo("/v1/billing/meter_events")).toHaveLength(0);
  });

  it("makes no meter call at all when no organization is in scope (a script, a test)", async () => {
    await completeJSON({ system: "s", user: "u", schema: SPEC, label: "cli" }, { config: config("env"), fetchImpl: anthropicAnswer(1_000, 1_000) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls).toHaveLength(0);
  });
});
