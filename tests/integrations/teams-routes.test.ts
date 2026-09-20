import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * The route end of the Teams adapter.
 *
 * Two properties are specific to this surface and tested nowhere else: the HMAC is
 * computed over the raw bytes (so the shared raw-body capture has to be in front of
 * `express.json()`), and the secret that verifies a delivery is what names the
 * organization — there is nothing else in an Outgoing Webhook payload to trust.
 */

const stubs = vi.hoisted(() => {
  const rowFor = (orgId: number, secret: string, teamName: string) => ({
    id: orgId,
    orgId,
    enabled: true,
    createdBy: 7,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    config: { secret, teamName, connectedBy: 7 },
  });
  return {
    rowFor,
    rows: [] as ReturnType<typeof rowFor>[],
    allTeamsRows: vi.fn(),
    patchTeamsConfig: vi.fn(async () => null),
    orgNameOf: vi.fn(async (orgId: number) => (orgId === 3 ? "Acme" : "Beta Lab")),
    handleTeamsActivity: vi.fn(async (input: { orgId: number }) => ({
      command: "next",
      orgId: input.orgId,
      reply: {
        response_type: "ephemeral" as const,
        text: "Next up",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `*Next up* — \`PTD-12\` for org ${input.orgId}` } }],
      },
    })),
  };
});

vi.mock("../../db", () => ({ db: {} }));

vi.mock("../../server/integrations/teams/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/teams/store")>();
  return {
    ...actual,
    allTeamsRows: stubs.allTeamsRows,
    patchTeamsConfig: stubs.patchTeamsConfig,
    // The stored secrets in this test are plaintext, which `secretOf` tolerates.
    secretOf: (config: { secret: string }) => config.secret,
  };
});

// Only orgNameOf is stubbed; the verb table still imports resolveTaskRef from here.
vi.mock("../../server/integrations/shared/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/shared/identity")>();
  return { ...actual, orgNameOf: stubs.orgNameOf };
});

vi.mock("../../server/integrations/teams/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/teams/commands")>();
  return { ...actual, handleTeamsActivity: stubs.handleTeamsActivity };
});

const { registerTeamsRoutes } = await import("../../server/integrations/teams/routes");
const { teamsSignature } = await import("../../server/integrations/teams/verify");

const ACME_SECRET = Buffer.from("acme-outgoing-webhook-secret").toString("base64");
const BETA_SECRET = Buffer.from("beta-outgoing-webhook-secret").toString("base64");
const WEBHOOK = "/api/integrations/teams/webhook";

function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerTeamsRoutes(app);
  return app;
}

let app: express.Express;

const activity = (text: string) => ({
  type: "message",
  text,
  from: { id: "29:abc", name: "Dani Moya", aadObjectId: "AAD-OBJ-1" },
  conversation: { id: "19:channel@thread.tacv2" },
  channelData: { team: { name: "Acme Engineering" } },
});

const post = (secret: string | null, body: unknown, header?: string) => {
  const raw = JSON.stringify(body);
  const req = request(app).post(WEBHOOK).set("Content-Type", "application/json");
  if (header !== undefined) req.set("Authorization", header);
  else if (secret) req.set("Authorization", teamsSignature(secret, raw));
  return req.send(raw);
};

beforeEach(() => {
  process.env.PTD_SECRET_KEY = "teams-route-test-key";
  vi.clearAllMocks();
  stubs.rows = [stubs.rowFor(3, ACME_SECRET, "Acme Engineering"), stubs.rowFor(8, BETA_SECRET, "Beta Lab")];
  stubs.allTeamsRows.mockImplementation(async () => stubs.rows);
  stubs.handleTeamsActivity.mockImplementation(async (input: { orgId: number }) => ({
    command: "next",
    orgId: input.orgId,
    reply: {
      response_type: "ephemeral",
      text: "Next up",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `*Next up* — \`PTD-12\` for org ${input.orgId}` } }],
    },
  }));
  app = buildApp();
});

describe("POST /webhook", () => {
  it("verifies the raw bytes through the global parsers and answers a Teams message", async () => {
    const res = await post(ACME_SECRET, activity("<at>PTD</at> next"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: "message", text: "Next up — PTD-12 for org 3" });
    expect(stubs.handleTeamsActivity).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 3, orgName: "Acme", teamName: "Acme Engineering", activity: expect.objectContaining({ text: "next" }) }),
    );
  });

  it("resolves the organization from WHICH secret verified the body", async () => {
    const res = await post(BETA_SECRET, activity("<at>PTD</at> next"));
    expect(res.status).toBe(200);
    expect(res.body.text).toContain("for org 8");
    expect(stubs.handleTeamsActivity).toHaveBeenCalledWith(expect.objectContaining({ orgId: 8, orgName: "Beta Lab" }));
  });

  it("rejects a body changed after signing", async () => {
    const raw = JSON.stringify(activity("<at>PTD</at> next"));
    const res = await request(app)
      .post(WEBHOOK)
      .set("Content-Type", "application/json")
      .set("Authorization", teamsSignature(ACME_SECRET, raw))
      .send(JSON.stringify(activity("<at>PTD</at> stats")));
    expect(res.status).toBe(401);
    expect(res.body.text).toContain("did not verify");
    expect(stubs.handleTeamsActivity).not.toHaveBeenCalled();
  });

  it("rejects an unknown secret, a missing header and a non-HMAC scheme", async () => {
    const stranger = Buffer.from("a-secret-nobody-connected").toString("base64");
    expect((await post(stranger, activity("<at>PTD</at> next"))).status).toBe(401);
    expect((await post(null, activity("<at>PTD</at> next"), undefined)).status).toBe(400);
    expect((await post(null, activity("<at>PTD</at> next"), "Bearer token")).status).toBe(400);
    expect(stubs.handleTeamsActivity).not.toHaveBeenCalled();
  });

  it("answers 503 when no organization has connected a webhook at all", async () => {
    stubs.rows = [];
    const res = await post(ACME_SECRET, activity("<at>PTD</at> next"));
    expect(res.status).toBe(503);
    expect(res.body.text).toContain("No Teams outgoing webhook");
  });

  it("asks for a command when the mention carried no text", async () => {
    const res = await post(ACME_SECRET, activity("<at>PTD</at>"));
    expect(res.status).toBe(200);
    expect(res.body.text).toContain("@PTD help");
    expect(stubs.handleTeamsActivity).not.toHaveBeenCalled();
  });

  it("answers an apology rather than a 500 when the handler throws", async () => {
    stubs.handleTeamsActivity.mockRejectedValue(new Error("boom"));
    const res = await post(ACME_SECRET, activity("<at>PTD</at> next"));
    expect(res.status).toBe(200);
    expect(res.body.text).toContain("Something went wrong");
  });

  it("stamps the last event on the organization that was resolved", async () => {
    await post(BETA_SECRET, activity("<at>PTD</at> next"));
    expect(stubs.patchTeamsConfig).toHaveBeenCalledWith(8, expect.objectContaining({ lastError: null }));
  });
});
