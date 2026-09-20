/**
 * Reading usage from the model provider itself.
 *
 * This is the strongest evidence PTD can get: the organization's own billing
 * data, fetched with an admin credential the *humans* control, compared against
 * what the agents said. An agent cannot forge it, because an agent never holds
 * the admin key — `usage.connect_provider` is admin-only and the key is sealed
 * with PTD_SECRET_KEY at rest.
 *
 * Both providers expose the same shape of thing (time buckets of token counts,
 * and a separate cost report in money), so the parsers below are pure functions
 * over already-fetched pages and the transport is one small `fetch` loop. That
 * split is what lets the comparison be unit-tested against a local stub with no
 * key and no network.
 *
 * Endpoints, as of 2026-09:
 *   Anthropic  GET /v1/organizations/usage_report/messages   (x-api-key, anthropic-version: 2023-06-01)
 *              GET /v1/organizations/cost_report              amounts are decimal strings in CENTS
 *   OpenAI     GET /v1/organization/usage/completions         (Authorization: Bearer, unix seconds)
 *              GET /v1/organization/costs                     amount: {value, currency} in dollars
 */

import { num } from "./cost";

export const USAGE_PROVIDERS = ["anthropic", "openai"] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];

export const DEFAULT_BASE_URL: Record<UsageProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

export const ANTHROPIC_VERSION = "2023-06-01";
/** A 1d bucket_width caps at 31 buckets on both providers, so a window is at most a month per page. */
export const MAX_PAGES = 12;
const TIMEOUT_MS = 20_000;

export interface ProviderWindow {
  from: Date;
  to: Date;
}

export interface ProviderTotals {
  tokens: number;
  /** Itemised, for the reconciliation detail blob. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  buckets: number;
  byModel: Record<string, number>;
}

export interface ProviderUsage extends ProviderTotals {
  provider: UsageProvider;
  /** false when the provider could not be read at all — the reconciliation is then `unavailable`. */
  available: boolean;
  costUsd: number;
  costAvailable: boolean;
  pages: number;
  error?: string;
  /** Endpoints actually called, so a failed reconciliation says where it looked. */
  endpoints: string[];
}

export function emptyTotals(): ProviderTotals {
  return { tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, buckets: 0, byModel: {} };
}

/* ── Pure parsers ────────────────────────────────────────────────────── */

interface Bucketed {
  data?: unknown;
  has_more?: unknown;
  next_page?: unknown;
}

function buckets(page: unknown): Record<string, unknown>[] {
  const p = page as Bucketed | null;
  return Array.isArray(p?.data) ? (p!.data as Record<string, unknown>[]) : [];
}

function results(bucket: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(bucket.results) ? (bucket.results as Record<string, unknown>[]) : [];
}

export function nextPageToken(page: unknown): string | null {
  const p = page as Bucketed | null;
  if (!p || p.has_more !== true) return null;
  return typeof p.next_page === "string" && p.next_page !== "" ? p.next_page : null;
}

/**
 * Anthropic `usage_report/messages`: one result per group, four token kinds.
 * `cache_creation` is an object of per-TTL counts.
 */
export function sumAnthropicUsage(pages: unknown[]): ProviderTotals {
  const out = emptyTotals();
  for (const page of pages) {
    for (const bucket of buckets(page)) {
      out.buckets += 1;
      for (const r of results(bucket)) {
        const creation = (r.cache_creation ?? {}) as Record<string, unknown>;
        const input = num(r.uncached_input_tokens);
        const output = num(r.output_tokens);
        const cacheRead = num(r.cache_read_input_tokens);
        const cacheWrite = num(creation.ephemeral_5m_input_tokens) + num(creation.ephemeral_1h_input_tokens);
        out.inputTokens += input;
        out.outputTokens += output;
        out.cacheReadTokens += cacheRead;
        out.cacheCreationTokens += cacheWrite;
        const model = typeof r.model === "string" ? r.model : "unattributed";
        out.byModel[model] = (out.byModel[model] ?? 0) + input + output + cacheRead + cacheWrite;
      }
    }
  }
  out.tokens = out.inputTokens + out.outputTokens + out.cacheReadTokens + out.cacheCreationTokens;
  return out;
}

/** Anthropic `cost_report`: `amount` is a decimal string in the currency's lowest unit (cents). */
export function sumAnthropicCost(pages: unknown[]): { costUsd: number; items: number } {
  let cents = 0;
  let items = 0;
  for (const page of pages) {
    for (const bucket of buckets(page)) {
      for (const r of results(bucket)) {
        cents += num(r.amount);
        items += 1;
      }
    }
  }
  return { costUsd: Math.round((cents / 100) * 1_000_000) / 1_000_000, items };
}

/**
 * OpenAI `organization/usage/completions`. `input_tokens` already includes
 * `input_cached_tokens`, so the cached figure is reported for the detail blob
 * but not added again to the total.
 */
export function sumOpenAiUsage(pages: unknown[]): ProviderTotals {
  const out = emptyTotals();
  for (const page of pages) {
    for (const bucket of buckets(page)) {
      out.buckets += 1;
      for (const r of results(bucket)) {
        const input = num(r.input_tokens);
        const output = num(r.output_tokens);
        const cached = num(r.input_cached_tokens);
        out.inputTokens += input;
        out.outputTokens += output;
        out.cacheReadTokens += cached;
        const model = typeof r.model === "string" ? r.model : "unattributed";
        out.byModel[model] = (out.byModel[model] ?? 0) + input + output;
      }
    }
  }
  out.tokens = out.inputTokens + out.outputTokens;
  return out;
}

