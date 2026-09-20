/** The verdict: match, under_reported, over_reported, unavailable — and the detail behind it. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import { db } from "../../db";
import { timeEntries, usageReconciliations } from "../../db/schema";
import { foldUsage, type UsageEntryRow } from "../../server/usage/fold";
import { emptyTotals, type ProviderUsage } from "../../server/usage/providers";
import {
  buildReconciliation,
  classify,
  DEFAULT_TOLERANCE_PCT,
  DEFAULT_TOLERANCE_TOKENS,
  ProviderNotConnected,
  reconcile,
} from "../../server/usage/reconcile";
import type { FakeDb } from "./fake-db";

const fake = db as unknown as FakeDb;
const window = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-30T23:59:59Z") };

beforeEach(() => fake.reset());

describe("classify", () => {
  const base = { available: true, providerTokens: 1_000_000, reportedTokens: 1_000_000, verifiedTokens: 900_000 };

  it("calls an exact agreement a match", () => {
    expect(classify(base).status).toBe("match");
  });

  it("allows the larger of 5% of the provider figure or 10,000 tokens", () => {
    expect(DEFAULT_TOLERANCE_PCT).toBe(5);
    expect(DEFAULT_TOLERANCE_TOKENS).toBe(10_000);
    expect(classify({ ...base, reportedTokens: 960_000 }).status).toBe("match"); // 4%
    expect(classify({ ...base, reportedTokens: 900_000 }).status).toBe("under_reported"); // 10%
    // A tiny period gets the flat allowance, so a handful of tokens is not an accusation.
    expect(classify({ ...base, providerTokens: 20_000, reportedTokens: 12_000 }).status).toBe("match");
  });

  it("calls a ledger short of the provider's bill under-reported, with a positive delta", () => {
    const c = classify({ ...base, reportedTokens: 500_000 });
    expect(c.status).toBe("under_reported");
    expect(c.deltaTokens).toBe(500_000);
    expect(c.deltaPct).toBe(50);
  });

  it("calls a ledger above the provider's bill over-reported, with a negative delta", () => {
    const c = classify({ ...base, reportedTokens: 3_000_000 });
    expect(c.status).toBe("over_reported");
    expect(c.deltaTokens).toBe(-2_000_000);
  });

  it("is unavailable whenever the provider could not be read, whatever the numbers say", () => {
    expect(classify({ ...base, available: false }).status).toBe("unavailable");
    expect(classify({ ...base, available: false, providerTokens: 0 }).status).toBe("unavailable");
  });

  it("honours an explicit tolerance", () => {
    expect(classify({ ...base, reportedTokens: 900_000, tolerancePct: 20 }).status).toBe("match");
    expect(classify({ ...base, reportedTokens: 999_000, tolerancePct: 0, toleranceTokens: 0 }).status).toBe("under_reported");
  });

  it("never reports a negative token total", () => {
    expect(classify({ ...base, providerTokens: -5, reportedTokens: -9 }).providerTokens).toBe(0);
  });
});

function providerUsage(over: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    provider: "anthropic",
    available: true,
    ...emptyTotals(),
    tokens: 1_480_000,
    costUsd: 18.755,
    costAvailable: true,
    pages: 2,
    endpoints: ["/v1/organizations/usage_report/messages", "/v1/organizations/cost_report"],
    byModel: { "claude-opus-5": 1_480_000 },
    ...over,
  };
}

function rows(): UsageEntryRow[] {
  return [
    {
      entryId: 1,
      userId: 6,
      displayName: "Claude Code",
      agentLabel: "Claude Code",
      streamId: 1,
      streamName: "Security audit",
      taskId: 3,
      checkIn: new Date("2026-09-10T09:00:00Z"),
      tokensUsed: 800_000,
      apiCostUsd: 9,
      verifiedTokens: 800_000,
      verifiedCostUsd: 9,
      verifiedSource: "claude_code_hook",
      verifiedAt: new Date(),
    },
    {
      entryId: 2,
      userId: 5,
      displayName: "Orchestrator",
      agentLabel: "Orchestrator",
      streamId: 2,
      streamName: "Checkout",
      taskId: null,
      checkIn: new Date("2026-09-11T09:00:00Z"),
      tokensUsed: 200_000,
      apiCostUsd: 3,
      verifiedTokens: null,
      verifiedCostUsd: null,
      verifiedSource: null,
      verifiedAt: null,
    },
  ];
}

describe("buildReconciliation", () => {
  it("carries both totals, the coverage and the per-agent split into the stored row", () => {
    const summary = foldUsage(rows(), window);
    const built = buildReconciliation("anthropic", window, summary, providerUsage());
    expect(built.status).toBe("under_reported");
    expect(built.reportedTokens).toBe(1_000_000);
    expect(built.providerTokens).toBe(1_480_000);
    expect(built.reportedCostUsd).toBe(12);
    expect(built.providerCostUsd).toBe(18.755);
    expect(built.detail.coveragePct).toBe(50);
    expect(built.detail.verifiedTokens).toBe(800_000);
    expect(built.detail.deltaTokens).toBe(480_000);
    expect(built.detail.byAgent.map((a) => a.name).sort()).toEqual(["Claude Code", "Orchestrator"]);
    expect(built.detail.providerByModel).toEqual({ "claude-opus-5": 1_480_000 });
  });

  it("explains under-reporting as something to look into rather than an accusation", () => {
    const built = buildReconciliation("anthropic", window, foldUsage(rows(), window), providerUsage());
    expect(built.detail.note).toMatch(/outside PTD/);
    expect(built.detail.note).toMatch(/Check coverage/);
  });

  it("warns that over-reporting is usually PTD being over-complete", () => {
    const built = buildReconciliation("anthropic", window, foldUsage(rows(), window), providerUsage({ tokens: 10_000 }));
    expect(built.status).toBe("over_reported");
    expect(built.detail.note).toMatch(/over-complete/);
  });

  it("stores a zero provider cost, not a made-up one, when the cost report was refused", () => {
    const built = buildReconciliation("anthropic", window, foldUsage(rows(), window), providerUsage({ costAvailable: false, costUsd: 99 }));
    expect(built.providerCostUsd).toBe(0);
    expect(built.detail.providerCostAvailable).toBe(false);
  });

  it("passes the provider's error through on an unavailable read", () => {
    const built = buildReconciliation("openai", window, foldUsage(rows(), window), providerUsage({ provider: "openai", available: false, tokens: 0, costAvailable: false, error: "HTTP 401: bad key" }));
    expect(built.status).toBe("unavailable");
    expect(built.detail.providerError).toBe("HTTP 401: bad key");
    expect(built.detail.note).toMatch(/could not be read/);
  });
});

describe("reconcile", () => {
  it("refuses when no key is connected, naming the action that connects one", async () => {
    // readProviderConfig finds no org_integrations row.
    await expect(reconcile(1, "anthropic", window)).rejects.toBeInstanceOf(ProviderNotConnected);
    await expect(reconcile(1, "anthropic", window)).rejects.toThrow(/usage\.connect_provider/);
  });

  it("stores one usage_reconciliations row and returns it with its id", async () => {
    const { encryptSecret } = await import("../../server/crypto");
    const { orgIntegrations } = await import("../../db/schema");
    fake.queue(orgIntegrations, [
      { config: { apiKeySealed: encryptSecret("sk-ant-admin01-x"), keyHint: "…01-x", baseUrl: "https://stub.test", connectedAt: "", connectedBy: 1 }, enabled: true },
    ]);
    fake.queue(timeEntries, rows());
    fake.queue(usageReconciliations, [{ id: 77, createdAt: new Date("2026-09-20T10:00:00Z") }]);

    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      const body = path.endsWith("/messages")
        ? { data: [{ results: [{ model: "claude-opus-5", uncached_input_tokens: 1_480_000 }] }], has_more: false }
        : { data: [{ results: [{ amount: "1875.5" }] }], has_more: false };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await reconcile(1, "anthropic", window, { fetchImpl });
    expect(result.id).toBe(77);
    expect(result.status).toBe("under_reported");
    const written = fake.inserts.at(-1)!.values;
    expect(written).toMatchObject({ orgId: 1, provider: "anthropic", status: "under_reported", reportedTokens: 1_000_000, providerTokens: 1_480_000 });
    expect(written.periodStart).toBeInstanceOf(Date);
  });
});
