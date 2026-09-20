/**
 * The attestation action, through the registry: who may write one, what may be
 * attested, and what lands in the four verified columns.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

const events: { kind: string; note: string | null; payload?: Record<string, unknown> }[] = [];
vi.mock("../../server/plan/taskEvents", () => ({
  recordEvent: async (args: { kind: string; note: string | null; payload?: Record<string, unknown> }) => {
    events.push(args);
  },
  actorFrom: () => ({ userId: 6, label: "Claude Code (agent)", isAgent: true, via: "mcp" }),
}));
vi.mock("../../server/webhooks", () => ({ dispatchWebhooks: async () => {} }));

import { db } from "../../db";
import { streams, timeEntries } from "../../db/schema";
import { ActionError, runAction, type ActionContext } from "../../server/actions/registry";
import "../../server/actions/usage";
import { resolveCost } from "../../server/usage/attest";
import type { FakeDb } from "./fake-db";

const fake = db as unknown as FakeDb;

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  userId: 6,
  email: "agent_claude_code@agents.ptd.local",
  displayName: "Claude Code",
  orgId: 5,
  role: "member",
  authType: "agent",
  via: "mcp",
  ...over,
});

const entry = (over: Record<string, any> = {}) => ({
  id: 41,
  userId: 6,
  orgId: 5,
  taskId: 3,
  streamId: 1,
  checkIn: new Date("2026-09-20T09:00:00Z"),
  checkOut: new Date("2026-09-20T09:41:00Z"),
  isBreak: false,
  entrySource: "agent",
  agentLabel: "Claude Code",
  tokensUsed: 100_000,
  apiCostUsd: 1,
  verifiedTokens: null,
  verifiedCostUsd: null,
  verifiedSource: null,
  verifiedAt: null,
  ...over,
});

/** attest reads the row, writes it, then re-reads it through the joined view. */
function queueAttest(row: Record<string, any> = entry()) {
  fake.queue(timeEntries, [row]);
  fake.queue(timeEntries, [row]); // the update's RETURNING is unused but drains a queue slot on some paths
  fake.queue(timeEntries, [{ entryId: row.id, ...row }]); // readAttested
}

const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ActionError);

beforeEach(() => {
  fake.reset();
  events.length = 0;
});

