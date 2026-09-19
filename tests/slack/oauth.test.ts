import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SLACK_AUTHORIZE_URL,
  STATE_TTL_MS,
  exchangeCode,
  installUrl,
  signState,
  verifyState,
} from "../../server/integrations/slack/oauth";
import { SLACK_SCOPES } from "../../server/integrations/slack/config";

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.PTD_SECRET_KEY = "state-test-key";
  process.env.SLACK_CLIENT_ID = "1234.5678";
  process.env.SLACK_CLIENT_SECRET = "shh";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("state", () => {
  it("round-trips the org and user that started the install", () => {
    const state = signState({ orgId: 12, userId: 34 });
    const checked = verifyState(state);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.payload).toMatchObject({ orgId: 12, userId: 34 });
  });

  it("is unique per mint (nonce) and expires in ten minutes", () => {
    const now = 1_700_000_000_000;
    expect(signState({ orgId: 1, userId: 1 }, now)).not.toBe(signState({ orgId: 1, userId: 1 }, now));
    const state = signState({ orgId: 1, userId: 1 }, now);
    expect(verifyState(state, now + STATE_TTL_MS - 1).ok).toBe(true);
    expect(verifyState(state, now + STATE_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a tampered payload, a tampered mac and junk", () => {
    const state = signState({ orgId: 12, userId: 34 });
    const [body, mac] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ orgId: 999, userId: 1, nonce: "x", exp: Date.now() + 60_000 })).toString("base64url");
    expect(verifyState(`${forged}.${mac}`)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyState(`${body}.${"a".repeat(mac.length)}`)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyState("nonsense")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyState("")).toEqual({ ok: false, reason: "malformed" });
  });

  it("does not verify under a different PTD_SECRET_KEY", () => {
    const state = signState({ orgId: 12, userId: 34 });
    process.env.PTD_SECRET_KEY = "someone-elses-key";
    expect(verifyState(state)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("installUrl", () => {
  it("asks for exactly the four scopes the adapter needs", () => {
    const url = new URL(installUrl({ clientId: "1234.5678", redirectUri: "https://ptd.example.com/api/integrations/slack/callback", state: "st" }));
    expect(`${url.origin}${url.pathname}`).toBe(SLACK_AUTHORIZE_URL);
    expect(url.searchParams.get("scope")).toBe("commands,chat:write,users:read,users:read.email");
    expect(url.searchParams.get("scope")?.split(",")).toEqual([...SLACK_SCOPES]);
    expect(url.searchParams.get("client_id")).toBe("1234.5678");
    expect(url.searchParams.get("redirect_uri")).toBe("https://ptd.example.com/api/integrations/slack/callback");
    expect(url.searchParams.get("state")).toBe("st");
  });
});

describe("exchangeCode", () => {
  it("maps oauth.v2.access onto an install record", async () => {
    const body = {
      ok: true,
      access_token: "xoxb-real-token",
      scope: "commands,chat:write",
      bot_user_id: "B123",
      app_id: "A123",
      team: { id: "T999", name: "Acme" },
      authed_user: { id: "U1" },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await exchangeCode("code-123", "https://ptd.example.com/api/integrations/slack/callback");
    expect(result).toEqual({
      ok: true,
      install: { teamId: "T999", teamName: "Acme", botUserId: "B123", botToken: "xoxb-real-token", appId: "A123", scope: "commands,chat:write", authedUserId: "U1" },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get("code")).toBe("code-123");
    expect(sent.get("client_secret")).toBe("shh");
    expect(sent.get("redirect_uri")).toBe("https://ptd.example.com/api/integrations/slack/callback");
  });

  it("passes Slack's error through instead of throwing", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "invalid_code" }), { status: 200 })) as unknown as typeof fetch;
    expect(await exchangeCode("bad", "https://x/cb")).toEqual({ ok: false, error: "invalid_code" });
  });

  it("refuses a response with no token in it", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, team: { id: "T1" } }), { status: 200 })) as unknown as typeof fetch;
    expect(await exchangeCode("c", "https://x/cb")).toEqual({ ok: false, error: "incomplete_oauth_response" });
  });

  it("reports a network failure as an error, not an exception", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await exchangeCode("c", "https://x/cb")).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  it("will not exchange anything when the app is not configured", async () => {
    process.env.SLACK_CLIENT_ID = "";
    expect(await exchangeCode("c", "https://x/cb")).toEqual({ ok: false, error: "app_not_configured" });
  });
});
