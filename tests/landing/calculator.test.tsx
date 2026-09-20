import React from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { priorityScore } from "../../db/schema";

const PriorityCalculator = (await import("../../client/src/features/landing/PriorityCalculator")).default;
const { scoreOf, PRESETS } = await import("../../client/src/features/landing/PriorityCalculator");
const { bandFor } = await import("../../client/src/features/landing/chrome");

describe("priority score", () => {
  it("matches the brief's worked examples", () => {
    expect(scoreOf(10, 10, 1)).toBe(100);
    expect(scoreOf(8, 8, 2)).toBe(32);
    expect(scoreOf(5, 5, 5)).toBe(5);
  });

  it("agrees with the server's own formula", () => {
    for (let u = 0; u <= 10; u++) {
      for (let i = 0; i <= 10; i++) {
        for (let e = 0; e <= 10; e++) {
          expect(scoreOf(u, i, e)).toBe(priorityScore(u, i, e));
        }
      }
    }
  });

  it("clamps to 0–100 and survives an effort of zero", () => {
    expect(scoreOf(10, 10, 0)).toBe(100);
    expect(scoreOf(0, 10, 3)).toBe(0);
    expect(scoreOf(10, 10, 10)).toBe(10);
  });

  it("puts each score in the documented band", () => {
    expect(bandFor(0).label).toBe("low");
    expect(bandFor(24).label).toBe("low");
    expect(bandFor(25).label).toBe("normal");
    expect(bandFor(49).label).toBe("normal");
    expect(bandFor(50).label).toBe("high");
    expect(bandFor(74).label).toBe("high");
    expect(bandFor(75).label).toBe("critical");
    expect(bandFor(100).label).toBe("critical");
  });
});

describe("<PriorityCalculator />", () => {
  const score = () => screen.getByTestId("priority-score").textContent;

  it("renders the opening score and its formula", () => {
    render(<PriorityCalculator />);
    expect(score()).toBe("32");
    expect(screen.getByText("8 × 8 ÷ 2 = 32")).toBeInTheDocument();
  });

  it("recomputes when a slider moves", () => {
    render(<PriorityCalculator />);
    // Range inputs do not accept typing; fire the change the way the browser would.
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "4" } });
    expect(score()).toBe("16");
    expect(screen.getByText("8 × 8 ÷ 4 = 16")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Urgency"), { target: { value: "10" } });
    expect(score()).toBe("20");
  });

  it("loads a preset and shows its band", async () => {
    render(<PriorityCalculator />);
    await userEvent.click(screen.getByRole("button", { name: PRESETS[0].label }));
    expect(score()).toBe("100");
    expect(screen.getByText("critical")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: PRESETS[2].label }));
    expect(score()).toBe("5");
    expect(screen.getByText("low")).toBeInTheDocument();
  });
});
