import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Role } from "../../db/schema";
import { describeHostedPlans } from "../../server/billing/plans";

/* ─────────────────────────────────────────────────────────────────────────
 * Org → Billing, the hosted pricing surface.
 *
 * The fixtures are built from the server's own `describeHostedPlans()` rather
 * than a hand-typed copy of the price list, so a change to the plan model shows
 * up here as a failing expectation instead of a tab that quietly quotes last
 * quarter's prices.
 * ───────────────────────────────────────────────────────────────────────── */

const callAction = vi.fn();
const getMe = vi.fn();
const getCurrentOrg = vi.fn();

vi.mock("@/lib/api", () => ({
  callAction: (...args: unknown[]) => callAction(...args),
  getMe: () => getMe(),
  getCurrentOrg: () => getCurrentOrg(),
  api: vi.fn(),
}));

const BillingTab = (await import("../../client/src/features/org/BillingTab")).default;

const PLANS = describeHostedPlans().map((p) => ({ ...p, features: [...p.features] }));
const planOf = (name: "free" | "team" | "business") => PLANS.find((p) => p.plan === name)!;

function mount(search = "", role: Role = "owner") {
  getMe.mockResolvedValue({ user: { id: 1, email: "elena@atelier14.demo", displayName: "Elena", isAgent: false, createdAt: "" }, authType: "human", orgs: [] });
  getCurrentOrg.mockResolvedValue({ id: 4, name: "Atelier 14", slug: "atelier-14", plan: "free", role, createdAt: "" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/org/billing${search}`]}>
        <BillingTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A `billing.status` payload shaped exactly like the action's return value. */
function status(overrides: Record<string, unknown> = {}) {
  return {
    hosted: true,
    plan: "free",
    planLabel: "Free",
    interval: null,
    features: planOf("free").features,
    prices: { team: { month: 15, year: 150 }, business: { month: 49, year: 490 } },
    seatPrices: { month: 2, year: 20 },
    certInvoiceUsd: 1,
    aiMarkup: 1.2,
    priceUsd: 15,
    plans: PLANS,
    limits: { ...planOf("free").limits, members: 3 },
    usage: { humans: 2, agents: 1, total: 3, members: 3, seatOverage: 0, seatCostUsd: 0 },
    addons: { since: "2026-09-01T00:00:00.000Z", certifiedInvoices: 0, certifiedInvoicesUsd: 0, aiCents: 0, aiCostUsd: 0, aiCalls: 0 },
    subscription: null,
    portalAvailable: false,
    configured: true,
    memberCap: 100,
    foundingCode: null,
    ...overrides,
  };
}

const teamStatus = (overrides: Record<string, unknown> = {}) =>
  status({
    plan: "team",
    planLabel: "Team",
    interval: "month",
    features: planOf("team").features,
    limits: { ...planOf("team").limits, members: null },
    usage: { humans: 4, agents: 3, total: 7, members: 7, seatOverage: 0, seatCostUsd: 0 },
    portalAvailable: true,
    subscription: {
      id: "sub_1", status: "active", currentPeriodStart: "2026-09-01T00:00:00.000Z", currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      cancelAtPeriodEnd: false, pastDue: false, items: { base: "si_base", cert: "si_cert", ai: "si_ai" }, seatQuantity: 0,
    },
    ...overrides,
  });

const businessStatus = (overrides: Record<string, unknown> = {}) =>
  status({
    plan: "business",
    planLabel: "Business",
    interval: "month",
    features: planOf("business").features,
    limits: { ...planOf("business").limits, members: null },
    usage: { humans: 54, agents: 6, total: 60, members: 60, seatOverage: 4, seatCostUsd: 8 },
    portalAvailable: true,
    subscription: {
      id: "sub_2", status: "active", currentPeriodStart: "2026-09-01T00:00:00.000Z", currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      cancelAtPeriodEnd: false, pastDue: false, items: { base: "si_base", seat: "si_seat", cert: "si_cert", ai: "si_ai" }, seatQuantity: 4,
    },
    ...overrides,
  });

beforeEach(() => {
  callAction.mockReset();
  Object.defineProperty(window, "location", { value: { ...window.location, href: "http://localhost:3000/org/billing" }, writable: true });
});

afterEach(() => vi.clearAllMocks());

describe("BillingTab", () => {
  it("renders nothing on a self-hosted deployment", async () => {
    callAction.mockResolvedValue({ hosted: false });
    const { container } = mount();
    await waitFor(() => expect(callAction).toHaveBeenCalledWith("billing.status", {}));
    await waitFor(() => expect(container.querySelector('[data-testid="billing-tab"]')).toBeNull());
    expect(screen.queryByTestId("billing-upgrade")).toBeNull();
  });

  it("prints the three hosted plans, with the prices and seat allowances the server sent", async () => {
    callAction.mockResolvedValue(status());
    mount();
    await screen.findByTestId("billing-tab");

    const free = screen.getByTestId("billing-plan-free");
    const team = screen.getByTestId("billing-plan-team");
    const business = screen.getByTestId("billing-plan-business");

    expect(free.textContent).toContain("$0");
    expect(free.textContent).toContain("3 seats, humans and agents");
    expect(within(free).getByTestId("billing-current-free")).toBeInTheDocument();

    expect(team.textContent).toContain("$15");
    expect(team.textContent).toContain("/ org / month");
    expect(team.textContent).toContain("up to 10 human seats · agent seats free");
    expect(team.textContent).toContain("Certified invoices at $1 each");

    expect(business.textContent).toContain("$49");
    expect(business.textContent).toContain("50 human seats, then $2 each");
    expect(business.textContent).toContain("Everything in Team");
    expect(business.textContent).toContain("Certified invoices and verifiable links, included");
    expect(business.textContent).toContain("Hard cap 100 members");

    // Free's three seats are one ceiling for humans and agents, so one bar.
    expect(screen.getByTestId("billing-meter-members").textContent).toContain("3 / 3");
    expect(screen.queryByTestId("billing-meter-humans")).toBeNull();
    expect(screen.getByTestId("billing-usage").textContent).toContain("2 humans");
    expect(screen.getByTestId("billing-usage").textContent).toContain("1 agent");

    // The agent-seat promise and the self-hosting promise are both on the page.
    expect(screen.getByTestId("billing-plan").textContent).toContain("Agent seats are free — they pay their own API bill.");
    expect(screen.getByTestId("billing-selfhost-note").textContent).toContain("Self-hosting PTD stays free for ever");
  });

  it("buys the selected plan and period for an owner with no subscription", async () => {
    callAction.mockResolvedValue(status());
    mount();

    // Team is the default choice for an organization that has not bought yet.
    const upgrade = await screen.findByTestId("billing-upgrade");
    expect(upgrade.textContent).toContain("upgrade to Team — $15 a month");
    expect(screen.queryByTestId("billing-change-plan")).toBeNull();
    expect(screen.queryByTestId("billing-portal")).toBeNull();

    await userEvent.click(screen.getByTestId("billing-plan-business"));
    expect(screen.getByTestId("billing-upgrade").textContent).toContain("upgrade to Business — $49 a month");

    callAction.mockResolvedValue({ hosted: true, url: "https://checkout.stripe.test/c/pay/cs_1", sessionId: "cs_1", plan: "business", interval: "month" });
    await userEvent.click(screen.getByTestId("billing-upgrade"));
    await waitFor(() => expect(callAction).toHaveBeenCalledWith("billing.checkout", { plan: "business", interval: "month" }));
    await waitFor(() => expect(window.location.href).toBe("https://checkout.stripe.test/c/pay/cs_1"));
  });

  it("shows the annual price with the two-months-free arithmetic", async () => {
    callAction.mockResolvedValue(status());
    mount();
    await screen.findByTestId("billing-tab");

    await userEvent.click(screen.getByTestId("billing-interval-year"));

    const team = screen.getByTestId("billing-plan-team");
    expect(team.textContent).toContain("$150");
    expect(team.textContent).toContain("/ org / year");
    expect(team.textContent).toContain("$12.50 a month — two months free");

    const business = screen.getByTestId("billing-plan-business");
    expect(business.textContent).toContain("$490");
    expect(business.textContent).toContain("$40.83 a month — two months free");
    expect(business.textContent).toContain("50 human seats, then $20 each");

    expect(screen.getByTestId("billing-upgrade").textContent).toContain("upgrade to Team — $150 a year");
  });

  it("meters the human seats and the member cap separately on Team", async () => {
    callAction.mockResolvedValue(teamStatus());
    mount();
    await screen.findByTestId("billing-tab");

    expect(screen.getByTestId("billing-meter-humans").textContent).toContain("4 / 10");
    expect(screen.getByTestId("billing-meter-humans").textContent).toContain("6 human seats left");
    expect(screen.getByTestId("billing-meter-members").textContent).toContain("7 / 100");
    expect(screen.queryByTestId("billing-overage")).toBeNull();
    expect(screen.getByTestId("billing-subscription").textContent).toContain("Team, $15 a month");
    expect(screen.getByTestId("billing-sub-status").textContent).toBe("active");
    expect(screen.getByTestId("billing-subscription").textContent).toContain("1 Oct 2026");
  });

  it("bills the seats past Business's fifty and offers a plan change, not a checkout", async () => {
    callAction.mockResolvedValue(businessStatus());
    mount();
    await screen.findByTestId("billing-tab");

    expect(screen.getByTestId("billing-overage").textContent).toContain("4 human seats past the 50 included");
    expect(screen.getByTestId("billing-overage").textContent).toContain("× $2");
    expect(screen.getByTestId("billing-overage").textContent).toContain("$8.00");
    expect(screen.getByTestId("billing-overage").textContent).toContain("on top of the flat $49");
    expect(screen.getByTestId("billing-subscription").textContent).toContain("4 human seats past what the plan includes");

    // A subscription already exists, so the buy button is gone.
    expect(screen.queryByTestId("billing-upgrade")).toBeNull();
    const changeBtn = await screen.findByTestId("billing-change-plan");
    // Nothing to change until another plan or period is picked.
    expect(changeBtn).toBeDisabled();
    expect(screen.getByTestId("billing-change-idle").textContent).toContain("Already on Business, billed monthly");

    await userEvent.click(screen.getByTestId("billing-interval-year"));
    expect(screen.getByTestId("billing-change-plan")).not.toBeDisabled();
    expect(screen.getByTestId("billing-change-plan").textContent).toContain("change to Business — $490 a year");

    callAction.mockResolvedValue({ hosted: true, plan: "business", interval: "year", priceUsd: 490, seatQuantity: 4, subscription: { status: "active" } });
    await userEvent.click(screen.getByTestId("billing-change-plan"));
    await waitFor(() => expect(callAction).toHaveBeenCalledWith("billing.change_plan", { plan: "business", interval: "year" }));
    expect(callAction).not.toHaveBeenCalledWith("billing.checkout", expect.anything());
  });

  it("keeps the seats-in-use figures on what is billed today, whatever the switch above them says", async () => {
    callAction.mockResolvedValue(businessStatus());
    mount();
    await screen.findByTestId("billing-tab");

    // Looking at the yearly column does not change this month's invoice: the
    // overage stays 4 × $2 = $8.00 a month, not 4 × $20 a year.
    await userEvent.click(screen.getByTestId("billing-interval-year"));

    const overage = screen.getByTestId("billing-overage").textContent ?? "";
    expect(overage).toContain("× $2");
    expect(overage).toContain("$8.00");
    expect(overage).toContain("a month");
    expect(overage).not.toContain("$20");
    expect(overage).not.toContain("a year");
    // …while the cards themselves do price the year.
    expect(screen.getByTestId("billing-plan-business").textContent).toContain("then $20 each");
  });

  it("states the metered add-ons for the period, with the arithmetic", async () => {
    callAction.mockResolvedValue(
      teamStatus({ addons: { since: "2026-09-01T00:00:00.000Z", certifiedInvoices: 7, certifiedInvoicesUsd: 7, aiCents: 494, aiCostUsd: 4.116, aiCalls: 12 } }),
    );
    mount();
    await screen.findByTestId("billing-addons");

    expect(screen.getByTestId("billing-addons-since").textContent).toContain("1 Sep 2026");
    expect(screen.getByTestId("billing-addon-invoices").textContent).toContain("7 × $1");
    expect(screen.getByTestId("billing-addon-invoices").textContent).toContain("$7.00");
    expect(screen.getByTestId("billing-addon-ai").textContent).toContain("12 calls");
    expect(screen.getByTestId("billing-addon-ai").textContent).toContain("cost + 20%");
    expect(screen.getByTestId("billing-addon-ai").textContent).toContain("$4.94");
    expect(screen.getByTestId("billing-addons").textContent).toContain("with your own provider key nothing here is metered");
  });

  it("says certified invoices are included on Business and refused on Free", async () => {
    callAction.mockResolvedValue(
      businessStatus({ addons: { since: "2026-09-01T00:00:00.000Z", certifiedInvoices: 9, certifiedInvoicesUsd: 0, aiCents: 0, aiCostUsd: 0, aiCalls: 0 } }),
    );
    const view = mount();
    await screen.findByTestId("billing-addons");
    expect(screen.getByTestId("billing-addon-invoices").textContent).toContain("9 issued");
    expect(screen.getByTestId("billing-addon-invoices").textContent).toContain("included");
    expect(screen.getByTestId("billing-addon-invoices").textContent).not.toContain("$");
    view.unmount();

    callAction.mockResolvedValue(status());
    mount();
    await screen.findByTestId("billing-addons");
    expect(screen.getByTestId("billing-addon-invoices").textContent).toContain("Free cannot issue one");
    expect(screen.getByTestId("billing-plan-free").textContent).toContain("Certified invoices need Team");
  });

  it("offers the founding-member code only while the server sends one", async () => {
    callAction.mockResolvedValue(status({ foundingCode: "FOUNDING" }));
    const view = mount();
    const hint = await screen.findByTestId("billing-founding");
    expect(hint.textContent).toContain("40% off for the first 100 organizations");
    expect(hint.textContent).toContain("FOUNDING");
    view.unmount();

    callAction.mockResolvedValue(status());
    mount();
    await screen.findByTestId("billing-tab");
    expect(screen.queryByTestId("billing-founding")).toBeNull();
  });

  it("hides every control from an admin, who may look but not buy", async () => {
    callAction.mockResolvedValue(status());
    mount("", "admin");
    await screen.findByTestId("billing-tab");
    expect(screen.queryByTestId("billing-upgrade")).toBeNull();
    expect(screen.queryByTestId("billing-change-plan")).toBeNull();
    expect(screen.queryByTestId("billing-portal")).toBeNull();
    expect(screen.queryByTestId("billing-sync")).toBeNull();
    expect(screen.getByText(/Only the owner can change the subscription/)).toBeInTheDocument();
  });

  it("opens Stripe's portal once subscribed", async () => {
    callAction.mockResolvedValue(teamStatus());
    mount();
    const portal = await screen.findByTestId("billing-portal");
    callAction.mockResolvedValue({ hosted: true, url: "https://billing.stripe.test/p/session/live_1" });
    await userEvent.click(portal);
    await waitFor(() => expect(callAction).toHaveBeenCalledWith("billing.portal", {}));
    await waitFor(() => expect(window.location.href).toBe("https://billing.stripe.test/p/session/live_1"));
  });

  it("warns about a failed payment while keeping access", async () => {
    callAction.mockResolvedValue(teamStatus({ subscription: { id: "sub_1", status: "past_due", currentPeriodEnd: null, cancelAtPeriodEnd: false, pastDue: true } }));
    mount();
    expect(await screen.findByTestId("billing-banner-past-due")).toBeInTheDocument();
    expect(screen.getByTestId("billing-sub-status").textContent).toBe("payment overdue");
  });

  it("names the four plan prices when Stripe is not configured", async () => {
    callAction.mockResolvedValue(status({ configured: false }));
    mount();
    const banner = await screen.findByTestId("billing-banner-unconfigured");
    expect(banner.textContent).toContain("STRIPE_SECRET_KEY");
    expect(banner.textContent).toContain("STRIPE_PRICE_TEAM_MONTHLY");
    expect(banner.textContent).toContain("STRIPE_PRICE_TEAM_YEARLY");
    expect(banner.textContent).toContain("STRIPE_PRICE_BUSINESS_MONTHLY");
    expect(banner.textContent).toContain("STRIPE_PRICE_BUSINESS_YEARLY");
  });

  it("shows the stored state with a warning when Stripe cannot be read", async () => {
    callAction.mockResolvedValue(teamStatus({ warning: "connect ETIMEDOUT" }));
    mount();
    expect((await screen.findByTestId("billing-warning")).textContent).toContain("connect ETIMEDOUT");
    expect(screen.getByTestId("billing-plan")).toBeInTheDocument();
  });

  it("syncs with Stripe exactly once on the success redirect and drops the session id", async () => {
    callAction.mockImplementation(async (name: string) =>
      name === "billing.sync" ? { hosted: true, synced: true, plan: "team", interval: "month" } : teamStatus(),
    );
    mount("?tab=billing&checkout=success&plan=team&session_id=cs_test_1");

    expect(await screen.findByTestId("billing-banner-success")).toBeInTheDocument();
    await waitFor(() => expect(callAction).toHaveBeenCalledWith("billing.sync", { sessionId: "cs_test_1" }));
    await waitFor(() => expect(callAction.mock.calls.filter((c) => c[0] === "billing.sync")).toHaveLength(1));
  });

  it("explains a cancelled checkout without charging anything", async () => {
    callAction.mockResolvedValue(status());
    mount("?tab=billing&checkout=cancelled");
    expect(await screen.findByTestId("billing-banner-cancelled")).toBeInTheDocument();
    expect(callAction).not.toHaveBeenCalledWith("billing.sync", expect.anything());
  });

  it("acknowledges a return from the Stripe portal", async () => {
    callAction.mockResolvedValue(teamStatus());
    mount("?tab=billing&portal=return");
    expect(await screen.findByTestId("billing-banner-portal")).toBeInTheDocument();
  });

  it("reads the v1 `hosted` plan as Team", async () => {
    callAction.mockResolvedValue(teamStatus({ plan: "hosted", planLabel: "Team" }));
    mount();
    await screen.findByTestId("billing-tab");
    expect(screen.getByTestId("billing-current-team")).toBeInTheDocument();
  });
});