/** OpenAI `organization/costs`: `amount: {value, currency}` in whole dollars. */
export function sumOpenAiCost(pages: unknown[]): { costUsd: number; items: number } {
  let total = 0;
  let items = 0;
  for (const page of pages) {
    for (const bucket of buckets(page)) {
      for (const r of results(bucket)) {
        const amount = (r.amount ?? {}) as Record<string, unknown>;
        total += num(amount.value);
        items += 1;
      }
    }
  }
  return { costUsd: Math.round(total * 1_000_000) / 1_000_000, items };
}

/* ── Transport ───────────────────────────────────────────────────────── */

export interface ProviderDeps {
  fetchImpl?: typeof fetch;
  /** Point at a stub. Falls back to the env override, then the provider's real host. */
  baseUrl?: string;
  timeoutMs?: number;
}

export function baseUrlFor(provider: UsageProvider, deps: ProviderDeps = {}): string {
  const env = provider === "anthropic" ? process.env.PTD_USAGE_ANTHROPIC_BASE_URL : process.env.PTD_USAGE_OPENAI_BASE_URL;
  const raw = deps.baseUrl || env || DEFAULT_BASE_URL[provider];
  return raw.replace(/\/+$/, "");
}

function headersFor(provider: UsageProvider, apiKey: string): Record<string, string> {
  if (provider === "anthropic") {
    return { Accept: "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "User-Agent": "ptd-usage-reconciliation/1" };
  }
  return { Accept: "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": "ptd-usage-reconciliation/1" };
}

async function getJson(url: string, headers: Record<string, string>, deps: ProviderDeps): Promise<unknown> {
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await doFetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}${text ? `: ${text.slice(0, 300)}` : ""}`);
    return text === "" ? null : JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Walk `next_page` until the provider says there is no more, or MAX_PAGES. */
async function fetchAllPages(url: URL, headers: Record<string, string>, deps: ProviderDeps): Promise<{ pages: unknown[]; endpoint: string }> {
  const pages: unknown[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const next = new URL(url.toString());
    if (cursor) next.searchParams.set("page", cursor);
    const page = await getJson(next.toString(), headers, deps);
    pages.push(page);
    cursor = nextPageToken(page);
    if (!cursor) break;
  }
  return { pages, endpoint: `${url.pathname}` };
}

function anthropicUrls(base: string, window: ProviderWindow): { usage: URL; cost: URL } {
  const usage = new URL(`${base}/v1/organizations/usage_report/messages`);
  usage.searchParams.set("starting_at", window.from.toISOString());
  usage.searchParams.set("ending_at", window.to.toISOString());
  usage.searchParams.set("bucket_width", "1d");
  usage.searchParams.set("limit", "31");
  usage.searchParams.append("group_by[]", "model");
  const cost = new URL(`${base}/v1/organizations/cost_report`);
  cost.searchParams.set("starting_at", window.from.toISOString());
  cost.searchParams.set("ending_at", window.to.toISOString());
  cost.searchParams.set("bucket_width", "1d");
  cost.searchParams.set("limit", "31");
  return { usage, cost };
}

function openAiUrls(base: string, window: ProviderWindow): { usage: URL; cost: URL } {
  const start = String(Math.floor(window.from.getTime() / 1000));
  const end = String(Math.floor(window.to.getTime() / 1000));
  const usage = new URL(`${base}/v1/organization/usage/completions`);
  usage.searchParams.set("start_time", start);
  usage.searchParams.set("end_time", end);
  usage.searchParams.set("bucket_width", "1d");
  usage.searchParams.set("limit", "31");
  usage.searchParams.append("group_by[]", "model");
  const cost = new URL(`${base}/v1/organization/costs`);
  cost.searchParams.set("start_time", start);
  cost.searchParams.set("end_time", end);
  cost.searchParams.set("bucket_width", "1d");
  cost.searchParams.set("limit", "31");
  return { usage, cost };
}

/**
 * One provider's usage and cost for a window.
 *
 * Never throws: a dead endpoint, a refused key or an unparseable body all come
 * back as `available: false` with the provider's own words in `error`, which is
 * what `usage.reconcile` stores as status `unavailable`. A silent zero would be
 * indistinguishable from "the agents spent nothing", which is the one reading
 * this feature must not produce.
 */
export async function fetchProviderUsage(
  provider: UsageProvider,
  apiKey: string,
  window: ProviderWindow,
  deps: ProviderDeps = {},
): Promise<ProviderUsage> {
  const base = baseUrlFor(provider, deps);
  const headers = headersFor(provider, apiKey);
  const urls = provider === "anthropic" ? anthropicUrls(base, window) : openAiUrls(base, window);
  const endpoints: string[] = [];

  let totals = emptyTotals();
  let pages = 0;
  try {
    const fetched = await fetchAllPages(urls.usage, headers, deps);
    endpoints.push(fetched.endpoint);
    pages += fetched.pages.length;
    totals = provider === "anthropic" ? sumAnthropicUsage(fetched.pages) : sumOpenAiUsage(fetched.pages);
  } catch (err) {
    return {
      provider,
      available: false,
      ...emptyTotals(),
      costUsd: 0,
      costAvailable: false,
      pages,
      endpoints,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Cost is a separate report and a separate permission on both providers, so a
  // usable token figure is not held hostage to it.
  let costUsd = 0;
  let costAvailable = false;
  try {
    const fetched = await fetchAllPages(urls.cost, headers, deps);
    endpoints.push(fetched.endpoint);
    pages += fetched.pages.length;
    const summed = provider === "anthropic" ? sumAnthropicCost(fetched.pages) : sumOpenAiCost(fetched.pages);
    costUsd = summed.costUsd;
    costAvailable = true;
  } catch {
    costAvailable = false;
  }

  return { provider, available: true, ...totals, costUsd, costAvailable, pages, endpoints };
}
