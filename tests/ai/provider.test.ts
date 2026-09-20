import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AI_NOT_CONFIGURED,
  AiNotConfiguredError,
  AiProviderError,
  aiConfigFromEnv,
  aiStatus,
  completeJSON,
  extractJson,
  requireAiConfig,
  type AiConfig,
} from "../../server/ai/provider";
import { ANTHROPIC_PRICES, DEFAULT_MODELS, estimateCostUsd, OPENAI_PRICES, priceFor } from "../../server/ai/pricing";
import { SUGGESTION_SPEC } from "../../server/ai/prompt";
import { recentCalls, resetUsage, usageTotals, USAGE_RING_SIZE } from "../../server/ai/usage";
import { aiStub, DEFAULT_SUGGESTION } from "./stub";

const config = (over: Partial<AiConfig> = {}): AiConfig => ({
  provider: "anthropic",
  model: "claude-haiku-4-5",
  apiKey: "sk-ant-stub",
  baseUrl: "https://api.anthropic.test",
  timeoutMs: 30_000,
  ...over,
});

const ask = (stub: ReturnType<typeof aiStub>, cfg = config()) =>
  completeJSON(
    { system: "you are a triager", user: "score card #1", schema: SUGGESTION_SPEC, label: "test" },
    { config: cfg, fetchImpl: stub.fetchImpl },
  );

beforeEach(() => resetUsage());
afterEach(() => resetUsage());

