import { describe, expect, it } from "vitest";
import { agentMetricsFor, attributionFor } from "../../server/track/attribution";

describe("attributionFor", () => {
  it("stamps a human session with no agent label", () => {
    expect(attributionFor({ authType: "human", displayName: "Dana Boss" })).toEqual({ entrySource: "human", agentLabel: null });
  });

  it("stamps an agent session with the caller's display name", () => {
    expect(attributionFor({ authType: "agent", displayName: "Claude Worker" })).toEqual({ entrySource: "agent", agentLabel: "Claude Worker" });
  });

  it("truncates an over-long agent label to the column width", () => {
    const { agentLabel } = attributionFor({ authType: "agent", displayName: "x".repeat(200) });
    expect(agentLabel).toHaveLength(80);
  });
});

describe("agentMetricsFor", () => {
  it("stores tokens and cost for an agent entry", () => {
    const m = agentMetricsFor("agent", { tokensUsed: 1200, apiCostUsd: 0.04 });
    expect(m.values).toEqual({ tokensUsed: 1200, apiCostUsd: 0.04 });
    expect(m.ignored).toEqual([]);
  });

  it("drops them for a human entry and says which were dropped", () => {
    const m = agentMetricsFor("human", { tokensUsed: 1200, apiCostUsd: 0.04 });
    expect(m.values).toEqual({});
    expect(m.ignored).toEqual(["tokensUsed", "apiCostUsd"]);
    expect(m.reason).toMatch(/entry_source is 'agent'/);
  });

  it("reports only the fields that were actually supplied", () => {
    expect(agentMetricsFor("human", { tokensUsed: 5 }).ignored).toEqual(["tokensUsed"]);
    expect(agentMetricsFor("human", {}).ignored).toEqual([]);
    expect(agentMetricsFor("human", {}).reason).toBeUndefined();
  });

  it("writes nothing at all when an agent supplies nothing, so a stop cannot blank earlier numbers", () => {
    expect(agentMetricsFor("agent", {}).values).toEqual({});
  });

  it("rounds a fractional token count", () => {
    expect(agentMetricsFor("agent", { tokensUsed: 1200.7 }).values.tokensUsed).toBe(1201);
  });
});
