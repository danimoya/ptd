import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * The route end of the GitHub adapter, exercised with simulated deliveries: a real
 * Express app with the same global body parsers server/index.ts installs, real signature
 * verification over the raw bytes, and the database layer stubbed.
 *
 * The raw-body assertion is the point of this file. GitHub signs the exact bytes, and
 * `express.json()` is installed before any route exists, so without the shared raw-body
 * capture every delivery would fail to verify.
 */

const stubs = vi.hoisted(() => {
  const row = {
    id: 1,
    orgId: 3,
    enabled: true,
    createdBy: 7,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    config: { installationId: 555, account: { login: "danimoya", type: "User", id: 1 }, mappings: [], installedBy: 7 },
  };
  return {
    row,
    getGithubForInstallation: vi.fn(async () => row as typeof row | null),
    saveGithubInstall: vi.fn(async () => row),
    handleGithubDelivery: vi.fn(async () => ({ handled: true, orgId: 3, repo: "danimoya/ptd", taskId: 42 })),
    readInstallation: vi.fn(async () => ({
      ok: true as const,
      info: { installationId: 555, account: { login: "danimoya", type: "User", id: 1 }, repositorySelection: "all" },
    })),
  };
});

vi.mock("../../db", () => ({ db: {} }));

vi.mock("../../server/integrations/github/store", () => ({
  getGithubForInstallation: stubs.getGithubForInstallation,
  saveGithubInstall: stubs.saveGithubInstall,
  webhookSecretOf: () => undefined,
}));

vi.mock("../../server/integrations/github/inbound", () => ({ handleGithubDelivery: stubs.handleGithubDelivery }));

vi.mock("../../server/integrations/github/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/github/api")>();
  return { ...actual, readInstallation: stubs.readInstallation };
});

const { registerGithubRoutes, GITHUB_STATE_PURPOSE } = await import("../../server/integrations/github/routes");
const { githubSignature } = await import("../../server/integrations/github/verify");
const { signState } = await import("../../server/integrations/shared/state");

const SECRET = "whsec-test";
const WEBHOOK = "/api/integrations/github/webhook";

function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  // The same global parsers server/index.ts installs before any route exists.
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerGithubRoutes(app);
  return app;
}

let app: express.Express;

const delivery = (event: string, body: unknown, opts: { secret?: string; signature?: string } = {}) => {
  const raw = JSON.stringify(body);
  return request(app)
    .post(WEBHOOK)
    .set("Content-Type", "application/json")
    .set("X-GitHub-Event", event)
    .set("X-GitHub-Delivery", "d-1")
    .set("X-Hub-Signature-256", opts.signature ?? githubSignature(opts.secret ?? SECRET, raw))
    .send(raw);
};

const issueEvent = {
  action: "opened",
  issue: { number: 12, title: "Ship the GitHub adapter", state: "open", labels: [], user: { login: "danimoya" } },
  repository: { full_name: "danimoya/ptd" },
  installation: { id: 555 },
  sender: { login: "danimoya", type: "User" },
};

beforeEach(() => {
  process.env.GITHUB_APP_ID = "123456";
  process.env.GITHUB_APP_SLUG = "ptd-sync";
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.GITHUB_APP_PRIVATE_KEY = "";
  process.env.PTD_SECRET_KEY = "github-route-test-key";
  process.env.PTD_BASE_URL = "https://ptd.example.com";
  vi.clearAllMocks();
  stubs.getGithubForInstallation.mockResolvedValue(stubs.row);
  stubs.handleGithubDelivery.mockResolvedValue({ handled: true, orgId: 3, repo: "danimoya/ptd", taskId: 42 });
  app = buildApp();
});

