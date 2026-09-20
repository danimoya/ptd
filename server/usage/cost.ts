/**
 * What a reported token count is worth in dollars.
 *
 * `server/ai/pricing.ts` is the one price table in PTD and it stays that way:
 * this module only adds the two things a *session* has that a single AI call
 * does not — cache traffic, and a model name that has to be mapped back to a
 * provider before the table can be read.
 *
 * Cache multipliers are Anthropic's published ratios against the base input
 * rate (a 5-minute cache write costs 1.25×, a 1-hour write 2×, a read 0.1×).
 * They are applied here rather than folded into the table because the table is
 * per-call pricing that the priority suggester also reads, and a suggestion
 * never writes a cache entry.
 */

import { estimateCostUsd, priceFor, type AiProviderName } from "../ai/pricing";

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER: Record<"5m" | "1h", number> = { "5m": 1.25, "1h": 2 };

/** The four token kinds a Claude Code transcript reports. */
export interface TokenSplit {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** TTL of the cache writes; 5 minutes is Claude Code's default. */
  cacheTtl: "5m" | "1h";
}

export interface SessionCost {
  costUsd: number;
  /** false when the model is unknown to the table — costUsd is then 0, never a guess. */
  priced: boolean;
  provider: AiProviderName | null;
  model: string | null;
}

export function emptySplit(): TokenSplit {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheTtl: "5m" };
}

/** Sum of every kind — the number stored in `tokens_used` / `verified_tokens`. */
export function totalTokens(split: TokenSplit): number {
  return Math.max(0, Math.round(split.inputTokens + split.outputTokens + split.cacheReadTokens + split.cacheCreationTokens));
}

/**
 * Which price table a model belongs to. Deliberately conservative: an
 * unrecognised name returns null and the caller records "not priced" rather
 * than inventing a rate.
 */
export function providerForModel(model: string | null | undefined): AiProviderName | null {
  if (!model) return null;
  const m = model.trim().toLowerCase();
  if (m.startsWith("claude") || m.startsWith("anthropic.") || m.includes("anthropic")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("chatgpt")) return "openai";
  return null;
}

/** Number coercion that never yields NaN — postgres.js hands SUM() back as a string. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/**
 * Cost of one session from its token split.
 *
 * Cache traffic is priced off the model's *input* rate, which is why this
 * cannot simply call estimateCostUsd with a summed input figure.
 */
export function costForSplit(model: string | null | undefined, split: TokenSplit): SessionCost {
  const provider = providerForModel(model);
  if (!provider || !model) return { costUsd: 0, priced: false, provider, model: model ?? null };
  const price = priceFor(provider, model);
  if (!price) return { costUsd: 0, priced: false, provider, model };
  const base = estimateCostUsd(provider, model, split.inputTokens, split.outputTokens);
  const writeMultiplier = CACHE_WRITE_MULTIPLIER[split.cacheTtl] ?? CACHE_WRITE_MULTIPLIER["5m"];
  const cache =
    (split.cacheReadTokens / 1_000_000) * price.input * CACHE_READ_MULTIPLIER +
    (split.cacheCreationTokens / 1_000_000) * price.input * writeMultiplier;
  return { costUsd: round6(base.costUsd + cache), priced: base.priced, provider, model };
}

/** Accept a key in either spelling, because hooks and CI runners disagree. */
function pick(source: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const raw = source[name];
    if (raw === undefined || raw === null) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Read a token split out of an attestation's `evidence` object.
 *
 * Evidence is free-form by design — it is whatever the attester can prove with
 * — so this reads the keys the shipped hook and the CLI write (both spellings
 * of each) and falls back to treating the attested `tokens` total as input,
 * which prices a session conservatively rather than refusing to price it.
 */
export function splitFromEvidence(tokens: number, evidence: Record<string, unknown> | null | undefined): TokenSplit {
  const e = (evidence ?? {}) as Record<string, unknown>;
  const nested = (e.usage && typeof e.usage === "object" ? (e.usage as Record<string, unknown>) : {}) as Record<string, unknown>;
  const source = { ...nested, ...e };

  const input = pick(source, "inputTokens", "input_tokens", "uncachedInputTokens", "uncached_input_tokens");
  const output = pick(source, "outputTokens", "output_tokens");
  const cacheRead = pick(source, "cacheReadTokens", "cache_read_input_tokens", "cacheReadInputTokens") ?? 0;
  const cacheWrite = pick(source, "cacheCreationTokens", "cache_creation_input_tokens", "cacheCreationInputTokens") ?? 0;
  const ttl = typeof source.cacheTtl === "string" && source.cacheTtl === "1h" ? "1h" : "5m";

  if (input === undefined && output === undefined) {
    // Nothing itemised: the whole attested figure is treated as input tokens.
    return { inputTokens: Math.max(0, tokens - cacheRead - cacheWrite), outputTokens: 0, cacheReadTokens: cacheRead, cacheCreationTokens: cacheWrite, cacheTtl: ttl };
  }
  return {
    inputTokens: Math.max(0, input ?? 0),
    outputTokens: Math.max(0, output ?? 0),
    cacheReadTokens: Math.max(0, cacheRead),
    cacheCreationTokens: Math.max(0, cacheWrite),
    cacheTtl: ttl,
  };
}

/** The model named in an attestation's evidence, if it named one. */
export function modelFromEvidence(evidence: Record<string, unknown> | null | undefined): string | null {
  const e = (evidence ?? {}) as Record<string, unknown>;
  for (const key of ["model", "modelId", "model_id"]) {
    const raw = e[key];
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  }
  return null;
}
