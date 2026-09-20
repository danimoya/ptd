/** The reported-versus-verified fold: coverage, deltas, and what counts as a discrepancy. */
import { describe, expect, it } from "vitest";
import { foldUsage, isDiscrepancy, narrate, TOLERANCE_PCT, TOLERANCE_TOKENS, type UsageEntryRow } from "../../server/usage/fold";

const range = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-30T23:59:59Z") };

let nextId = 1;
function row(over: Partial<UsageEntryRow> = {}): UsageEntryRow {
  return {
    entryId: nextId++,
    userId: 6,
    displayName: "Claude Code",
    agentLabel: "Claude Code",
    streamId: 1,
    streamName: "Security audit",
    taskId: 3,
    checkIn: new Date("2026-09-10T09:00:00Z"),
    tokensUsed: 100_000,
    apiCostUsd: 1,
    verifiedTokens: null,
    verifiedCostUsd: null,
    verifiedSource: null,
    verifiedAt: null,
    ...over,
  };
}

const attested = (over: Partial<UsageEntryRow> = {}) =>
  row({ verifiedTokens: 100_000, verifiedCostUsd: 1, verifiedSource: "claude_code_hook", verifiedAt: new Date(), ...over });

describe("foldUsage — coverage", () => {
  it("is zero with nothing attested and 100% when everything is", () => {
    expect(foldUsage([row(), row()], range).totals.coveragePct).toBe(0);
    expect(foldUsage([attested(), attested()], range).totals.coveragePct).toBe(100);
  });

  it("is the share of entries carrying evidence, to one decimal", () => {
    const summary = foldUsage([attested(), row(), row()], range);
    expect(summary.totals.entries).toBe(3);
    expect(summary.totals.verifiedEntries).toBe(1);
    expect(summary.totals.coveragePct).toBe(33.3);
  });

  it("counts a verified source even when its figures are zero", () => {
    const summary = foldUsage([attested({ verifiedTokens: 0, verifiedCostUsd: 0 })], range);
    expect(summary.totals.verifiedEntries).toBe(1);
    expect(summary.totals.coveragePct).toBe(100);
  });
});

describe("foldUsage — reported against verified", () => {
  it("keeps both numbers and reports the gap as verified − reported", () => {
    const summary = foldUsage([attested({ tokensUsed: 60_000, apiCostUsd: 0.6, verifiedTokens: 100_000, verifiedCostUsd: 1 })], range);
    expect(summary.totals.reported).toEqual({ tokens: 60_000, costUsd: 0.6 });
    expect(summary.totals.verified).toEqual({ tokens: 100_000, costUsd: 1 });
    expect(summary.totals.delta.tokens).toBe(40_000);
    expect(summary.totals.delta.costUsd).toBeCloseTo(0.4, 4);
  });

  it("does not let an unverified entry contribute to the delta, only to `unverified`", () => {
    const summary = foldUsage([row({ tokensUsed: 500_000, apiCostUsd: 5 }), attested({ tokensUsed: 100_000, verifiedTokens: 100_000 })], range);
    expect(summary.totals.delta.tokens).toBe(0);
    expect(summary.totals.unverified).toEqual({ tokens: 500_000, costUsd: 5 });
    expect(summary.totals.reported.tokens).toBe(600_000);
  });

  it("records which attester covered each entry", () => {
    const summary = foldUsage([attested(), attested({ verifiedSource: "ci" }), attested({ verifiedSource: "ci" })], range);
    expect(summary.totals.sources).toEqual({ claude_code_hook: 1, ci: 2 });
  });
});

describe("foldUsage — grouping", () => {
  it("splits by agent seat and by stream, and names an absent stream", () => {
    const summary = foldUsage(
      [
        attested({ userId: 6, agentLabel: "Claude Code", streamId: 1, streamName: "Security audit" }),
        attested({ userId: 5, agentLabel: "Orchestrator", streamId: null, streamName: null, verifiedCostUsd: 4 }),
      ],
      range,
    );
    expect(summary.byAgent.map((a) => a.name).sort()).toEqual(["Claude Code", "Orchestrator"]);
    expect(summary.byStream.find((s) => s.streamId === null)?.name).toBe("(no stream)");
    // Sorted by spend, so the expensive seat is first.
    expect(summary.byAgent[0].name).toBe("Orchestrator");
  });

  it("falls back to the user's display name when the ledger line carries no agent label", () => {
    const summary = foldUsage([attested({ agentLabel: null, displayName: "Nightly Bot" })], range);
    expect(summary.byAgent[0].name).toBe("Nightly Bot");
  });
});

