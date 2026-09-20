import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "crypto";
import {
  configuredProviders, isOidcProvider, providerConfig, redirectUri, OIDC_PROVIDERS,
} from "../../server/oidc/providers";
import {
  consumeFlow, decodeState, encodeState, mintHandoff, pkceChallenge, redeemHandoff, resetOidcStores, safeRedirect, startFlow, STATE_TTL_MS,
} from "../../server/oidc/state";
import { exchangeCode, fetchProfile, OidcError } from "../../server/oidc/profile";
import { nodeFetch, startStubIdp, type StubIdp } from "./oidc-stub";

// The suite mocks the global fetch, so every call here goes through nodeFetch.
const http = nodeFetch as unknown as (input: string, init?: RequestInit) => Promise<Response>;

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  OIDC_GOOGLE_CLIENT_ID: "google-id",
  OIDC_GOOGLE_CLIENT_SECRET: "google-secret",
  ...over,
});

describe("provider configuration", () => {
  it("knows its three providers and nothing else", () => {
    expect([...OIDC_PROVIDERS]).toEqual(["google", "github", "microsoft"]);
    expect(isOidcProvider("google")).toBe(true);
    expect(isOidcProvider("gitlab")).toBe(false);
    expect(isOidcProvider(undefined)).toBe(false);
  });

  it("treats a provider without both halves of its credential as absent", () => {
    expect(providerConfig("google", env())).not.toBeNull();
    expect(providerConfig("google", { OIDC_GOOGLE_CLIENT_ID: "only-id" })).toBeNull();
    expect(providerConfig("google", { OIDC_GOOGLE_CLIENT_SECRET: "only-secret" })).toBeNull();
    expect(providerConfig("github", env())).toBeNull();
    expect(configuredProviders(env()).map((p) => p.provider)).toEqual(["google"]);
    expect(configuredProviders({})).toEqual([]);
  });

  it("uses live endpoints, and the tenant Microsoft was given", () => {
    const google = providerConfig("google", env())!;
    expect(google.authorizeUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.userinfoUrl).toBe("https://openidconnect.googleapis.com/v1/userinfo");
    expect(google.pkce).toBe(true);

    const ms = providerConfig("microsoft", { OIDC_MICROSOFT_CLIENT_ID: "a", OIDC_MICROSOFT_CLIENT_SECRET: "b" })!;
    expect(ms.authorizeUrl).toContain("/common/oauth2/v2.0/authorize");
    const tenanted = providerConfig("microsoft", { OIDC_MICROSOFT_CLIENT_ID: "a", OIDC_MICROSOFT_CLIENT_SECRET: "b", OIDC_MICROSOFT_TENANT: "contoso.onmicrosoft.com" })!;
    expect(tenanted.authorizeUrl).toContain("/contoso.onmicrosoft.com/oauth2/v2.0/authorize");

    // GitHub's OAuth app endpoints ignore PKCE, so it is not claimed.
    const gh = providerConfig("github", { OIDC_GITHUB_CLIENT_ID: "a", OIDC_GITHUB_CLIENT_SECRET: "b" })!;
    expect(gh.pkce).toBe(false);
    expect(gh.emailsUrl).toBe("https://api.github.com/user/emails");
  });

  it("points every endpoint at one origin when a base URL override is set", () => {
    const cfg = providerConfig("github", { OIDC_GITHUB_CLIENT_ID: "a", OIDC_GITHUB_CLIENT_SECRET: "b", OIDC_GITHUB_BASE_URL: "http://127.0.0.1:9/" })!;
    expect(cfg.authorizeUrl).toBe("http://127.0.0.1:9/authorize");
    expect(cfg.tokenUrl).toBe("http://127.0.0.1:9/token");
    expect(cfg.userinfoUrl).toBe("http://127.0.0.1:9/userinfo");
    expect(cfg.emailsUrl).toBe("http://127.0.0.1:9/user/emails");
  });

  it("derives the redirect URI from the deployment's own base, unless told otherwise", () => {
    expect(redirectUri("google", "https://ptd.example.com/", env())).toBe("https://ptd.example.com/api/auth/oidc/google/callback");
    expect(redirectUri("google", "https://ptd.example.com", env({ OIDC_GOOGLE_REDIRECT_URI: "https://other/cb" }))).toBe("https://other/cb");
  });
});

