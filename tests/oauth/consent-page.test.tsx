import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import OAuthConsent from "../../client/src/pages/OAuthConsent";

// vitest.config.ts carries no react plugin, so page modules are transformed with
// the classic JSX runtime and reference a free `React`. The app itself builds
// through @vitejs/plugin-react (automatic runtime), where no import is needed —
// so the global is set here rather than adding an import to the page.
(globalThis as unknown as { React: typeof React }).React = React;

const CHALLENGE = "a".repeat(43);
const QUERY =
  `?response_type=code&client_id=ptdc_1&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}` +
  `&scope=ptd%3Amember&state=st8&code_challenge=${CHALLENGE}&code_challenge_method=S256`;

const CLIENT = {
  client_id: "ptdc_1",
  client_name: "Claude.ai",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  grant_types: ["authorization_code", "refresh_token"],
  token_endpoint_auth_method: "none",
  confidential: false,
  registered_at: "2026-09-19T00:00:00Z",
};
const ME = {
  user: { id: 1, email: "elena@atelier14.demo", displayName: "Elena" },
  orgs: [
    { orgId: 1, name: "Atelier 14", slug: "a14", plan: "free", role: "owner" },
    { orgId: 2, name: "Second House", slug: "sh", plan: "free", role: "member" },
  ],
};
const ACTIONS = [
  { name: "whoami", title: "Who am I", description: "", surface: "org", requiredRole: "member" },
  { name: "task.create", title: "Create task", description: "", surface: "plan", requiredRole: "manager" },
  { name: "time_entry.start", title: "Start timer", description: "", surface: "track", requiredRole: "member" },
];

/** A JWT-shaped token whose `exp` is a day out, so the page treats it as live. */
function liveJwt(): string {
  const payload = Buffer.from(JSON.stringify({ id: 1, exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
  return `header.${payload}.signature`;
}

const json = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) } as Response);

let posted: { url: string; body: any } | null = null;

function routeFetch(store: Record<string, string>) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/oauth/client-info")) return json(CLIENT);
    if (url === "/api/auth/me") return json(ME);
    if (url === "/api/actions") return json(ACTIONS);
    if (url === "/api/auth/login") {
      store.token = liveJwt();
      return json({ token: store.token, user: { email: "elena@atelier14.demo" } });
    }
    if (url === "/oauth/authorize/decision") {
      posted = { url, body: JSON.parse(String(init?.body)) };
      return json({ decision: "approve", redirect: "https://claude.ai/api/mcp/auth_callback?code=abc&state=st8" });
    }
    return json({ error: `unexpected ${url}` }, false);
  });
}

function mountWith(query = QUERY, token?: string) {
  const store: Record<string, string> = token ? { token } : {};
  vi.mocked(localStorage.getItem).mockImplementation((k: string) => store[k] ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
  vi.mocked(localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
  global.fetch = routeFetch(store) as unknown as typeof fetch;
  return render(
    <MemoryRouter initialEntries={[`/oauth/consent${query}`]}>
      <Routes>
        <Route path="/oauth/consent" element={<OAuthConsent />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  posted = null;
  Object.defineProperty(window, "location", { value: { ...window.location, assign: vi.fn() }, writable: true });
});
afterEach(() => vi.clearAllMocks());

describe("OAuthConsent", () => {
  it("names the client and asks an anonymous visitor to sign in first", async () => {
    mountWith();
    expect(await screen.findByText("Allow Claude.ai?")).toBeInTheDocument();
    expect(screen.getByTestId("consent-email")).toBeInTheDocument();
    expect(screen.getByText(/claude\.ai/)).toBeInTheDocument();
  });

  it("refuses a request with no PKCE challenge instead of offering to approve it", async () => {
    mountWith("?response_type=code&client_id=ptdc_1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb");
    expect(await screen.findByText("This request cannot be approved")).toBeInTheDocument();
    expect(screen.getByText(/code_challenge missing or unsupported/)).toBeInTheDocument();
    expect(screen.queryByTestId("consent-approve")).toBeNull();
  });

  it("shows the role held in the chosen org and the tools it grants", async () => {
    mountWith(QUERY, liveJwt());
    expect(await screen.findByTestId("consent-role")).toHaveTextContent("owner");
    expect(screen.getByTestId("consent-org")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("whoami")).toBeInTheDocument());
    expect(screen.getByText("task.create")).toBeInTheDocument();
    expect(screen.getByText(/3 tools/)).toBeInTheDocument();
  });

  it("posts the original authorize parameters and navigates where the server says", async () => {
    mountWith(QUERY, liveJwt());
    const approve = await screen.findByTestId("consent-approve");
    await userEvent.click(approve);
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.body).toMatchObject({
      decision: "approve",
      client_id: "ptdc_1",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "st8",
      orgId: 1,
    });
    expect(window.location.assign).toHaveBeenCalledWith("https://claude.ai/api/mcp/auth_callback?code=abc&state=st8");
  });

  it("sends a denial through the server too, never building a callback URL itself", async () => {
    mountWith(QUERY, liveJwt());
    await userEvent.click(await screen.findByTestId("consent-deny"));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.body.decision).toBe("deny");
  });
});
