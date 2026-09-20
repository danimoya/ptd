import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

/**
 * Every Org tab has to carry its explainer: a plain-language "Why this matters"
 * that a non-technical owner can read, and a "Technical details" section that
 * stays out of their way until they ask for it.
 *
 * The tabs are driven through one tiny fetch router rather than module mocks, so
 * these tests exercise the real query layer of every tab at once.
 */

const ORG = { id: 4, name: "Atelier 14", slug: "atelier-14", plan: "free", role: "owner", inviteCode: "atl-7f3c91", createdAt: "2026-01-01T00:00:00.000Z" };
const ME = { user: { id: 1, email: "elena@atelier14.demo", displayName: "Elena", isAgent: false, createdAt: "2026-01-01T00:00:00.000Z" }, authType: "human", orgs: [ORG] };

/** path (with the /api prefix) → body. Actions are keyed by their action name. */
const ROUTES: Record<string, unknown> = {
  "/api/auth/me": ME,
  "/api/orgs/current": ORG,
  "/api/orgs/current/members": [{ userId: 1, role: "owner", email: "elena@atelier14.demo", displayName: "Elena", isAgent: false, joinedAt: "2026-01-01T00:00:00.000Z" }],
  "/api/orgs/current/invite-code": { inviteCode: "atl-7f3c91" },
  "/api/tokens": [{ id: 9, name: "Local CLI", prefix: "a1b2c3d4", scopes: "full", createdAt: "2026-02-01T00:00:00.000Z", lastUsedAt: null, expiresAt: null, revokedAt: null }],
  "/api/actions": [{ name: "stats", title: "Organization statistics", description: "Counts for the whole ledger.", surface: "overview", requiredRole: "manager" }],
  "/api/import/sources": [{ source: "jira", kind: "task", label: "Jira", hint: "Issue key, Summary…", template: "/api/import/template/jira.csv" }],
  "/api/actions/webhook.list": [],
  "/api/actions/slack.status": { appConfigured: false, connected: false, canManage: true, scopes: [], teamId: null, teamName: null, botUserId: null, channelId: null, installedAt: null, installedBy: null, linked: false, slackUserId: null, linkedWorkspaces: [] },
  "/api/actions/import.history": { runs: [], taskEventsViaImport: 0, note: "No imports yet." },
  // Hosted pricing v2: three plans, per organization, with agent seats free.
  "/api/actions/billing.status": {
    hosted: true, plan: "free", planLabel: "Free", interval: null, priceUsd: 15,
    features: ["surfaces"],
    prices: { team: { month: 15, year: 150 }, business: { month: 49, year: 490 } },
    seatPrices: { month: 2, year: 20 }, certInvoiceUsd: 1, aiMarkup: 1.2,
    plans: [
      { plan: "free", label: "Free", prices: null, limits: { humanSeats: 3, totalMembers: 3, includedHumanSeats: 3, billableSeats: false }, features: ["surfaces"], seatPrices: null, certInvoiceUsd: null },
      { plan: "team", label: "Team", prices: { month: 15, year: 150 }, limits: { humanSeats: 10, totalMembers: 100, includedHumanSeats: 10, billableSeats: false }, features: ["surfaces", "integrations", "oauth_connectors", "webhooks", "importers", "certified_invoices", "ai"], seatPrices: null, certInvoiceUsd: 1 },
      { plan: "business", label: "Business", prices: { month: 49, year: 490 }, limits: { humanSeats: null, totalMembers: 100, includedHumanSeats: 50, billableSeats: true }, features: ["surfaces", "integrations", "oauth_connectors", "webhooks", "importers", "certified_invoices", "ai", "security_policy", "audit_export", "stripe_tax", "priority_support", "ai_priority"], seatPrices: { month: 2, year: 20 }, certInvoiceUsd: null },
    ],
    limits: { humanSeats: 3, totalMembers: 3, includedHumanSeats: 3, billableSeats: false, members: 3 },
    usage: { humans: 1, agents: 1, total: 2, members: 2, seatOverage: 0, seatCostUsd: 0 },
    addons: { since: "2026-09-01T00:00:00.000Z", certifiedInvoices: 0, certifiedInvoicesUsd: 0, aiCents: 0, aiCostUsd: 0, aiCalls: 0 },
    subscription: null, portalAvailable: false, configured: true, memberCap: 3, foundingCode: null,
  },
};