describe("isDiscrepancy", () => {
  it("allows the larger of 5% or 1000 tokens", () => {
    expect(TOLERANCE_PCT).toBe(5);
    expect(TOLERANCE_TOKENS).toBe(1_000);
    expect(isDiscrepancy(100_000, 100_000)).toBe(false);
    expect(isDiscrepancy(99_000, 100_000)).toBe(false); // 1% — inside
    expect(isDiscrepancy(90_000, 100_000)).toBe(true); // 10% — outside
    // Small sessions get the flat allowance, so rounding noise is not an accusation.
    expect(isDiscrepancy(500, 1_400)).toBe(false);
    expect(isDiscrepancy(0, 1_400)).toBe(true);
  });
});

describe("foldUsage — discrepancies", () => {
  it("names an under-reported session and gives its direction and gap", () => {
    const summary = foldUsage([attested({ tokensUsed: 50_000, apiCostUsd: 0.5, verifiedTokens: 200_000, verifiedCostUsd: 2 })], range);
    expect(summary.discrepancies).toHaveLength(1);
    const d = summary.discrepancies[0];
    expect(d.direction).toBe("under_reported");
    expect(d.deltaTokens).toBe(150_000);
    expect(d.deltaPct).toBe(75);
    expect(d.deltaCostUsd).toBeCloseTo(1.5, 4);
    expect(summary.totals.discrepancies).toBe(1);
  });

  it("names an over-reported session too", () => {
    const summary = foldUsage([attested({ tokensUsed: 900_000, verifiedTokens: 100_000 })], range);
    expect(summary.discrepancies[0].direction).toBe("over_reported");
    expect(summary.discrepancies[0].deltaTokens).toBe(-800_000);
  });

  it("never flags an entry nobody attested — there is nothing to compare it with", () => {
    const summary = foldUsage([row({ tokensUsed: 0 }), row({ tokensUsed: 9_000_000 })], range);
    expect(summary.discrepancies).toHaveLength(0);
  });

  it("orders them by the size of the gap and caps the list", () => {
    const rows = [
      attested({ tokensUsed: 0, verifiedTokens: 10_000 }),
      attested({ tokensUsed: 0, verifiedTokens: 900_000 }),
      attested({ tokensUsed: 0, verifiedTokens: 50_000 }),
    ];
    const summary = foldUsage(rows, range);
    expect(summary.discrepancies.map((d) => d.verifiedTokens)).toEqual([900_000, 50_000, 10_000]);
    const many = foldUsage(Array.from({ length: 150 }, () => attested({ tokensUsed: 0, verifiedTokens: 80_000 })), range);
    expect(many.discrepancies).toHaveLength(100);
    expect(many.totals.discrepancies).toBe(150);
  });
});

describe("narrate", () => {
  it("says so plainly when nothing is verified", () => {
    const summary = foldUsage([row(), row()], range);
    expect(summary.narrative).toMatch(/0 of 2 agent sessions/);
    expect(summary.narrative).toMatch(/agents' own word/);
  });

  it("states the direction of the gap and the unverified remainder", () => {
    const summary = foldUsage([attested({ tokensUsed: 10_000, apiCostUsd: 0.1, verifiedTokens: 200_000, verifiedCostUsd: 2 }), row({ tokensUsed: 1_000, apiCostUsd: 3 })], range);
    expect(summary.narrative).toMatch(/is above what was reported by 190,000 tokens/);
    expect(summary.narrative).toMatch(/1 session is outside tolerance/);
    expect(summary.narrative).toMatch(/1 session remains? unverified, worth \$3\.00/);
  });

  it("has something honest to say about an empty window", () => {
    expect(narrate(foldUsage([], range).totals, 0)).toMatch(/No agent sessions in this window/);
  });
});
