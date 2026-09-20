import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

const LedgerGlimpse = (await import("../../client/src/features/landing/LedgerGlimpse")).default;
const { compact, clock, costFor, tokensFor, shortTokens, totalsFor } = await import(
  "../../client/src/features/landing/LedgerGlimpse"
);

describe("ledger arithmetic", () => {
  it("formats durations the way the day page does", () => {
    expect(compact(8)).toBe("8s");
    expect(compact(60)).toBe("1m");
    expect(compact(29 * 60)).toBe("29m");
    expect(compact(3840)).toBe("1h 04m");
  });

  it("formats wall-clock times", () => {
    expect(clock(9 * 60 + 12)).toBe("09:12");
    expect(clock(10 * 60 + 4)).toBe("10:04");
  });

  it("lands on the brief's figures after a full session", () => {
    const tokens = tokensFor(8);
    expect(tokens).toBe(15400);
    expect(shortTokens(tokens)).toBe("15.4k");
    expect(costFor(tokens)).toBe(0.21);
  });

  it("totals human and agent separately", () => {
    const totals = totalsFor([
      { id: "a", start: 0, seconds: 600, label: "x", source: "human" },
      { id: "b", start: 0, seconds: 300, label: "y", source: "agent", tokens: 1000, cost: 0.5 },
      { id: "c", start: 0, seconds: 120, label: "z", source: "agent", tokens: 500, cost: 0.25 },
    ]);
    expect(totals.humanSeconds).toBe(600);
    expect(totals.agentSeconds).toBe(420);
    expect(totals.tokens).toBe(1500);
    expect(totals.cost).toBe(0.75);
  });
});

describe("<LedgerGlimpse />", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const list = () => screen.getByRole("list");

  it("opens with the two seeded lines and their stamps", () => {
    render(<LedgerGlimpse />);
    expect(within(list()).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("human")).toBeInTheDocument();
    expect(screen.getByText(/^agent · 90\.2k tok · \$1\.21$/)).toBeInTheDocument();
  });

  it("runs a human session and lands it as a line stamped human", () => {
    render(<LedgerGlimpse />);
    act(() => void screen.getByRole("button", { name: /start as human/i }).click());
    expect(screen.getByRole("button", { name: /stop the session/i })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(8100));

    const rows = within(list()).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[2]).getByText("human")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /stop the session/i })).not.toBeInTheDocument();
  });

  it("stamps an agent line with its tokens and dollars and adds them to the totals", () => {
    render(<LedgerGlimpse />);
    act(() => void screen.getByRole("button", { name: /start as agent/i }).click());
    act(() => vi.advanceTimersByTime(8100));

    const rows = within(list()).getAllByRole("listitem");
    expect(within(rows[2]).getByText("agent · 15.4k tok · $0.21")).toBeInTheDocument();
    // 90.2k seeded + 15.4k from the session, $1.21 + $0.21.
    expect(screen.getByText("105.6k tok · $1.42")).toBeInTheDocument();
  });

  it("clears only the lines the visitor added", () => {
    render(<LedgerGlimpse />);
    act(() => void screen.getByRole("button", { name: /start as human/i }).click());
    act(() => vi.advanceTimersByTime(8100));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(3);

    act(() => void screen.getByRole("button", { name: /clear 1 line/i }).click());
    expect(within(list()).getAllByRole("listitem")).toHaveLength(2);
  });
});
