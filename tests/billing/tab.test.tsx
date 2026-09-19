import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Role } from "../../db/schema";

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

const FREE_STATUS = {
  hosted: true, plan: "free", priceUsd: 15, interval: "month",
  limits: { members: 3 }, usage: { members: 3, agents: 1, humans: 2 },
  subscription: null, portalAvailable: false, configured: true,
};

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

  it("shows the flat price, seat usage and the upgrade button for an owner on free", async () => {
    callAction.mockResolvedValue(FREE_STATUS);
    mount();

    expect(await screen.findByTestId("billing-tab")).toBeInTheDocument();
    // The owner-only controls appear once the org (and therefore the role) has loaded.
    expect(await screen.findByTestId("billing-upgrade")).toBeInTheDocument();
    expect(screen.getByTestId("billing-plan").textContent).toContain("$15");
    expect(screen.getByTestId("billing-plan").textContent).toContain("per organization, flat");
    expect(screen.getByTestId("billing-usage").textContent).toContain("3 / 3");
    expect(screen.getByTestId("billing-usage").textContent).toContain("free limit reached");
    expect(screen.queryByTestId("billing-portal")).toBeNull();
  });

  it("hides every control from an admin, who may look but not buy", async () => {
    callAction.mockResolvedValue(FREE_STATUS);
    mount("", "admin");
    await screen.findByTestId("billing-tab");
    expect(screen.queryByTestId("billing-upgrade")).toBeNull();
    expect(screen.getByText(/Only the owner can change the subscription/)).toBeInTheDocument();
  });

  it("shows the renewal date and the portal button once subscribed", async () => {
    callAction.mockResolvedValue({
      ...FREE_STATUS, plan: "hosted", limits: { members: null }, portalAvailable: true,
      subscription: { id: "sub_1", status: "active", currentPeriodEnd: "2026-10-19T12:00:00.000Z", cancelAtPeriodEnd: false, pastDue: false },
    });
    mount();

    expect(await screen.findByTestId("billing-subscription")).toBeInTheDocument();
    expect(await screen.findByTestId("billing-portal")).toBeInTheDocument();
    expect(screen.getByTestId("billing-sub-status").textContent).toBe("active");
    expect(screen.getByTestId("billing-subscription").textContent).toContain("19 Oct 2026");
    expect(screen.getByTestId("billing-usage").textContent).toContain("unlimited");
  });

  it("warns about a failed payment while keeping access", async () => {
    callAction.mockResolvedValue({
      ...FREE_STATUS, plan: "hosted", limits: { members: null }, portalAvailable: true,
      subscription: { status: "past_due", currentPeriodEnd: null, cancelAtPeriodEnd: false, pastDue: true },
    });
    mount();
    expect(await screen.findByTestId("billing-banner-past-due")).toBeInTheDocument();
  });

  it("syncs with Stripe on the success redirect and shows the banner", async () => {
    callAction.mockImplementation(async (name: string) => (name === "billing.sync" ? { hosted: true, synced: true, plan: "hosted" } : { ...FREE_STATUS, plan: "hosted", limits: { members: null } }));
    mount("?tab=billing&checkout=success&session_id=cs_test_1");

    expect(await screen.findByTestId("billing-banner-success")).toBeInTheDocument();
    await waitFor(() => expect(callAction).toHaveBeenCalledWith("billing.sync", { sessionId: "cs_test_1" }));
  });

  it("explains a cancelled checkout without charging anything", async () => {
    callAction.mockResolvedValue(FREE_STATUS);
    mount("?tab=billing&checkout=cancelled");
    expect(await screen.findByTestId("billing-banner-cancelled")).toBeInTheDocument();
    expect(callAction).not.toHaveBeenCalledWith("billing.sync", expect.anything());
  });
});