beforeEach(() => {
  (global.fetch as unknown as ReturnType<typeof vi.fn>) = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0];
    const body = ROUTES[path];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      statusText: body === undefined ? `no route for ${path}` : "OK",
      json: async () => body ?? { error: `no route for ${path}` },
    } as Response;
  });
});

afterEach(() => vi.clearAllMocks());

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/org"]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const TABS = [
  { label: "Members", id: "members", load: () => import("../../client/src/features/org/MembersTab"), why: /list of everyone who may open your ledger/i, technical: /memberships\.role/ },
  { label: "Agents", id: "agents", load: () => import("../../client/src/features/org/AgentsTab"), why: /An agent is a teammate, not a plug-in/i, technical: /api\/agent\/register/ },
  { label: "Tokens", id: "tokens", load: () => import("../../client/src/features/org/TokensTab"), why: /A token is a password for a program/i, technical: /salted scrypt/ },
  { label: "Integrations", id: "integrations", load: () => import("../../client/src/features/org/IntegrationsTab"), why: /tells the rest of your tools what just happened/i, technical: /X-PTD-Signature/ },
  { label: "API", id: "api", load: () => import("../../client/src/features/org/ApiTab"), why: /Everything PTD can do is one list/i, technical: /openapi\.json/ },
  { label: "Import", id: "import", load: () => import("../../client/src/features/org/ImportTab"), why: /start from an empty board/i, technical: /externalKey/ },
  { label: "Billing", id: "billing", load: () => import("../../client/src/features/org/BillingTab"), why: /agent seats are free/i, technical: /billing\.status/ },
] as const;

describe.each(TABS)("Org → $label explainer", ({ id, load, why, technical }) => {
  it("shows the plain-language why with the mechanics collapsed, and opens them on demand", async () => {
    const Tab = (await load()).default;
    mount(<Tab />);

    const block = await screen.findByTestId(`${id}-explainer`);
    expect(block.textContent).toMatch(/Why this matters/i);
    expect(screen.getByTestId(`${id}-explainer-why`).textContent).toMatch(why);

    // Collapsed: the mechanics are not in the tree at all until asked for.
    expect(screen.queryByTestId(`${id}-explainer-technical`)).toBeNull();

    await userEvent.click(screen.getByTestId(`${id}-explainer-toggle`));
    const details = await screen.findByTestId(`${id}-explainer-technical`);
    expect(details.textContent).toMatch(technical);
    expect(details.querySelectorAll("li").length).toBeGreaterThanOrEqual(3);
  });
});

describe("Hints on the controls", () => {
  it("explains the invite-code regenerate button on hover", async () => {
    const AgentsTab = (await import("../../client/src/features/org/AgentsTab")).default;
    mount(<AgentsTab />);

    const button = await screen.findByTestId("regenerate-invite-code");
    await userEvent.hover(button);
    await waitFor(() => expect(screen.getAllByText(/kills the old one on the spot/i).length).toBeGreaterThan(0));
  });

  it("gives the tokens tab a hint glyph on minting, and hides it behind an accessible name", async () => {
    const TokensTab = (await import("../../client/src/features/org/TokensTab")).default;
    mount(<TokensTab />);

    const glyphs = await screen.findAllByTestId("hint-glyph");
    expect(glyphs.length).toBeGreaterThan(0);
    expect(glyphs[0].getAttribute("aria-label")).toMatch(/shows the secret once/i);
  });
});
