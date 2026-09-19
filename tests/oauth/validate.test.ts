import { describe, expect, it } from "vitest";
import {
  checkResource, codeState, matchRedirectUri, normalizeAuthMethod, normalizeClientName, normalizeGrantTypes,
  normalizeResponseTypes, normalizeScope, normalizeState, redirectWith, sameResource, validateRedirectUri,
  validateRedirectUris,
} from "../../server/oauth/validate";

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

describe("redirect_uri registration", () => {
  it("accepts https and loopback http, refuses everything else", () => {
    expect(validateRedirectUri(CLAUDE).ok).toBe(true);
    expect(validateRedirectUri("http://localhost:6274/oauth/callback").ok).toBe(true);
    expect(validateRedirectUri("http://127.0.0.1:33418/callback").ok).toBe(true);
    expect(validateRedirectUri("http://example.com/cb").ok).toBe(false);
    expect(validateRedirectUri("javascript:alert(1)").ok).toBe(false);
    expect(validateRedirectUri("/relative").ok).toBe(false);
    expect(validateRedirectUri("").ok).toBe(false);
    expect(validateRedirectUri(42).ok).toBe(false);
  });

  it("refuses a fragment, which would swallow the code", () => {
    const bad = validateRedirectUri("https://app.example/cb#frag");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("invalid_redirect_uri");
  });

  it("de-duplicates the list and demands at least one entry", () => {
    const good = validateRedirectUris([CLAUDE, CLAUDE, "https://chatgpt.com/connector_platform_oauth_redirect"]);
    expect(good.ok && good.value).toEqual([CLAUDE, "https://chatgpt.com/connector_platform_oauth_redirect"]);
    expect(validateRedirectUris([]).ok).toBe(false);
    expect(validateRedirectUris("nope").ok).toBe(false);
    expect(validateRedirectUris(Array(11).fill(CLAUDE)).ok).toBe(false);
  });
});

describe("matchRedirectUri", () => {
  it("matches by exact string, never by prefix", () => {
    expect(matchRedirectUri([CLAUDE], CLAUDE).ok).toBe(true);
    expect(matchRedirectUri([CLAUDE], `${CLAUDE}/../evil`).ok).toBe(false);
    expect(matchRedirectUri([CLAUDE], "https://claude.ai/api/mcp/auth_callback?x=1").ok).toBe(false);
    expect(matchRedirectUri([CLAUDE], "https://evil.example/cb").ok).toBe(false);
  });

  it("falls back to the single registered URI, but not when several exist", () => {
    const one = matchRedirectUri([CLAUDE], undefined);
    expect(one.ok && one.value).toBe(CLAUDE);
    expect(matchRedirectUri([CLAUDE, "https://b.example/cb"], undefined).ok).toBe(false);
  });
});

describe("client metadata", () => {
  it("defaults grant types to both and demands authorization_code", () => {
    const def = normalizeGrantTypes(undefined);
    expect(def.ok && def.value).toEqual(["authorization_code", "refresh_token"]);
    expect(normalizeGrantTypes(["authorization_code"]).ok).toBe(true);
    expect(normalizeGrantTypes(["refresh_token"]).ok).toBe(false);
    expect(normalizeGrantTypes(["client_credentials"]).ok).toBe(false);
    expect(normalizeGrantTypes(["implicit"]).ok).toBe(false);
  });

  it("supports only the code response type", () => {
    expect(normalizeResponseTypes(undefined).ok).toBe(true);
    expect(normalizeResponseTypes(["code"]).ok).toBe(true);
    expect(normalizeResponseTypes(["token"]).ok).toBe(false);
  });

  it("defaults to a public client and rejects unknown auth methods", () => {
    const def = normalizeAuthMethod(undefined);
    expect(def.ok && def.value).toBe("none");
    expect(normalizeAuthMethod("client_secret_post").ok).toBe(true);
    expect(normalizeAuthMethod("client_secret_basic").ok).toBe(true);
    expect(normalizeAuthMethod("private_key_jwt").ok).toBe(false);
  });

  it("cleans the client name and keeps a usable default", () => {
    const named = normalizeClientName("  Claude\n(web)  ");
    expect(named.ok && named.value).toBe("Claude (web)");
    const fallback = normalizeClientName(undefined);
    expect(fallback.ok && fallback.value).toBe("MCP client");
    expect(normalizeClientName("   ").ok).toBe(false);
    const long = normalizeClientName("x".repeat(400));
    expect(long.ok && long.value.length).toBe(255);
  });
});

