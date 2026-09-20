import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const CascadeGlimpse = (await import("../../client/src/features/landing/CascadeGlimpse")).default;
const { TASKS, ROOT_ID, schedule, slipPreview, depthOf, orderTasks } = await import(
  "../../client/src/features/landing/CascadeGlimpse"
);

describe("cascade arithmetic", () => {
  it("leaves the baseline alone when nothing slips", () => {
    const placed = schedule(0);
    TASKS.forEach((t) => {
      expect(placed[t.id].start).toBe(t.base);
      expect(placed[t.id].delta).toBe(0);
    });
  });

  it("pushes the root and drags its dependants with it", () => {
    const placed = schedule(3);
    expect(placed["SEC-1"].start).toBe(3);
    expect(placed["SEC-2"].start).toBe(5); // waits on SEC-1 ending on day 5
    expect(placed["API-1"].start).toBe(8);
    expect(placed["API-2"].start).toBe(8);
    expect(placed["WEB-1"].start).toBe(10);
    expect(placed["REL-1"].start).toBe(12); // the later of API-2 and WEB-1
  });

  it("never starts a card before its dependencies end", () => {
    for (let slip = 0; slip <= 5; slip++) {
      const placed = schedule(slip);
      TASKS.forEach((t) => t.deps.forEach((d) => expect(placed[t.id].start).toBeGreaterThanOrEqual(placed[d].end)));
    }
  });

  it("previews how many cards move and how late the last one lands", () => {
    expect(slipPreview(0).moved).toBe(0);
    const preview = slipPreview(3);
    expect(preview.moved).toBe(TASKS.length);
    expect(preview.dependents).toBe(TASKS.length - 1);
    expect(preview.last.id).toBe("REL-1");
    expect(preview.lastDelta).toBe(2);
  });

  it("indents the tree by the longest path back to the root", () => {
    expect(depthOf(ROOT_ID)).toBe(0);
    expect(depthOf("SEC-2")).toBe(1);
    expect(depthOf("API-1")).toBe(2);
    expect(depthOf("WEB-1")).toBe(3);
    expect(depthOf("REL-1")).toBe(4);
  });

  it("orders siblings by the chosen key", () => {
    const placed = schedule(0);
    const byPriority = orderTasks(TASKS, placed, "priority", "duration").map((t) => t.id);
    // API-1 (28) outranks API-2 (24) at the same depth.
    expect(byPriority.indexOf("API-1")).toBeLessThan(byPriority.indexOf("API-2"));

    const byDuration = orderTasks(TASKS, placed, "start", "duration").map((t) => t.id);
    // Same start date, so the sub-order — duration — decides.
    expect(byDuration.indexOf("API-1")).toBeLessThan(byDuration.indexOf("API-2"));
  });
});

describe("<CascadeGlimpse />", () => {
  it("starts with nothing moved", () => {
    render(<CascadeGlimpse />);
    expect(screen.getByText(/Nothing has moved/)).toBeInTheDocument();
    expect(screen.getByTestId("bar-REL-1")).toHaveAttribute("data-start", "10");
  });

  it("slips the root and moves the dependants", async () => {
    render(<CascadeGlimpse />);
    const plus = screen.getByRole("button", { name: /one day more/i });
    await userEvent.click(plus);
    await userEvent.click(plus);
    await userEvent.click(plus);

    expect(screen.getByTestId("bar-SEC-1")).toHaveAttribute("data-start", "3");
    expect(screen.getByTestId("bar-REL-1")).toHaveAttribute("data-start", "12");
    expect(screen.getByText(/5 dependants move/)).toBeInTheDocument();
  });

  it("stops at the slip ceiling and walks back to zero", async () => {
    render(<CascadeGlimpse />);
    const plus = screen.getByRole("button", { name: /one day more/i });
    for (let i = 0; i < 8; i++) await userEvent.click(plus);
    expect(plus).toBeDisabled();
    expect(screen.getByText(/5 days/)).toBeInTheDocument();

    const minus = screen.getByRole("button", { name: /one day less/i });
    for (let i = 0; i < 5; i++) await userEvent.click(minus);
    expect(minus).toBeDisabled();
    expect(screen.getByText(/Nothing has moved/)).toBeInTheDocument();
  });

  it("swaps the timeline for the dependency tree", async () => {
    render(<CascadeGlimpse />);
    expect(screen.queryByLabelText("Order by")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Tree" }));
    expect(screen.getByLabelText("Order by")).toBeInTheDocument();
    expect(screen.getByLabelText("Then by")).toBeInTheDocument();
    expect(screen.getByTestId("tree-REL-1")).toBeInTheDocument();
    expect(screen.queryByTestId("bar-REL-1")).not.toBeInTheDocument();
  });
});