describe("resolveCost", () => {
  it("prefers an explicit costUsd, whatever the evidence says", () => {
    const resolved = resolveCost({ tokens: 1_000, costUsd: 12.5, evidence: { model: "claude-opus-5" } });
    expect(resolved).toMatchObject({ costUsd: 12.5, basis: "given" });
  });

  it("prices the tokens from the evidence's model when no cost is given", () => {
    const resolved = resolveCost({ tokens: 1_000_000, evidence: { model: "claude-sonnet-5", inputTokens: 1_000_000 } });
    expect(resolved.basis).toBe("priced");
    expect(resolved.costUsd).toBeCloseTo(2, 6);
  });

  it("leaves the cost unset rather than storing a zero when it cannot be priced", () => {
    const noModel = resolveCost({ tokens: 1_000, evidence: { turns: 4 } });
    expect(noModel.costUsd).toBeNull();
    expect(noModel.basis).toBe("unpriced");
    expect(noModel.note).toMatch(/cost left unset/);

    const unknownModel = resolveCost({ tokens: 1_000, evidence: { model: "llama-3-70b" } });
    expect(unknownModel.costUsd).toBeNull();
    expect(unknownModel.note).toMatch(/not in PTD's price table/);
  });
});

describe("time_entry.attest", () => {
  it("writes the four verified columns and leaves the self-reported pair alone", async () => {
    queueAttest();
    const result = (await runAction(
      "time_entry.attest",
      { entryId: 41, tokens: 241_700, source: "claude_code_hook", evidence: { model: "claude-opus-5", inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 200_000, cacheCreationTokens: 40_200, turns: 14, transcriptSha256: "abc" } },
      ctx(),
    )) as any;

    const written = fake.updates.at(-1)!.values;
    expect(written.verifiedTokens).toBe(241_700);
    expect(written.verifiedSource).toBe("claude_code_hook");
    expect(written.verifiedAt).toBeInstanceOf(Date);
    expect(written.verifiedCostUsd).toBeGreaterThan(0);
    // The claim survives the evidence — that is the whole point.
    expect(written).not.toHaveProperty("tokensUsed");
    expect(written).not.toHaveProperty("apiCostUsd");

    expect(result.reported).toEqual({ tokens: 100_000, costUsd: 1 });
    expect(result.delta.tokens).toBe(141_700);
    expect(result.costBasis).toBe("priced");
    expect(result.reattested).toBe(false);
  });

  it("records a time_logged history line naming the source and the gap", async () => {
    queueAttest();
    await runAction("time_entry.attest", { entryId: 41, tokens: 150_000, costUsd: 1.5, source: "ci" }, ctx());
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("time_logged");
    expect(events[0].note).toBe("usage attested (ci): 150000 tok · $1.50 · reported 100000 tok (+50000)");
    expect(events[0].payload).toMatchObject({ attestation: true, entryId: 41, source: "ci", deltaTokens: 50_000 });
  });

  it("writes no history line for an entry attached to no card", async () => {
    queueAttest(entry({ taskId: null }));
    await runAction("time_entry.attest", { entryId: 41, tokens: 10, source: "ci" }, ctx());
    expect(events).toHaveLength(0);
  });

  it("refuses a human-sourced entry — verified usage would mean nothing on one", async () => {
    fake.queue(timeEntries, [entry({ entrySource: "human", agentLabel: null, userId: 2 })]);
    const err = await failure(runAction("time_entry.attest", { entryId: 41, tokens: 10, source: "ci" }, ctx({ userId: 2, authType: "human", role: "owner" })));
    expect(err?.code).toBe("invalid");
    expect(err?.message).toMatch(/human-sourced/);
    expect(fake.updates).toHaveLength(0);
  });

  it("refuses a running entry, which has no final figure yet", async () => {
    fake.queue(timeEntries, [entry({ checkOut: null })]);
    const err = await failure(runAction("time_entry.attest", { entryId: 41, tokens: 10, source: "ci" }, ctx()));
    expect(err?.code).toBe("invalid");
    expect(err?.message).toMatch(/still running/);
  });

  it("refuses a member another member's entry, and lets a manager through", async () => {
    fake.queue(timeEntries, [entry({ userId: 99 })]);
    const err = await failure(runAction("time_entry.attest", { entryId: 41, tokens: 10, source: "ci" }, ctx()));
    expect(err?.code).toBe("forbidden");

    queueAttest(entry({ userId: 99 }));
    await expect(runAction("time_entry.attest", { entryId: 41, tokens: 10, source: "ci" }, ctx({ role: "manager" }))).resolves.toBeTruthy();
  });

  it("says not_found for an entry outside the caller's organization", async () => {
    const err = await failure(runAction("time_entry.attest", { entryId: 41, tokens: 10, source: "ci" }, ctx()));
    expect(err?.code).toBe("not_found");
  });

  it("is idempotent: a second attestation replaces the first and says so", async () => {
    queueAttest(entry({ verifiedTokens: 111, verifiedSource: "ci", verifiedAt: new Date() }));
    const result = (await runAction("time_entry.attest", { entryId: 41, tokens: 222, source: "claude_code_hook" }, ctx())) as any;
    expect(result.reattested).toBe(true);
    expect(fake.updates.at(-1)!.values.verifiedTokens).toBe(222);
  });

  it("rejects an unknown source and a negative token count at the schema", async () => {
    expect((await failure(runAction("time_entry.attest", { entryId: 41, tokens: 10, source: "vibes" }, ctx())))?.code).toBe("invalid");
    expect((await failure(runAction("time_entry.attest", { entryId: 41, tokens: -5, source: "ci" }, ctx())))?.code).toBe("invalid");
  });
});

describe("usage.price", () => {
  it("prices a split without touching the database", async () => {
    const result = (await runAction(
      "usage.price",
      { model: "claude-opus-5", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      ctx(),
    )) as any;
    expect(result.priced).toBe(true);
    expect(result.provider).toBe("anthropic");
    expect(result.tokens).toBe(1_000_000);
    expect(result.costUsd).toBeCloseTo(5, 6);
  });

  it("answers priced:false for a model it has never heard of", async () => {
    const result = (await runAction("usage.price", { model: "llama-3-70b", inputTokens: 5_000_000 }, ctx())) as any;
    expect(result.priced).toBe(false);
    expect(result.costUsd).toBe(0);
  });
});

describe("stream.set_budget", () => {
  it("refuses a member and refuses an empty patch", async () => {
    expect((await failure(runAction("stream.set_budget", { streamId: 1, budgetMode: "enforce" }, ctx())))?.code).toBe("forbidden");
    expect((await failure(runAction("stream.set_budget", { streamId: 1 }, ctx({ role: "manager" }))))?.code).toBe("invalid");
  });

  it("says not_found for a stream in another organization", async () => {
    const err = await failure(runAction("stream.set_budget", { streamId: 1, budgetMode: "enforce" }, ctx({ role: "manager" })));
    expect(err?.code).toBe("not_found");
  });

  it("writes only the fields it was given", async () => {
    fake.queue(streams, [{ id: 1, name: "Security audit", agentBudgetUsd: 40, budgetMode: "alert" }]);
    fake.queue(streams, []); // the UPDATE's own (unused) result
    fake.queue(streams, [{ id: 1, name: "Security audit", agentBudgetUsd: 40, budgetMode: "enforce", archived: false }]);
    fake.queue(timeEntries, [{ streamId: 1, cost: "12", tokens: "1000" }]);
    const result = (await runAction("stream.set_budget", { streamId: 1, budgetMode: "enforce" }, ctx({ role: "manager" }))) as any;
    expect(fake.updates.at(-1)!.values).toEqual({ budgetMode: "enforce" });
    expect(result.stream).toMatchObject({ mode: "enforce", budgetUsd: 40, spentUsd: 12, burnPct: 30, enforced: true, blocked: false });
  });

  it("removes a ceiling when passed null", async () => {
    fake.queue(streams, [{ id: 2, name: "Quiet", agentBudgetUsd: 40, budgetMode: "alert" }]);
    fake.queue(streams, []); // the UPDATE's own (unused) result
    fake.queue(streams, [{ id: 2, name: "Quiet", agentBudgetUsd: null, budgetMode: "alert", archived: false }]);
    fake.queue(timeEntries, []);
    await runAction("stream.set_budget", { streamId: 2, agentBudgetUsd: null }, ctx({ role: "manager" }));
    expect(fake.updates.at(-1)!.values).toEqual({ agentBudgetUsd: null });
  });
});

describe("budget.check", () => {
  it("answers one stream's standing", async () => {
    fake.queue(streams, [{ id: 1, name: "Security audit", agentBudgetUsd: 10, budgetMode: "enforce", archived: false }]);
    fake.queue(timeEntries, [{ streamId: 1, cost: "4", tokens: "10" }]);
    const result = (await runAction("budget.check", { streamId: 1 }, ctx())) as any;
    expect(result).toMatchObject({ streamId: 1, mode: "enforce", budgetUsd: 10, spentUsd: 4, remainingUsd: 6, enforced: true, blocked: false });
  });

  it("answers every live lane plus the blocked list when given no stream", async () => {
    fake.queue(streams, [
      { id: 1, name: "A", agentBudgetUsd: 1, budgetMode: "enforce", archived: false },
      { id: 2, name: "B", agentBudgetUsd: null, budgetMode: "alert", archived: false },
    ]);
    fake.queue(timeEntries, [{ streamId: 1, cost: "5", tokens: "10" }]);
    const result = (await runAction("budget.check", {}, ctx())) as any;
    expect(result.blocked).toEqual([1]);
    expect(result.totals).toMatchObject({ streams: 2, budgeted: 1, enforced: 1, spentUsd: 5, budgetUsd: 1 });
  });

  it("says not_found for a stream that is not live in this organization", async () => {
    fake.queue(streams, []);
    fake.queue(timeEntries, []);
    expect((await failure(runAction("budget.check", { streamId: 404 }, ctx())))?.code).toBe("not_found");
  });
});