describe("scope", () => {
  it("defaults, de-duplicates, and refuses anything unknown", () => {
    const def = normalizeScope(undefined);
    expect(def.ok && def.value).toBe("ptd:member");
    const both = normalizeScope("ptd:member ptd:manager ptd:member");
    expect(both.ok && both.value).toBe("ptd:member ptd:manager");
    expect(normalizeScope("ptd:owner").ok).toBe(false);
    expect(normalizeScope("admin").ok).toBe(false);
  });
});

describe("resource (RFC 8707)", () => {
  it("treats a trailing slash and host case as the same audience", () => {
    expect(sameResource("https://ptd.danimoya.com/mcp", "https://ptd.danimoya.com/mcp")).toBe(true);
    expect(sameResource("https://ptd.danimoya.com/mcp/", "https://ptd.danimoya.com/mcp")).toBe(true);
    expect(sameResource("https://PTD.danimoya.com/mcp", "https://ptd.danimoya.com/mcp")).toBe(true);
    expect(sameResource("https://ptd.danimoya.com/api", "https://ptd.danimoya.com/mcp")).toBe(false);
    expect(sameResource("https://evil.example/mcp", "https://ptd.danimoya.com/mcp")).toBe(false);
  });

  it("is optional, but must name this MCP endpoint when present", () => {
    const absent = checkResource(undefined, "https://ptd.danimoya.com/mcp");
    expect(absent.ok && absent.value).toBeNull();
    expect(checkResource("https://ptd.danimoya.com/mcp", "https://ptd.danimoya.com/mcp").ok).toBe(true);
    const wrong = checkResource("https://elsewhere.example/mcp", "https://ptd.danimoya.com/mcp");
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toBe("invalid_target");
  });
});

describe("redirectWith", () => {
  it("adds parameters without losing the ones already on the URI", () => {
    expect(redirectWith("https://app.example/cb?keep=1", { code: "abc", state: "xyz" }))
      .toBe("https://app.example/cb?keep=1&code=abc&state=xyz");
  });

  it("skips empty values and encodes the rest", () => {
    expect(redirectWith("https://app.example/cb", { error: "access_denied", state: undefined }))
      .toBe("https://app.example/cb?error=access_denied");
    expect(redirectWith("https://app.example/cb", { state: "a b&c" })).toBe("https://app.example/cb?state=a+b%26c");
  });

  it("caps an absurd state so we cannot be made to build a huge URL", () => {
    expect(normalizeState("x".repeat(2000))!.length).toBe(512);
    expect(normalizeState("")).toBeUndefined();
    expect(normalizeState(7)).toBeUndefined();
  });
});

describe("codeState", () => {
  const now = new Date("2026-09-19T12:00:00Z");
  it("is valid before expiry, expired after, and used once redeemed", () => {
    expect(codeState({ expiresAt: new Date("2026-09-19T12:05:00Z"), usedAt: null }, now)).toBe("valid");
    expect(codeState({ expiresAt: new Date("2026-09-19T11:59:59Z"), usedAt: null }, now)).toBe("expired");
    expect(codeState({ expiresAt: new Date("2026-09-19T12:05:00Z"), usedAt: new Date() }, now)).toBe("used");
  });

  it("reads string timestamps the driver may hand back", () => {
    expect(codeState({ expiresAt: "2026-09-19T12:05:00Z", usedAt: null }, now)).toBe("valid");
  });
});
