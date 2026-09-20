/**
 * Reading a provider's own billing: the parsers, and the fetch loop's refusal to
 * turn a failure into a zero.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_VERSION,
  baseUrlFor,
  fetchProviderUsage,
  nextPageToken,
  sumAnthropicCost,
  sumAnthropicUsage,
  sumOpenAiCost,
  sumOpenAiUsage,
} from "../../server/usage/providers";

const anthropicPage = (over: Record<string, unknown> = {}) => ({
  data: [
    {
      starting_at: "2026-09-01T00:00:00Z",
      ending_at: "2026-09-02T00:00:00Z",
      results: [
        {
          model: "claude-opus-5",
          uncached_input_tokens: 400_000,
          output_tokens: 60_000,
          cache_read_input_tokens: 900_000,
          cache_creation: { ephemeral_5m_input_tokens: 120_000, ephemeral_1h_input_tokens: 5_000 },
          server_tool_use: { web_search_requests: 2 },
        },
      ],
    },
    { starting_at: "2026-09-02T00:00:00Z", ending_at: "2026-09-03T00:00:00Z", results: [] },
  ],
  has_more: false,
  next_page: null,
  ...over,
});

describe("sumAnthropicUsage", () => {
  it("adds all four token kinds, including both cache TTLs", () => {
    const totals = sumAnthropicUsage([anthropicPage()]);
    expect(totals.inputTokens).toBe(400_000);
    expect(totals.outputTokens).toBe(60_000);
    expect(totals.cacheReadTokens).toBe(900_000);
    expect(totals.cacheCreationTokens).toBe(125_000);
    expect(totals.tokens).toBe(1_485_000);
    expect(totals.buckets).toBe(2); // an empty bucket is still a bucket
    expect(totals.byModel["claude-opus-5"]).toBe(1_485_000);
  });

  it("sums across pages and files an un-grouped result under `unattributed`", () => {
    const untagged = { data: [{ results: [{ uncached_input_tokens: 10 }] }], has_more: false };
    const totals = sumAnthropicUsage([anthropicPage(), untagged]);
    expect(totals.tokens).toBe(1_485_010);
    expect(totals.byModel.unattributed).toBe(10);
  });

  it("returns zeroes rather than throwing on a body it does not recognise", () => {
    expect(sumAnthropicUsage([null, {}, { data: "nope" }]).tokens).toBe(0);
  });
});

describe("sumAnthropicCost", () => {
  it("reads the decimal-string amount as cents, because that is what the API sends", () => {
    const page = { data: [{ results: [{ amount: "1875.5", currency: "USD" }, { amount: "24.5", currency: "USD" }] }] };
    expect(sumAnthropicCost([page])).toEqual({ costUsd: 19, items: 2 });
  });
});

describe("sumOpenAiUsage", () => {
  it("does not double-count cached input, which is already inside input_tokens", () => {
    const page = { data: [{ results: [{ model: "gpt-4o", input_tokens: 1_000, input_cached_tokens: 600, output_tokens: 200 }] }] };
    const totals = sumOpenAiUsage([page]);
    expect(totals.tokens).toBe(1_200);
    expect(totals.cacheReadTokens).toBe(600);
  });
});

describe("sumOpenAiCost", () => {
  it("reads amount.value as whole dollars", () => {
    const page = { data: [{ results: [{ amount: { value: 12.5, currency: "usd" } }, { amount: { value: 0.25, currency: "usd" } }] }] };
    expect(sumOpenAiCost([page])).toEqual({ costUsd: 12.75, items: 2 });
  });
});

describe("nextPageToken", () => {
  it("only follows a cursor the provider says exists", () => {
    expect(nextPageToken({ has_more: true, next_page: "page_2" })).toBe("page_2");
    expect(nextPageToken({ has_more: false, next_page: "page_2" })).toBeNull();
    expect(nextPageToken({ has_more: true, next_page: null })).toBeNull();
    expect(nextPageToken(null)).toBeNull();
  });
});

describe("baseUrlFor", () => {
  it("prefers an explicit base URL, then the env override, then the provider's host", () => {
    expect(baseUrlFor("anthropic", { baseUrl: "http://127.0.0.1:4771/" })).toBe("http://127.0.0.1:4771");
    process.env.PTD_USAGE_OPENAI_BASE_URL = "http://stub.local/";
    expect(baseUrlFor("openai")).toBe("http://stub.local");
    delete process.env.PTD_USAGE_OPENAI_BASE_URL;
    expect(baseUrlFor("anthropic")).toBe("https://api.anthropic.com");
    expect(baseUrlFor("openai")).toBe("https://api.openai.com");
  });
});

/** A stub standing in for the provider, so the comparison can be tested with no key and no network. */
function stub(routes: Record<string, unknown>, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, headers: (init?.headers ?? {}) as Record<string, string> });
    const path = new URL(href).pathname;
    const body = routes[path];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("fetchProviderUsage", () => {
  it("reads the Anthropic usage and cost reports with the admin headers", async () => {
    const { fetchImpl, calls } = stub({
      "/v1/organizations/usage_report/messages": anthropicPage(),
      "/v1/organizations/cost_report": { data: [{ results: [{ amount: "1875.5" }] }], has_more: false },
    });
    const usage = await fetchProviderUsage("anthropic", "sk-ant-admin01-x", { from: new Date("2026-09-01"), to: new Date("2026-09-20") }, { fetchImpl, baseUrl: "https://stub.test" });
    expect(usage.available).toBe(true);
    expect(usage.tokens).toBe(1_485_000);
    expect(usage.costAvailable).toBe(true);
    expect(usage.costUsd).toBe(18.755);
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-admin01-x");
    expect(calls[0].headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(calls[0].url).toContain("starting_at=2026-09-01");
    expect(calls[0].url).toContain("bucket_width=1d");
  });

  it("sends OpenAI a bearer token and unix-second bounds", async () => {
    const { fetchImpl, calls } = stub({
      "/v1/organization/usage/completions": { data: [{ results: [{ model: "gpt-4o", input_tokens: 100, output_tokens: 50 }] }], has_more: false },
      "/v1/organization/costs": { data: [{ results: [{ amount: { value: 2 } }] }], has_more: false },
    });
    const usage = await fetchProviderUsage("openai", "sk-admin", { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-02T00:00:00Z") }, { fetchImpl, baseUrl: "https://stub.test" });
    expect(usage.tokens).toBe(150);
    expect(usage.costUsd).toBe(2);
    expect(calls[0].headers.Authorization).toBe("Bearer sk-admin");
    expect(calls[0].url).toContain(`start_time=${Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000)}`);
  });

  it("follows next_page", async () => {
    let served = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/cost_report")) return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
      served += 1;
      const more = served < 3;
      return new Response(JSON.stringify({ data: [{ results: [{ uncached_input_tokens: 100 }] }], has_more: more, next_page: more ? `page_${served}` : null }), { status: 200 });
    }) as unknown as typeof fetch;
    const usage = await fetchProviderUsage("anthropic", "k", { from: new Date("2026-09-01"), to: new Date("2026-09-20") }, { fetchImpl, baseUrl: "https://stub.test" });
    expect(served).toBe(3);
    expect(usage.tokens).toBe(300);
  });

  it("reports a refused key as unavailable rather than as zero usage", async () => {
    const { fetchImpl } = stub({}, 401);
    const usage = await fetchProviderUsage("anthropic", "bad", { from: new Date("2026-09-01"), to: new Date("2026-09-20") }, { fetchImpl, baseUrl: "https://stub.test" });
    expect(usage.available).toBe(false);
    expect(usage.tokens).toBe(0);
    expect(usage.error).toMatch(/HTTP 404|HTTP 401/);
  });

  it("still reports tokens when only the cost report is refused", async () => {
    const { fetchImpl } = stub({ "/v1/organizations/usage_report/messages": anthropicPage() });
    const usage = await fetchProviderUsage("anthropic", "k", { from: new Date("2026-09-01"), to: new Date("2026-09-20") }, { fetchImpl, baseUrl: "https://stub.test" });
    expect(usage.available).toBe(true);
    expect(usage.tokens).toBe(1_485_000);
    expect(usage.costAvailable).toBe(false);
    expect(usage.costUsd).toBe(0);
  });

  it("survives a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const usage = await fetchProviderUsage("openai", "k", { from: new Date("2026-09-01"), to: new Date("2026-09-20") }, { fetchImpl, baseUrl: "https://stub.test" });
    expect(usage.available).toBe(false);
    expect(usage.error).toContain("ECONNREFUSED");
  });
});
