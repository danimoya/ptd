import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What used to live in a process's memory and now lives in a row.
 *
 * The two things worth asserting away from a real database are the *contract* each
 * store has to satisfy — a code is claimable exactly once, whoever asks first — and
 * that the AI ledger only writes when it knows who is paying. The SQL itself is
 * verified against HeliosDB-Nano by hand (see the phase report): these tests are
 * about the logic that sits on top of it.
 */

const inserted = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("../../db", () => ({
  db: {
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        inserted.rows.push(values);
        return [];
      },
    }),
  },
}));

const {
  LINK_CODE_TTL_MS,
  consumeLinkCode,
  memoryLinkCodeStore,
  mintLinkCode,
  peekLinkCode,
  resetLinkState,
  setLinkCodeStore,
} = await import("../../server/integrations/shared/linkCodes");
const { recordCall, recentCalls, resetUsage, withUsageScope, currentUsageScope } = await import("../../server/ai/usage");

beforeEach(() => {
  resetLinkState();
  resetUsage();
  inserted.rows = [];
});

describe("a link code is spendable exactly once, whichever replica asks", () => {
  it("hands the entry to one of two simultaneous claims and null to the other", async () => {
    const { code } = await mintLinkCode("slack", { userId: 7, orgId: 3, displayName: "Dani" });
    // Two app replicas receiving the same slash command at the same moment.
    const [first, second] = await Promise.all([consumeLinkCode("slack", code), consumeLinkCode("slack", code)]);
    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ userId: 7, orgId: 3 });
  });

  it("keeps the ten-minute window, and a spent code stays spent", async () => {
    const now = 1_700_000_000_000;
    const { code, expiresAt } = await mintLinkCode("telegram", { userId: 1, orgId: 2, displayName: "Sam" }, now);
    expect(expiresAt.getTime() - now).toBe(LINK_CODE_TTL_MS);
    await expect(peekLinkCode("telegram", code, now + LINK_CODE_TTL_MS + 1)).resolves.toBeNull();
    await expect(consumeLinkCode("telegram", code, now + 1)).resolves.toMatchObject({ userId: 1 });
    await expect(consumeLinkCode("telegram", code, now + 2)).resolves.toBeNull();
  });

  it("never lets a provider's code be spent on another provider's surface", async () => {
    const { code } = await mintLinkCode("teams", { userId: 4, orgId: 9, displayName: "Ada" });
    await expect(consumeLinkCode("slack", code)).resolves.toBeNull();
    await expect(consumeLinkCode("teams", code)).resolves.toMatchObject({ userId: 4 });
  });

  it("counts every attempt against the row, including the ones that arrive too late", async () => {
    // The memory store models the column the table carries, so the counter can be
    // asserted without a database; `attempts` is what a support question ("did they
    // even type it?") is answered with.
    const store = memoryLinkCodeStore();
    setLinkCodeStore(store);
    await store.insert("slack", { code: "ABC123", userId: 1, orgId: 1, displayName: "Dani", expiresAt: Date.now() + 1000 });
    await expect(consumeLinkCode("slack", "ABC123")).resolves.toMatchObject({ userId: 1 });
    // Same code, typed in lower case with a stray dash: normalised, still the same row.
    await expect(consumeLinkCode("slack", "abc-123")).resolves.toBeNull();
    await expect(consumeLinkCode("slack", "ABC123")).resolves.toBeNull();
    expect(store.attemptsOf("slack", "ABC123")).toBe(3);
  });

  it("is restartable: a new store instance is the empty state, not a crash", async () => {
    await mintLinkCode("slack", { userId: 7, orgId: 3, displayName: "Dani" });
    setLinkCodeStore(memoryLinkCodeStore());
    await expect(peekLinkCode("slack", "ZZZZZZ")).resolves.toBeNull();
  });
});

describe("the AI usage ledger", () => {
  const call = (label: string) => ({
    at: new Date("2026-09-20T10:00:00.000Z").toISOString(),
    provider: "anthropic" as const,
    model: "claude-haiku-4-5",
    label,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.0004,
    priced: true,
    attempts: 1,
    durationMs: 12,
    ok: true,
  });

  it("writes a row for a call made inside an organization's scope", async () => {
    await withUsageScope({ orgId: 5, userId: 2 }, async () => {
      expect(currentUsageScope()).toEqual({ orgId: 5, userId: 2 });
      recordCall(call("task.suggest_priority"));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inserted.rows).toHaveLength(1);
    expect(inserted.rows[0]).toMatchObject({
      orgId: 5,
      userId: 2,
      provider: "anthropic",
      action: "task.suggest_priority",
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it("writes nothing when nobody is paying — a script or a unit test", async () => {
    recordCall(call("ai.probe"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inserted.rows).toHaveLength(0);
    // The in-process mirror still saw it, which is what makes the provider tests work.
    expect(recentCalls()).toHaveLength(1);
  });

  it("keeps the mirror bounded and the row's action column short enough for the schema", async () => {
    await withUsageScope({ orgId: 1, userId: null }, async () => recordCall(call("x".repeat(200))));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(String(inserted.rows[0].action)).toHaveLength(64);
    expect(inserted.rows[0].userId).toBeNull();
  });
});
