import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * The route end of the adapter, exercised with simulated Slack requests: a real
 * Express app with the same global body parsers server/index.ts installs, real
 * signature verification, and the database layer stubbed.
 */

const stubs = vi.hoisted(() => {
  const row = {
    id: 1,
    orgId: 3,
    enabled: true,
    createdBy: 1,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    config: { teamId: "T1", teamName: "Acme", botUserId: "B1", botToken: "sealed", channelId: "C9", installedAt: "2026-09-01T00:00:00.000Z" },
  };
  return {
    row,
    getSlackForTeam: vi.fn(async (teamId: string) => (teamId === "T1" ? row : null)),
    saveSlackInstall: vi.fn(async () => row),
    resolveSlackCaller: vi.fn(async (orgId: number) => ({
      ok: true as const,
      userId: 7,
      ctx: { userId: 7, email: "dani@example.com", displayName: "Dani", orgId, role: "member" as const, authType: "human" as const, via: "slack" as const },
    })),
    linkSlackIdentity: vi.fn(async () => undefined),
    unlinkSlackIdentity: vi.fn(async () => 1),
    resolveTaskRef: vi.fn(async () => ({ id: 42, title: "Ship the Slack adapter", externalKey: "PTD-12" })),
    runAction: vi.fn(async () => ({ userId: 7, email: "dani@example.com", displayName: "Dani", role: "member", authType: "human", org: { id: 3, name: "Acme", slug: "acme" } })),
  };
});

vi.mock("../../db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ name: "Acme" }] }) }) }) },
}));

vi.mock("../../server/integrations/slack/store", () => ({
  SLACK_KIND: "slack",
  getSlackForTeam: stubs.getSlackForTeam,
  getSlackForOrg: vi.fn(async () => stubs.row),
  saveSlackInstall: stubs.saveSlackInstall,
  patchSlackConfig: vi.fn(async () => stubs.row),
  removeSlackForOrg: vi.fn(async () => 1),
  botTokenOf: () => "xoxb-test",
  isSlackConfig: () => true,
}));

vi.mock("../../server/integrations/slack/identity", () => ({
  SLACK_PROVIDER: "slack",
  externalIdFor: (teamId: string, userId: string) => `${teamId}:${userId}`,
  teamOf: (externalId: string) => externalId.split(":")[0],
  resolveSlackCaller: stubs.resolveSlackCaller,
  linkSlackIdentity: stubs.linkSlackIdentity,
  unlinkSlackIdentity: stubs.unlinkSlackIdentity,
  slackIdentitiesForUser: vi.fn(async () => []),
  removeSlackIdentitiesForUser: vi.fn(async () => 0),
  slackUserIdFor: vi.fn(async () => null),
  resolveTaskRef: stubs.resolveTaskRef,
}));

vi.mock("../../server/actions/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/actions/registry")>();
  return { ...actual, runAction: stubs.runAction };
});

const { registerSlackRoutes, respondWithin } = await import("../../server/integrations/slack/routes");
const { slackSignature } = await import("../../server/integrations/slack/verify");
const { mintLinkCode, resetLinkState } = await import("../../server/integrations/slack/linkCodes");
const { signState } = await import("../../server/integrations/slack/oauth");
const { ephemeral } = await import("../../server/integrations/slack/format");

const SECRET = "testsecret";
const COMMANDS = "/api/integrations/slack/commands";
const realFetch = globalThis.fetch;

/** Exactly what Slack posts: urlencoded, plus the two signature headers. */
function slashBody(text: string, overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    token: "legacy",
    team_id: "T1",
    team_domain: "acme",
    channel_id: "C9",
    channel_name: "general",
    user_id: "U1",
    user_name: "dani",
    command: "/ptd",
    text,
    response_url: "https://hooks.slack.com/commands/T1/1/abc",
    trigger_id: "trig",
    api_app_id: "A1",
    ...overrides,
  }).toString();
}

function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  // The same global parsers server/index.ts installs before any route exists.
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerSlackRoutes(app);
  return app;
}

let app: express.Express;

