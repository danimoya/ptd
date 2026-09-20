/**
 * Token prices, in US dollars per million tokens.
 *
 * PTD bills nobody for this — the table exists so `task.suggest_priority` can
 * tell a manager what a suggestion cost before they run the same thing over a
 * hundred cards. It is a small static table on purpose: neither provider
 * publishes a price endpoint, so the alternative is a network call per
 * suggestion, and a wrong-but-labelled estimate is more useful than none.
 *
 * Anthropic figures are the first-party API rates from the `claude-api` skill's
 * model table (cached 2026-06-24). Partner platforms (Bedrock, Vertex) price
 * separately, so a PTD_AI_BASE_URL pointed at one of those will be costed with
 * first-party numbers — the response carries `priced: false` for anything the
 * table does not know, and an unknown model is costed as zero rather than
 * guessed.
 *
 * OpenAI figures are from memory and SHOULD BE VERIFIED against
 * https://openai.com/api/pricing before anyone quotes them at a customer.
 */

export type AiProviderName = "anthropic" | "openai";

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

/**
 * Anthropic first-party rates, per the claude-api skill's "Current Models"
 * table (cached 2026-06-24).
 */
export const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-mythos-5-1": { input: 10, output: 50 },
};

/**
 * OpenAI rates — from memory, unverified. Check openai.com/api/pricing before
 * relying on these; an entry that drifts makes the dollar figure wrong but
 * nothing else (the suggestion itself does not read the price).
 */
export const OPENAI_PRICES: Record<string, ModelPrice> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
};

/**
 * Default model per provider.
 *
 * Anthropic: Claude Haiku 4.5 is the fast/cheap tier in the skill's table
 * ($1/$5 per MTok) and scoring one card off a 300-token brief is exactly the
 * shape of work it is for. Anyone who wants Opus sets PTD_AI_MODEL.
 */
export const DEFAULT_MODELS: Record<AiProviderName, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
};

export function pricesFor(provider: AiProviderName): Record<string, ModelPrice> {
  return provider === "anthropic" ? ANTHROPIC_PRICES : OPENAI_PRICES;
}

/**
 * Price for one model, or null when the table has never heard of it. A dated
 * snapshot id (`gpt-4o-mini-2024-07-18`) falls back to the longest known prefix
 * so a pinned snapshot is still costed.
 */
export function priceFor(provider: AiProviderName, model: string): ModelPrice | null {
  const table = pricesFor(provider);
  const exact = table[model];
  if (exact) return exact;
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(table)) {
    if (!model.startsWith(key)) continue;
    if (!best || key.length > best.key.length) best = { key, price };
  }
  return best?.price ?? null;
}

export interface CostEstimate {
  costUsd: number;
  /** false when the model is not in the table — costUsd is then 0, not a guess. */
  priced: boolean;
}

/** Cost of one call, rounded to the millionth of a dollar (sub-cent calls are the norm). */
export function estimateCostUsd(
  provider: AiProviderName,
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  const price = priceFor(provider, model);
  if (!price) return { costUsd: 0, priced: false };
  const raw = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
  return { costUsd: Math.round(raw * 1_000_000) / 1_000_000, priced: true };
}