describe("state", () => {
  it("round-trips its payload", () => {
    const state = encodeState({ nonce: "n1", provider: "google", redirectTo: "/plan", inviteToken: "abc", issuedAt: Date.now() });
    const back = decodeState(state);
    expect(back?.nonce).toBe("n1");
    expect(back?.redirectTo).toBe("/plan");
    expect(back?.inviteToken).toBe("abc");
  });

  it("refuses a tampered body, a tampered signature and a missing signature", () => {
    const state = encodeState({ nonce: "n1", provider: "google", redirectTo: "/plan", issuedAt: Date.now() });
    const [body, mac] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ nonce: "n1", provider: "google", redirectTo: "https://evil.example", issuedAt: Date.now() })).toString("base64url");
    expect(decodeState(`${forged}.${mac}`)).toBeNull();
    expect(decodeState(`${body}.${mac.slice(0, -2)}xx`)).toBeNull();
    expect(decodeState(body)).toBeNull();
    expect(decodeState("")).toBeNull();
  });

  it("expires", () => {
    const stale = encodeState({ nonce: "n1", provider: "google", redirectTo: "/", issuedAt: Date.now() - STATE_TTL_MS - 1000 });
    expect(decodeState(stale)).toBeNull();
  });
});

describe("PKCE and the nonce store", () => {
  beforeAll(() => resetOidcStores());

  it("mints a verifier and the S256 challenge of it, and only when the provider supports it", () => {
    const withPkce = startFlow("google", true);
    expect(withPkce.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(withPkce.challenge).toBe(createHash("sha256").update(withPkce.verifier!).digest("base64url"));
    expect(pkceChallenge("abc")).toBe(createHash("sha256").update("abc").digest("base64url"));

    const without = startFlow("github", false);
    expect(without.verifier).toBeNull();
    expect(without.challenge).toBeNull();
  });

  it("hands the verifier back exactly once, and only to the provider that asked", () => {
    const flow = startFlow("google", true);
    expect(consumeFlow(flow.nonce, "github")).toBeNull(); // wrong provider, and consumed
    const second = startFlow("google", true);
    expect(consumeFlow(second.nonce, "google")?.verifier).toBe(second.verifier);
    expect(consumeFlow(second.nonce, "google")).toBeNull();
    expect(consumeFlow("never-issued", "google")).toBeNull();
  });
});

describe("handoff codes", () => {
  it("carry a session exactly once", () => {
    const code = mintHandoff({ kind: "session", token: "jwt", userId: 1, email: "a@b.test", displayName: "A", orgId: 2, created: false, linked: false, provider: "google" });
    expect(code).not.toContain("jwt");
    const payload = redeemHandoff(code);
    expect(payload?.kind).toBe("session");
    expect(redeemHandoff(code)).toBeNull();
    expect(redeemHandoff("nonsense")).toBeNull();
  });
});

describe("safeRedirect", () => {
  it("keeps in-app paths and drops anything that could leave", () => {
    expect(safeRedirect("/plan")).toBe("/plan");
    expect(safeRedirect("/org/security?tab=x")).toBe("/org/security?tab=x");
    expect(safeRedirect("//evil.example/")).toBe("/");
    expect(safeRedirect("https://evil.example")).toBe("/");
    expect(safeRedirect("javascript:alert(1)")).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
    expect(safeRedirect(42)).toBe("/");
  });
});

/* ── Against a real (stub) provider ──────────────────────────────────── */

describe("code exchange and profile, over HTTP", () => {
  let google: StubIdp;
  let github: StubIdp;
  let microsoft: StubIdp;

  beforeAll(async () => {
    google = await startStubIdp({ flavour: "google", profile: { subject: "g-1", email: "Person@Example.Test", emailVerified: true, name: "Person One" } });
    github = await startStubIdp({ flavour: "github", profile: { subject: "4242", email: "dev@example.test", emailVerified: true, name: "octodev" } });
    microsoft = await startStubIdp({ flavour: "microsoft", profile: { subject: "m-1", email: "worker@contoso.test", name: "Work Er" } });
  });

  afterAll(async () => {
    await Promise.all([google.close(), github.close(), microsoft.close()]);
  });

  const cfgFor = (provider: "google" | "github" | "microsoft", idp: StubIdp) =>
    providerConfig(provider, {
      [`OIDC_${provider.toUpperCase()}_CLIENT_ID`]: "id",
      [`OIDC_${provider.toUpperCase()}_CLIENT_SECRET`]: "secret",
      [`OIDC_${provider.toUpperCase()}_BASE_URL`]: idp.url,
    })!;

  /** Walk /authorize the way a browser would, and return the code it handed back. */
  async function authorize(idp: StubIdp, challenge?: string): Promise<string> {
    const url = new URL(`${idp.url}/authorize`);
    url.searchParams.set("redirect_uri", "http://ptd.test/api/auth/oidc/x/callback");
    url.searchParams.set("state", "s");
    if (challenge) url.searchParams.set("code_challenge", challenge);
    const res = await http(url.toString());
    return new URL(res.headers.get("location")!).searchParams.get("code")!;
  }

  it("sends the PKCE verifier and reads a Google profile, lower-casing the address", async () => {
    const cfg = cfgFor("google", google);
    const flow = startFlow("google", true);
    const code = await authorize(google, flow.challenge!);
    const token = await exchangeCode(cfg, { code, redirectUri: "http://ptd.test/api/auth/oidc/x/callback", verifier: flow.verifier }, http);
    expect(google.lastTokenBody()?.code_verifier).toBe(flow.verifier);
    expect(google.lastTokenBody()?.grant_type).toBe("authorization_code");

    const profile = await fetchProfile(cfg, token, http);
    expect(profile).toEqual({ subject: "g-1", email: "person@example.test", emailVerified: true, displayName: "Person One" });
  });

  it("refuses a mismatched verifier", async () => {
    const cfg = cfgFor("google", google);
    const flow = startFlow("google", true);
    const code = await authorize(google, flow.challenge!);
    await expect(
      exchangeCode(cfg, { code, redirectUri: "http://ptd.test/api/auth/oidc/x/callback", verifier: "not-the-verifier" }, http),
    ).rejects.toThrow(/PKCE mismatch/);
  });

  it("refuses a reused authorization code", async () => {
    const cfg = cfgFor("google", google);
    const code = await authorize(google);
    await exchangeCode(cfg, { code, redirectUri: "http://ptd.test/cb" }, http);
    await expect(exchangeCode(cfg, { code, redirectUri: "http://ptd.test/cb" }, http)).rejects.toBeInstanceOf(OidcError);
  });

  it("reports a provider that will not exchange the code", async () => {
    const cfg = cfgFor("google", google);
    const code = await authorize(google);
    google.breakToken(true);
    try {
      await expect(exchangeCode(cfg, { code, redirectUri: "http://ptd.test/cb" }, http)).rejects.toThrow(/sulking|refused/i);
    } finally {
      google.breakToken(false);
    }
  });

  it("takes GitHub's address from /user/emails, since the profile hides it", async () => {
    const cfg = cfgFor("github", github);
    const code = await authorize(github);
    const token = await exchangeCode(cfg, { code, redirectUri: "http://ptd.test/cb" }, http);
    const profile = await fetchProfile(cfg, token, http);
    expect(profile).toEqual({ subject: "4242", email: "dev@example.test", emailVerified: true, displayName: "octodev" });
  });

  it("reports a GitHub address that the provider has not verified as unverified", async () => {
    const cfg = cfgFor("github", github);
    github.setProfile({ subject: "4242", email: "dev@example.test", emailVerified: false, name: "octodev" });
    const code = await authorize(github);
    const token = await exchangeCode(cfg, { code, redirectUri: "http://ptd.test/cb" }, http);
    const profile = await fetchProfile(cfg, token, http);
    expect(profile.emailVerified).toBe(false);
    github.setProfile({ subject: "4242", email: "dev@example.test", emailVerified: true, name: "octodev" });
  });

  it("reads Microsoft Graph, where an address the tenant owns counts as verified", async () => {
    const cfg = cfgFor("microsoft", microsoft);
    const flow = startFlow("microsoft", true);
    const code = await authorize(microsoft, flow.challenge!);
    const token = await exchangeCode(cfg, { code, redirectUri: "http://ptd.test/cb", verifier: flow.verifier }, http);
    const profile = await fetchProfile(cfg, token, http);
    expect(profile).toEqual({ subject: "m-1", email: "worker@contoso.test", emailVerified: true, displayName: "Work Er" });
  });

  it("refuses an access token the provider does not know", async () => {
    await expect(fetchProfile(cfgFor("google", google), "not-a-token", http)).rejects.toThrow(/HTTP 401/);
  });
});
