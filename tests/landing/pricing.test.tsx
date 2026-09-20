import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const Pricing = (await import("../../client/src/features/landing/Pricing")).default;
const { PLANS, perMonthOnAnnual, planPrice } = await import("../../client/src/features/landing/Pricing");

/**
 * Two things have to hold here. The annual figure must be the owner's promise
 * — two months free, not "about 17% off" — and the third column must open the
 * form in place, because a pricing section that navigates away has lost the
 * reader it was about to convert.
 *
 * The turn is driven by timers, so these tests take the reduced-motion path:
 * it is the branch a real visitor on that setting gets, and it is the one that
 * proves the form arrives without an animation having to finish first.
 */

function reduceMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function renderPricing() {
  return render(
    <MemoryRouter>
      <Pricing />
    </MemoryRouter>
  );
}

beforeEach(() => reduceMotion(true));
afterEach(() => vi.unstubAllGlobals());

describe("the arithmetic", () => {
  const team = PLANS.find((p) => p.key === "team")!;
  const business = PLANS.find((p) => p.key === "business")!;

  it("gives two months free on the year", () => {
    expect(planPrice(team, "monthly")).toBe(15);
    expect(planPrice(team, "annual")).toBe(150);
    expect(planPrice(business, "monthly")).toBe(49);
    expect(planPrice(business, "annual")).toBe(490);
  });

  it("says what the year works out to per month", () => {
    expect(perMonthOnAnnual(team)).toBe(12.5);
    expect(perMonthOnAnnual(business)).toBe(40.83);
  });

  it("keeps Free free on both cycles", () => {
    const free = PLANS.find((p) => p.key === "free")!;
    expect(planPrice(free, "monthly")).toBe(0);
    expect(planPrice(free, "annual")).toBe(0);
  });
});

describe("the hosted switcher", () => {
  it("opens on Team, monthly, and says the price is flat", () => {
    renderPricing();
    expect(screen.getByTestId("hosted-price")).toHaveTextContent("$15");
    expect(screen.getByTestId("hosted-basis").textContent).toContain("flat, not per seat");
    expect(screen.getByTestId("hosted-basis").textContent).toContain("agent seats free");
  });

  it("shows the annual maths rather than a percentage", () => {
    renderPricing();
    fireEvent.click(screen.getByTestId("cycle-annual"));
    expect(screen.getByTestId("hosted-price")).toHaveTextContent("$150");
    expect(screen.getByTestId("hosted-basis").textContent).toContain("$12.50 a month, two months free");
  });

  it("moves to Business and carries the cycle with it", () => {
    renderPricing();
    fireEvent.click(screen.getByTestId("cycle-annual"));
    fireEvent.click(screen.getByTestId("plan-business"));
    expect(screen.getByTestId("hosted-price")).toHaveTextContent("$490");
    expect(screen.getByTestId("hosted-basis").textContent).toContain("$40.83 a month");
  });

  it("drops the per-seat line on Free, which has no seats to sell", () => {
    renderPricing();
    fireEvent.click(screen.getByTestId("plan-free"));
    expect(screen.getByTestId("hosted-price")).toHaveTextContent("$0");
    expect(screen.getByTestId("hosted-basis").textContent).toContain("3 seats, humans and agents");
  });
});

describe("the third column", () => {
  it("turns the section over into the form, in place", async () => {
    renderPricing();
    expect(screen.getByTestId("pricing-face")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open-contact"));

    await waitFor(() => expect(screen.getByTestId("contact-form")).toBeInTheDocument());
    expect(screen.queryByTestId("pricing-face")).toBeNull();
    expect(screen.getByTestId("pricing-stage")).toHaveAttribute("data-face", "contact");
  });

  it("turns back", async () => {
    renderPricing();
    fireEvent.click(screen.getByTestId("open-contact"));
    await waitFor(() => expect(screen.getByTestId("contact-form")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("back-to-pricing"));

    await waitFor(() => expect(screen.getByTestId("pricing-face")).toBeInTheDocument());
    expect(screen.getByTestId("pricing-stage")).toHaveAttribute("data-face", "pricing");
  });

  it("turns even when motion is allowed, once the timers have run", async () => {
    reduceMotion(false);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPricing();
      fireEvent.click(screen.getByTestId("open-contact"));
      await vi.advanceTimersByTimeAsync(600);
      await waitFor(() => expect(screen.getByTestId("contact-form")).toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the form", () => {
  async function openForm() {
    renderPricing();
    fireEvent.click(screen.getByTestId("open-contact"));
    await waitFor(() => expect(screen.getByTestId("contact-form")).toBeInTheDocument());
  }

  it("reports 'we could not send' with an address when the server says queued: false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, queued: false, contactEmail: "sales@ptd.example" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await openForm();

    fireEvent.change(screen.getByLabelText(/Your name/i), { target: { value: "Rina" } });
    fireEvent.change(screen.getByLabelText(/Work email/i), { target: { value: "rina@northwind.example" } });
    fireEvent.change(screen.getByLabelText(/What you would like to happen/i), {
      target: { value: "Forty people, nine agents, on-prem." },
    });
    fireEvent.click(screen.getByTestId("contact-submit"));

    await waitFor(() => expect(screen.getByTestId("contact-unsent")).toBeInTheDocument());
    expect(screen.getByTestId("contact-unsent").textContent).toContain("sales@ptd.example");
    expect(fetchMock).toHaveBeenCalledWith("/api/contact", expect.objectContaining({ method: "POST" }));
  });

  it("confirms when the letter is on its way", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, queued: true }) })
    );
    await openForm();

    fireEvent.change(screen.getByLabelText(/Your name/i), { target: { value: "Rina" } });
    fireEvent.change(screen.getByLabelText(/Work email/i), { target: { value: "rina@northwind.example" } });
    fireEvent.change(screen.getByLabelText(/What you would like to happen/i), { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("contact-submit"));

    await waitFor(() => expect(screen.getByTestId("contact-sent")).toBeInTheDocument());
    expect(screen.getByTestId("contact-sent").textContent).toContain("rina@northwind.example");
  });

  it("puts the server's field errors under the fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: "Validation failed",
          details: { fieldErrors: { email: ["That does not look like an email address"] } },
        }),
      })
    );
    await openForm();

    fireEvent.click(screen.getByTestId("contact-submit"));

    await waitFor(() => expect(screen.getByTestId("contact-error")).toBeInTheDocument());
    expect(screen.getByText("That does not look like an email address")).toBeInTheDocument();
  });

  it("carries a honeypot that is never shown to a reader", async () => {
    await openForm();
    const honeypot = screen.getByLabelText("Website") as HTMLInputElement;
    expect(honeypot).toHaveAttribute("tabindex", "-1");
    expect(honeypot.closest("[aria-hidden='true']")).not.toBeNull();
  });
});
