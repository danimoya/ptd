/** Pricing a session: provider inference, the cache multipliers, and evidence parsing. */
import { describe, expect, it } from "vitest";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  costForSplit,
  emptySplit,
  modelFromEvidence,
  num,
  providerForModel,
  splitFromEvidence,
  totalTokens,
} from "../../server/usage/cost";
import { ANTHROPIC_PRICES } from "../../server/ai/pricing";

describe("providerForModel", () => {
  it("routes Claude ids to the Anthropic table and GPT ids to OpenAI's", () => {
    expect(providerForModel("claude-opus-5")).toBe("anthropic");
    expect(providerForModel("anthropic.claude-sonnet-5")).toBe("anthropic");
    expect(providerForModel("gpt-4o-mini")).toBe("openai");
    expect(providerForModel("o3-mini")).toBe("openai");
  });

  it("returns null for anything it does not recognise, rather than guessing", () => {
    expect(providerForModel("llama-3-70b")).toBeNull();
    expect(providerForModel("")).toBeNull();
    expect(providerForModel(null)).toBeNull();
  });
});

describe("costForSplit", () => {
  const model = "claude-opus-5";
  const price = ANTHROPIC_PRICES[model];

  it("prices input and output off the table", () => {
    const cost = costForSplit(model, { ...emptySplit(), inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost.priced).toBe(true);
    expect(cost.costUsd).toBeCloseTo(price.input + price.output, 6);
  });

  it("prices a cache read at a tenth of the input rate", () => {
    const cost = costForSplit(model, { ...emptySplit(), cacheReadTokens: 1_000_000 });
    expect(cost.costUsd).toBeCloseTo(price.input * CACHE_READ_MULTIPLIER, 6);
  });

  it("prices a 5-minute cache write at 1.25x input and a 1-hour write at 2x", () => {
    const short = costForSplit(model, { ...emptySplit(), cacheCreationTokens: 1_000_000, cacheTtl: "5m" });
    const long = costForSplit(model, { ...emptySplit(), cacheCreationTokens: 1_000_000, cacheTtl: "1h" });
    expect(short.costUsd).toBeCloseTo(price.input * CACHE_WRITE_MULTIPLIER["5m"], 6);
    expect(long.costUsd).toBeCloseTo(price.input * CACHE_WRITE_MULTIPLIER["1h"], 6);
    expect(long.costUsd).toBeGreaterThan(short.costUsd);
  });

  it("reports an unknown model as unpriced with a zero cost, never a guess", () => {
    const cost = costForSplit("mistral-large", { ...emptySplit(), inputTokens: 5_000_000 });
    expect(cost.priced).toBe(false);
    expect(cost.costUsd).toBe(0);
    expect(cost.provider).toBeNull();
  });

  it("prices a pinned snapshot id off its prefix", () => {
    const cost = costForSplit("gpt-4o-mini-2024-07-18", { ...emptySplit(), inputTokens: 1_000_000 });
    expect(cost.priced).toBe(true);
    expect(cost.costUsd).toBeGreaterThan(0);
  });
});

describe("splitFromEvidence", () => {
  it("reads camelCase and snake_case alike", () => {
    const camel = splitFromEvidence(0, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 });
    const snake = splitFromEvidence(0, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 });
    expect(camel).toEqual(snake);
    expect(totalTokens(camel)).toBe(100);
  });

  it("unwraps a nested usage block", () => {
    const split = splitFromEvidence(0, { usage: { input_tokens: 7, output_tokens: 3 } });
    expect(split.inputTokens).toBe(7);
    expect(split.outputTokens).toBe(3);
  });

  it("treats an un-itemised total as input, minus any cache traffic it did name", () => {
    expect(splitFromEvidence(1_000, {})).toMatchObject({ inputTokens: 1_000, outputTokens: 0 });
    expect(splitFromEvidence(1_000, { cacheReadTokens: 400 })).toMatchObject({ inputTokens: 600, cacheReadTokens: 400 });
  });

  it("never produces a negative component", () => {
    expect(splitFromEvidence(10, { cacheReadTokens: 900 }).inputTokens).toBe(0);
  });

  it("honours a 1h cache TTL and defaults to 5m", () => {
    expect(splitFromEvidence(0, { inputTokens: 1, cacheTtl: "1h" }).cacheTtl).toBe("1h");
    expect(splitFromEvidence(0, { inputTokens: 1 }).cacheTtl).toBe("5m");
    expect(splitFromEvidence(0, { inputTokens: 1, cacheTtl: "nonsense" }).cacheTtl).toBe("5m");
  });
});

describe("modelFromEvidence", () => {
  it("finds a model under any of its spellings, and nothing otherwise", () => {
    expect(modelFromEvidence({ model: " claude-opus-5 " })).toBe("claude-opus-5");
    expect(modelFromEvidence({ model_id: "gpt-4o" })).toBe("gpt-4o");
    expect(modelFromEvidence({ turns: 3 })).toBeNull();
    expect(modelFromEvidence(undefined)).toBeNull();
  });
});

describe("num", () => {
  it("coerces the strings postgres.js returns for SUM(), and never yields NaN", () => {
    expect(num("1234")).toBe(1234);
    expect(num(null)).toBe(0);
    expect(num("not a number")).toBe(0);
    expect(num(undefined)).toBe(0);
  });
});