describe("POST /webhook — signature verification through the global parsers", () => {
  it("accepts a correctly signed delivery and hands the parsed body on", async () => {
    const res = await delivery("issues", issueEvent);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ handled: true, taskId: 42 });
    expect(stubs.handleGithubDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ event: "issues", deliveryId: "d-1", body: expect.objectContaining({ action: "opened" }) }),
    );
  });

  it("verifies against the raw bytes: a body changed after signing is rejected", async () => {
    const raw = JSON.stringify(issueEvent);
    const res = await request(app)
      .post(WEBHOOK)
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "issues")
      .set("X-Hub-Signature-256", githubSignature(SECRET, raw))
      .send(JSON.stringify({ ...issueEvent, action: "closed" }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("bad_signature");
    expect(stubs.handleGithubDelivery).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret and a missing header", async () => {
    expect((await delivery("issues", issueEvent, { secret: "not-the-secret" })).body.error).toBe("bad_signature");

    const bare = await request(app).post(WEBHOOK).set("Content-Type", "application/json").set("X-GitHub-Event", "issues").send(issueEvent);
    expect(bare.status).toBe(401);
    expect(bare.body.error).toBe("missing_signature");
    expect(stubs.handleGithubDelivery).not.toHaveBeenCalled();
  });

  it("answers 503 when the server has no webhook secret", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "";
    const res = await delivery("issues", issueEvent);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no_secret");
  });

  it("refuses a body that is not JSON before it verifies anything", async () => {
    const res = await request(app)
      .post(WEBHOOK)
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "issues")
      .set("X-Hub-Signature-256", githubSignature(SECRET, "not json"))
      .send("not json");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_json");
  });

  it("answers 202 for a delivery it chose not to act on — GitHub only needs to know it arrived", async () => {
    stubs.handleGithubDelivery.mockResolvedValue({ handled: false, reason: "repo_not_mapped" } as never);
    const res = await delivery("issues", issueEvent);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ handled: false, reason: "repo_not_mapped" });
  });

  it("answers 202 even when the handler throws, so GitHub does not retry a broken card forever", async () => {
    stubs.handleGithubDelivery.mockRejectedValue(new Error("boom"));
    const res = await delivery("issues", issueEvent);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ handled: false, reason: "error" });
  });

  it("verifies an issue_comment the same way", async () => {
    const res = await delivery("issue_comment", { ...issueEvent, action: "created", comment: { body: "hi", user: { login: "priya" } } });
    expect(res.status).toBe(202);
    expect(stubs.handleGithubDelivery).toHaveBeenCalledWith(expect.objectContaining({ event: "issue_comment" }));
  });
});

describe("install routes", () => {
  it("requires a PTD session for the install URL", async () => {
    expect((await request(app).post("/api/integrations/github/install-url")).status).toBe(401);
    expect((await request(app).get("/api/integrations/github/install")).status).toBe(401);
  });

  it("refuses a setup callback with a forged state and says why in the redirect", async () => {
    const res = await request(app).get("/api/integrations/github/setup").query({ installation_id: "555", state: "forged.mac" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/org/integrations?");
    expect(res.headers.location).toContain("github=error");
    expect(res.headers.location).toContain("reason=state_bad_signature");
    expect(stubs.saveGithubInstall).not.toHaveBeenCalled();
  });

  it("refuses a setup callback with no installation id", async () => {
    const state = signState(GITHUB_STATE_PURPOSE, { orgId: 3, userId: 7 });
    const res = await request(app).get("/api/integrations/github/setup").query({ state });
    expect(res.headers.location).toContain("reason=missing_installation_id");
    expect(stubs.saveGithubInstall).not.toHaveBeenCalled();
  });

  it("will not accept a state signed for another flow", async () => {
    const slackState = signState("slack-oauth-state", { orgId: 3, userId: 7 });
    const res = await request(app).get("/api/integrations/github/setup").query({ installation_id: "555", state: slackState });
    expect(res.headers.location).toContain("reason=state_bad_signature");
  });

  it("stores the install when the state verifies", async () => {
    const state = signState(GITHUB_STATE_PURPOSE, { orgId: 3, userId: 7 });
    const res = await request(app).get("/api/integrations/github/setup").query({ installation_id: "555", state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("github=connected");
    expect(stubs.saveGithubInstall).toHaveBeenCalledWith(3, 7, {
      installationId: 555,
      account: { login: "danimoya", type: "User", id: 1 },
    });
  });

  it("still stores the install when GitHub will not describe it", async () => {
    stubs.readInstallation.mockResolvedValue({ ok: false, error: "404" } as never);
    const state = signState(GITHUB_STATE_PURPOSE, { orgId: 3, userId: 7 });
    const res = await request(app).get("/api/integrations/github/setup").query({ installation_id: "555", state });
    expect(res.headers.location).toContain("github=connected");
    expect(stubs.saveGithubInstall).toHaveBeenCalledWith(3, 7, { installationId: 555, account: null });
  });
});