function post(body: string, opts: { ts?: string; sig?: string; secret?: string } = {}) {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const sig = opts.sig ?? slackSignature(opts.secret ?? SECRET, ts, body);
  return request(app)
    .post(COMMANDS)
    .set("Content-Type", "application/x-www-form-urlencoded")
    .set("X-Slack-Request-Timestamp", ts)
    .set("X-Slack-Signature", sig)
    .send(body);
}

const firstBlock = (body: { blocks?: { text?: { text?: string } }[] }) => body.blocks?.[0]?.text?.text ?? "";

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.SLACK_CLIENT_ID = "1234.5678";
  process.env.SLACK_CLIENT_SECRET = "shh";
  process.env.PTD_SECRET_KEY = "route-test-key";
  process.env.PTD_BASE_URL = "https://ptd.example.com";
  resetLinkState();
  vi.clearAllMocks();
  stubs.getSlackForTeam.mockImplementation(async (teamId: string) => (teamId === "T1" ? stubs.row : null));
  stubs.resolveSlackCaller.mockImplementation(async (orgId: number) => ({
    ok: true as const,
    userId: 7,
    ctx: { userId: 7, email: "dani@example.com", displayName: "Dani", orgId, role: "member" as const, authType: "human" as const, via: "slack" as const },
  }));
  stubs.runAction.mockImplementation(async () => ({ userId: 7, email: "dani@example.com", displayName: "Dani", role: "member", authType: "human", org: { id: 3, name: "Acme", slug: "acme" } }));
  app = buildApp();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("POST /commands — signature verification through the global parsers", () => {
  it("accepts a correctly signed slash command and runs the action as the linked user", async () => {
    const res = await post(slashBody("who"));
    expect(res.status).toBe(200);
    expect(res.body.response_type).toBe("ephemeral");
    expect(firstBlock(res.body)).toContain("Dani");
    expect(stubs.runAction).toHaveBeenCalledWith("whoami", {}, expect.objectContaining({ orgId: 3, role: "member", via: "slack", authType: "human" }));
  });

  it("verifies against the raw bytes: a body changed after signing is rejected", async () => {
    const body = slashBody("who");
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await request(app)
      .post(COMMANDS)
      .set("Content-Type", "application/x-www-form-urlencoded")
      .set("X-Slack-Request-Timestamp", ts)
      .set("X-Slack-Signature", slackSignature(SECRET, ts, body))
      .send(`${body}&text=stats`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("bad_signature");
    expect(stubs.runAction).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret, a stale timestamp and missing headers", async () => {
    expect((await post(slashBody("who"), { secret: "not-the-secret" })).body.error).toBe("bad_signature");

    const stale = String(Math.floor(Date.now() / 1000) - 600);
    expect((await post(slashBody("who"), { ts: stale })).body.error).toBe("stale_timestamp");

    const bare = await request(app).post(COMMANDS).set("Content-Type", "application/x-www-form-urlencoded").send(slashBody("who"));
    expect(bare.status).toBe(401);
    expect(bare.body.error).toBe("missing_headers");
  });

  it("answers 503 when the server has no signing secret", async () => {
    process.env.SLACK_SIGNING_SECRET = "";
    const res = await post(slashBody("who"));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no_secret");
  });

  it("is not a slash command without a team and user", async () => {
    const res = await post("text=who");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_a_slash_command");
  });
});

describe("POST /commands — workspace and identity", () => {
  it("tells an unconnected workspace what to do", async () => {
    const body = slashBody("who", { team_id: "T-OTHER" });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(firstBlock(res.body)).toContain("not connected to a PTD organization");
    expect(stubs.runAction).not.toHaveBeenCalled();
  });

  it("gives an unlinked Slack user the link instructions", async () => {
    stubs.resolveSlackCaller.mockResolvedValueOnce({ ok: false, reason: "not_linked" } as never);
    const res = await post(slashBody("today"));
    expect(res.status).toBe(200);
    expect(firstBlock(res.body)).toContain("not linked");
    expect(res.body.blocks[0].text.text).toContain("/ptd link <code>");
    expect(stubs.runAction).not.toHaveBeenCalled();
  });

  it("explains a linked account that is no longer a member", async () => {
    stubs.resolveSlackCaller.mockResolvedValueOnce({ ok: false, reason: "no_membership", userId: 7 } as never);
    const res = await post(slashBody("today"));
    expect(firstBlock(res.body)).toContain("not a member of Acme");
  });

  it("links an account with a minted code, without needing it to be linked first", async () => {
    const { code } = await mintLinkCode({ userId: 7, orgId: 3, displayName: "Dani" });
    const res = await post(slashBody(`link ${code}`));
    expect(res.status).toBe(200);
    expect(stubs.linkSlackIdentity).toHaveBeenCalledWith(7, "T1", "U1");
    expect(stubs.resolveSlackCaller).not.toHaveBeenCalled();
    expect(firstBlock(res.body)).toContain("Linked.");
  });

  it("unlinks without consulting the identity resolver", async () => {
    const res = await post(slashBody("unlink"));
    expect(stubs.unlinkSlackIdentity).toHaveBeenCalledWith("T1", "U1");
    expect(firstBlock(res.body)).toContain("Unlinked.");
  });

  it("resolves a task key before starting a timer", async () => {
    stubs.runAction.mockResolvedValueOnce({ entry: { taskTitle: "Ship the Slack adapter", checkIn: "2026-09-19T10:00:00.000Z" } } as never);
    const res = await post(slashBody("start PTD-12 fixing the parser"));
    expect(stubs.resolveTaskRef).toHaveBeenCalledWith(3, "PTD-12");
    expect(stubs.runAction).toHaveBeenCalledWith("time_entry.start", { taskId: 42, notes: "fixing the parser" }, expect.anything());
    expect(firstBlock(res.body)).toContain("Timer running");
  });
});

describe("install routes", () => {
  it("requires a PTD session for the install URL", async () => {
    expect((await request(app).post("/api/integrations/slack/install-url")).status).toBe(401);
    expect((await request(app).get("/api/integrations/slack/install")).status).toBe(401);
  });

  it("refuses a callback with a forged state and says why in the redirect", async () => {
    const res = await request(app).get("/api/integrations/slack/callback").query({ code: "c", state: "forged.mac" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/org/integrations?");
    expect(res.headers.location).toContain("slack=error");
    expect(res.headers.location).toContain("reason=state_bad_signature");
    expect(stubs.saveSlackInstall).not.toHaveBeenCalled();
  });

  it("passes a Slack-side denial through to the UI", async () => {
    const res = await request(app).get("/api/integrations/slack/callback").query({ error: "access_denied" });
    expect(res.headers.location).toContain("reason=access_denied");
  });

  it("stores the install when the state verifies and Slack returns a token", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: true, access_token: "xoxb-fresh", scope: "commands,chat:write", bot_user_id: "B1", app_id: "A1", team: { id: "T1", name: "Acme" }, authed_user: { id: "U1" } }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const state = signState({ orgId: 3, userId: 7 });
    const res = await request(app).get("/api/integrations/slack/callback").query({ code: "code-123", state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("slack=connected");
    expect(stubs.saveSlackInstall).toHaveBeenCalledWith(3, 7, expect.objectContaining({ teamId: "T1", botToken: "xoxb-fresh" }));
  });

  it("does not store anything when Slack rejects the code", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "invalid_code" }), { status: 200 })) as unknown as typeof fetch;
    const state = signState({ orgId: 3, userId: 7 });
    const res = await request(app).get("/api/integrations/slack/callback").query({ code: "bad", state });
    expect(res.headers.location).toContain("reason=invalid_code");
    expect(stubs.saveSlackInstall).not.toHaveBeenCalled();
  });
});

describe("respondWithin", () => {
  it("answers inline when the action is quick", async () => {
    const res = { json: vi.fn() };
    await respondWithin(res as never, "https://hooks.slack.com/x", Promise.resolve(ephemeral(["*done*"])), 50);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].blocks[0].text.text).toBe("*done*");
  });

  it("acknowledges immediately and delivers the late answer to response_url", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = { json: vi.fn() };
    const slow = new Promise<ReturnType<typeof ephemeral>>((resolve) => setTimeout(() => resolve(ephemeral(["*late*"])), 40));

    await respondWithin(res as never, "https://hooks.slack.com/late", slow, 5);
    expect(res.json.mock.calls[0][0].blocks[0].text.text).toContain("Working on it");

    await slow;
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://hooks.slack.com/late");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).blocks[0].text.text).toBe("*late*");
  });
});