describe("configuration", () => {
  it("is off until both a provider and a key are set", () => {
    expect(aiConfigFromEnv({})).toBeNull();
    expect(aiConfigFromEnv({ PTD_AI_PROVIDER: "anthropic" })).toBeNull();
    expect(aiConfigFromEnv({ PTD_AI_API_KEY: "sk-x" })).toBeNull();
    expect(aiConfigFromEnv({ PTD_AI_PROVIDER: "hal9000", PTD_AI_API_KEY: "sk-x" })).toBeNull();
    expect(aiStatus({})).toEqual({ configured: false, provider: null, model: null });
  });

  it("defaults to the cheap/fast tier per provider and lets PTD_AI_MODEL win", () => {
    expect(aiConfigFromEnv({ PTD_AI_PROVIDER: "anthropic", PTD_AI_API_KEY: "k" })?.model).toBe("claude-haiku-4-5");
    expect(aiConfigFromEnv({ PTD_AI_PROVIDER: "openai", PTD_AI_API_KEY: "k" })?.model).toBe("gpt-4o-mini");
    expect(DEFAULT_MODELS.anthropic).toBe("claude-haiku-4-5");
    expect(
      aiConfigFromEnv({ PTD_AI_PROVIDER: "anthropic", PTD_AI_API_KEY: "k", PTD_AI_MODEL: "claude-opus-5" })?.model,
    ).toBe("claude-opus-5");
  });

  it("uses each provider's own base URL, and tolerates a trailing slash or /v1", () => {
    expect(aiConfigFromEnv({ PTD_AI_PROVIDER: "anthropic", PTD_AI_API_KEY: "k" })?.baseUrl).toBe("https://api.anthropic.com");
    expect(aiConfigFromEnv({ PTD_AI_PROVIDER: "openai", PTD_AI_API_KEY: "k" })?.baseUrl).toBe("https://api.openai.com");
    const gateway = { PTD_AI_PROVIDER: "openai", PTD_AI_API_KEY: "k", PTD_AI_BASE_URL: "http://127.0.0.1:9/v1/" };
    expect(aiConfigFromEnv(gateway)?.baseUrl).toBe("http://127.0.0.1:9");
  });

  it("caps every call at 30s unless told otherwise", () => {
    expect(aiConfigFromEnv({ PTD_AI_PROVIDER: "openai", PTD_AI_API_KEY: "k" })?.timeoutMs).toBe(30_000);
    expect(aiConfigFromEnv({ PTD_AI_PROVIDER: "openai", PTD_AI_API_KEY: "k", PTD_AI_TIMEOUT_MS: "5000" })?.timeoutMs).toBe(5_000);
    expect(aiConfigFromEnv({ PTD_AI_PROVIDER: "openai", PTD_AI_API_KEY: "k", PTD_AI_TIMEOUT_MS: "nope" })?.timeoutMs).toBe(30_000);
  });

  it("reports the model without ever echoing the key", () => {
    const status = aiStatus({ PTD_AI_PROVIDER: "anthropic", PTD_AI_API_KEY: "sk-ant-secret", PTD_AI_MODEL: "claude-haiku-4-5" });
    expect(status).toEqual({ configured: true, provider: "anthropic", model: "claude-haiku-4-5" });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("throws the message the actions surface when unconfigured", () => {
    expect(() => requireAiConfig({})).toThrow(AiNotConfiguredError);
    expect(() => requireAiConfig({})).toThrow(AI_NOT_CONFIGURED);
    expect(AI_NOT_CONFIGURED).toContain("PTD_AI_PROVIDER");
    expect(AI_NOT_CONFIGURED).toContain("PTD_AI_API_KEY");
  });
});

describe("the Anthropic request", () => {
  it("posts the Messages API shape: version header, forced tool call, no key in the body", async () => {
    const stub = aiStub();
    const { data, usage } = await ask(stub);

    const call = stub.last();
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/v1/messages");
    expect(call.headers["x-api-key"]).toBe("sk-ant-stub");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toMatchObject({
      model: "claude-haiku-4-5",
      system: "you are a triager",
      messages: [{ role: "user", content: "score card #1" }],
      tool_choice: { type: "tool", name: "score_priority" },
    });
    const tools = call.body.tools as Record<string, unknown>[];
    expect(tools[0]).toMatchObject({ name: "score_priority", strict: true });
    expect((tools[0].input_schema as Record<string, unknown>).additionalProperties).toBe(false);
    expect(JSON.stringify(call.body)).not.toContain("sk-ant-stub");

    expect(data).toEqual(DEFAULT_SUGGESTION);
    expect(usage).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5", inputTokens: 620, outputTokens: 90, attempts: 1 });
  });

  it("reads the object out of the tool_use block, not the text", async () => {
    const stub = aiStub({ replies: [{ kind: "tool", input: { ...DEFAULT_SUGGESTION, urgency: 2 } }] });
    const { data } = await ask(stub);
    expect(data.urgency).toBe(2);
  });

  it("falls back to a text block when the model answers in prose (fenced JSON included)", async () => {
    const stub = aiStub({
      replies: [{ kind: "text", text: "Sure!\n```json\n" + JSON.stringify(DEFAULT_SUGGESTION) + "\n```\n" }],
    });
    const { data, usage } = await ask(stub);
    expect(data).toEqual(DEFAULT_SUGGESTION);
    expect(usage.attempts).toBe(1);
  });

  it("drops the forced tool_choice and retries when the model rejects it", async () => {
    const stub = aiStub({
      replies: [
        { kind: "error", status: 400, message: 'tool_choice: type "tool" and "any" are not supported for this model.' },
        { kind: "tool", input: DEFAULT_SUGGESTION },
      ],
    });
    const { data, usage } = await ask(stub);
    expect(data).toEqual(DEFAULT_SUGGESTION);
    expect(usage.attempts).toBe(2);
    expect(stub.bodiesTo("/v1/messages").map((b) => b.tool_choice)).toEqual([
      { type: "tool", name: "score_priority" },
      { type: "auto" },
    ]);
  });

  it("turns a policy decline (HTTP 200, stop_reason refusal) into an error", async () => {
    const stub = aiStub({ replies: [{ kind: "refusal", category: "cyber" }] });
    await expect(ask(stub)).rejects.toThrow(/declined this request \(cyber\)/);
  });

  it("surfaces the provider's own words on a 4xx", async () => {
    const stub = aiStub({ replies: [{ kind: "error", status: 429, message: "rate limited, retry in 3s" }] });
    await expect(ask(stub)).rejects.toThrow(/rate limited, retry in 3s/);
    await expect(ask(aiStub({ replies: [{ kind: "error", status: 429, message: "x" }] }))).rejects.toBeInstanceOf(AiProviderError);
  });

  it("aborts at the configured timeout", async () => {
    const stub = aiStub({ delayMs: 200 });
    await expect(ask(stub, config({ timeoutMs: 20 }))).rejects.toThrow(/did not answer within 20ms/);
  });
});

describe("the OpenAI request", () => {
  const openai = config({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-openai-stub", baseUrl: "https://api.openai.test" });

  it("posts chat/completions in JSON mode with a bearer token", async () => {
    const stub = aiStub();
    const { data, usage } = await ask(stub, openai);

    const call = stub.last();
    expect(call.path).toBe("/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer sk-openai-stub");
    expect(call.headers["x-api-key"]).toBeUndefined();
    expect(call.body.response_format).toEqual({ type: "json_object" });
    expect(call.body.max_tokens).toBe(1024);
    const messages = call.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    // JSON mode requires the word "json" in the prompt, and the schema goes with it.
    expect(messages[0].content.toLowerCase()).toContain("json");
    expect(messages[0].content).toContain("score_priority".slice(0, 0) + "urgency");

    expect(data).toEqual(DEFAULT_SUGGESTION);
    expect(usage.provider).toBe("openai");
    expect(usage.inputTokens).toBe(620);
  });

  it("switches to max_completion_tokens when a model rejects max_tokens", async () => {
    const stub = aiStub({
      replies: [
        { kind: "error", status: 400, message: "Unsupported parameter: 'max_tokens' is not supported with this model." },
        { kind: "tool", input: DEFAULT_SUGGESTION },
      ],
    });
    const { usage } = await ask(stub, openai);
    expect(usage.attempts).toBe(2);
    const bodies = stub.bodiesTo("/v1/chat/completions");
    expect(bodies[0].max_tokens).toBe(1024);
    expect(bodies[1].max_completion_tokens).toBe(1024);
    expect(bodies[1].max_tokens).toBeUndefined();
    expect(bodies[1].temperature).toBeUndefined();
  });

  it("turns a refusal into an error", async () => {
    const stub = aiStub({ replies: [{ kind: "refusal" }] });
    await expect(ask(stub, openai)).rejects.toThrow(/openai declined/);
  });
});

describe("invalid JSON", () => {
  it("retries once with the parse error quoted, then succeeds", async () => {
    const stub = aiStub({
      replies: [{ kind: "text", text: "I think it is quite urgent, honestly." }, { kind: "tool", input: DEFAULT_SUGGESTION }],
    });
    const { data, usage } = await ask(stub);
    expect(data).toEqual(DEFAULT_SUGGESTION);
    expect(usage.attempts).toBe(2);
    // Tokens are charged for both round-trips, not just the one that worked.
    expect(usage.inputTokens).toBe(1240);
    expect(usage.outputTokens).toBe(180);

    const second = stub.bodiesTo("/v1/messages")[1];
    const messages = second.messages as { content: string }[];
    expect(messages[0].content).toContain("previous reply could not be used");
    expect(messages[0].content).toContain("ONLY a JSON object");
  });

  it("re-asks when the object is the wrong shape, and gives up after two tries", async () => {
    const stub = aiStub({ replies: [{ kind: "tool", input: { urgency: "very", impact: 3 } }] });
    await expect(ask(stub)).rejects.toThrow(/no usable JSON after 2 attempts/);
    expect(stub.served()).toBe(2);
  });

  it("rounds a fractional score and truncates an over-long rationale rather than burning a retry", async () => {
    const stub = aiStub({
      replies: [{ kind: "tool", input: { urgency: 7.6, impact: 12, effort: -3, rationale: "x".repeat(400), confidence: 1.4 } }],
    });
    const { data, usage } = await ask(stub);
    expect(data).toMatchObject({ urgency: 8, impact: 10, effort: 0, confidence: 1 });
    expect(data.rationale).toHaveLength(280);
    expect(usage.attempts).toBe(1);
  });

  it("extracts JSON out of prose, a fence, or neither", () => {
    expect(extractJson('{"a":1}', "openai")).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```', "openai")).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":1} — hope that helps', "openai")).toEqual({ a: 1 });
    expect(() => extractJson("no json here", "openai")).toThrow(/did not return JSON/);
  });
});

describe("cost", () => {
  it("prices Anthropic from the skill's table", () => {
    expect(ANTHROPIC_PRICES["claude-haiku-4-5"]).toEqual({ input: 1, output: 5 });
    expect(ANTHROPIC_PRICES["claude-opus-5"]).toEqual({ input: 5, output: 25 });
    expect(ANTHROPIC_PRICES["claude-sonnet-5"]).toEqual({ input: 2, output: 10 });
    // 620 in + 90 out on Haiku 4.5 = 620/1e6 * $1 + 90/1e6 * $5
    expect(estimateCostUsd("anthropic", "claude-haiku-4-5", 620, 90)).toEqual({ costUsd: 0.00107, priced: true });
    expect(estimateCostUsd("anthropic", "claude-opus-5", 1_000_000, 1_000_000)).toEqual({ costUsd: 30, priced: true });
  });

  it("prices OpenAI from the (unverified) table and matches a dated snapshot by prefix", () => {
    expect(OPENAI_PRICES["gpt-4o-mini"]).toEqual({ input: 0.15, output: 0.6 });
    expect(priceFor("openai", "gpt-4o-mini-2024-07-18")).toEqual({ input: 0.15, output: 0.6 });
    expect(estimateCostUsd("openai", "gpt-4o-mini", 620, 90)).toEqual({ costUsd: 0.000147, priced: true });
  });

  it("says so rather than guessing when the model is unknown", () => {
    expect(priceFor("anthropic", "claude-from-the-future")).toBeNull();
    expect(estimateCostUsd("anthropic", "claude-from-the-future", 1000, 1000)).toEqual({ costUsd: 0, priced: false });
  });

  it("reports the cost of the call it just made", async () => {
    const { usage } = await ask(aiStub());
    expect(usage.costUsd).toBeCloseTo(0.00107, 8);
    expect(usage.priced).toBe(true);
    expect(usage.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("the usage ledger", () => {
  it("records every call, successful or not, with tokens and dollars", async () => {
    await ask(aiStub());
    await ask(aiStub({ replies: [{ kind: "error", status: 500, message: "boom" }] })).catch(() => undefined);

    const totals = usageTotals();
    expect(totals.calls).toBe(2);
    expect(totals.failures).toBe(1);
    expect(totals.inputTokens).toBe(620);
    expect(totals.costUsd).toBeCloseTo(0.00107, 8);
    expect(totals.byModel).toEqual([
      expect.objectContaining({ provider: "anthropic", model: "claude-haiku-4-5", calls: 2 }),
    ]);
    expect(totals.byLabel[0]).toMatchObject({ label: "test", calls: 2 });
    expect(totals.windowSize).toBe(500);
    expect(totals.truncated).toBe(false);
    expect(totals.firstAt).not.toBeNull();
  });

  it("keeps only the last 500 calls", async () => {
    const stub = aiStub();
    for (let i = 0; i < USAGE_RING_SIZE + 3; i++) await ask(stub);
    expect(recentCalls()).toHaveLength(USAGE_RING_SIZE);
    const totals = usageTotals();
    expect(totals.calls).toBe(USAGE_RING_SIZE);
    expect(totals.truncated).toBe(true);
  });

  it("counts calls whose model has no price so the dollar figure is not read as complete", async () => {
    await ask(aiStub(), config({ model: "claude-from-the-future" }));
    const totals = usageTotals();
    expect(totals.unpriced).toBe(1);
    expect(totals.costUsd).toBe(0);
  });
});
