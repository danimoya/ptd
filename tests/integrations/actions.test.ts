import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "../../db/schema";
import type { ActionContext } from "../../server/actions/registry";

/**
 * The three adapters' control actions, driven through the real registry — so the role
 * gate being asserted here is the one every surface goes through, not a copy of it.
 */

const stubs = vi.hoisted(() => {
  const mapping = {
    streamId: 5,
    repo: "danimoya/ptd",
    direction: "both" as "both" | "in" | "out",
    mappedBy: 7,
    mappedAt: "2026-09-01T00:00:00.000Z",
    lastSyncAt: null,
    lastError: null,
    lastImported: null,
  };
  const githubRow = {
    id: 1,
    orgId: 3,
    enabled: true,
    createdBy: 7,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    config: {
      installationId: 555,
      account: { login: "danimoya", type: "User", id: 1 },
      mappings: [mapping],
      installedBy: 7,
      installedAt: "2026-09-01T00:00:00.000Z",
    },
  };
  const telegramRow = {
    id: 2,
    orgId: 3,
    enabled: true,
    createdBy: 7,
    createdAt: new Date(),
    config: { botUsername: "ptd_test_bot", botId: 42, webhookSetAt: "2026-09-01T00:00:00.000Z", registeredBy: 7, lastError: null },
  };
  const teamsRow = {
    id: 3,
    orgId: 3,
    enabled: true,
    createdBy: 7,
    createdAt: new Date(),
    config: { secret: "c2VjcmV0LWJ5dGVzLWhlcmU=", teamName: "Acme Engineering", connectedBy: 7, connectedAt: "2026-09-01T00:00:00.000Z" },
  };
  return {
    mapping,
    githubRow,
    telegramRow,
    teamsRow,
    getGithubForOrg: vi.fn(async () => githubRow as typeof githubRow | null),
    putMapping: vi.fn(async () => githubRow),
    removeMapping: vi.fn(async () => ({ row: githubRow, removed: 1 })),
    patchMapping: vi.fn(async () => githubRow),
    removeGithubForOrg: vi.fn(async () => 1),
    importOpenIssues: vi.fn(async () => ({ repo: "danimoya/ptd", streamId: 5, issues: 3, created: 2, updated: 1, errors: [] })),
    installationToken: vi.fn(async () => ({ ok: true as const, token: "ghs", expiresAt: Date.now() + 3_600_000 })),
    assertStream: vi.fn(async () => ({ id: 5, name: "Adapters" })),
    getTelegramForOrg: vi.fn(async () => stubsTelegramRow()),
    saveTelegramRegistration: vi.fn(async () => telegramRow),
    patchTelegramConfig: vi.fn(async () => telegramRow),
    removeTelegramForOrg: vi.fn(async () => 1),
    setWebhook: vi.fn(async () => ({ ok: true })),
    deleteWebhook: vi.fn(async () => ({ ok: true })),
    getMe: vi.fn(async () => ({ ok: true as const, bot: { id: 42, username: "ptd_test_bot", firstName: "PTD" } })),
    getWebhookInfo: vi.fn(async () => ({ ok: true as const, info: { url: "", pendingUpdateCount: 0, lastErrorMessage: null, lastErrorDate: null } })),
    getTeamsForOrg: vi.fn(async () => teamsRow as typeof teamsRow | null),
    saveTeamsConnection: vi.fn(async () => teamsRow),
    removeTeamsForOrg: vi.fn(async () => 1),
    allTeamsRows: vi.fn(async () => [teamsRow]),
    telegramIdentities: vi.fn(async () => ["55"]),
    teamsIdentities: vi.fn(async () => ["aad-obj-1"]),
  };

  function stubsTelegramRow() {
    return telegramRow as typeof telegramRow | null;
  }
});

// The only table these actions read directly is `streams`, for the mapping table's
// stream names; everything else goes through a mocked store.
vi.mock("../../db", () => {
  const rows = [{ id: 5, name: "Adapters" }];
  const query = () => Object.assign(Promise.resolve(rows), { limit: async () => rows, orderBy: () => query() });
  return { db: { select: () => ({ from: () => ({ where: () => query() }) }) } };
});

vi.mock("../../server/plan/taskOps", () => ({ assertStream: stubs.assertStream }));

vi.mock("../../server/integrations/github/store", () => ({
  getGithubForOrg: stubs.getGithubForOrg,
  putMapping: stubs.putMapping,
  removeMapping: stubs.removeMapping,
  patchMapping: stubs.patchMapping,
  removeGithubForOrg: stubs.removeGithubForOrg,
}));

vi.mock("../../server/integrations/github/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/github/sync")>();
  return { ...actual, importOpenIssues: stubs.importOpenIssues };
});

vi.mock("../../server/integrations/github/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/github/api")>();
  return { ...actual, installationToken: stubs.installationToken };
});

vi.mock("../../server/integrations/telegram/store", () => ({
  getTelegramForOrg: stubs.getTelegramForOrg,
  saveTelegramRegistration: stubs.saveTelegramRegistration,
  patchTelegramConfig: stubs.patchTelegramConfig,
  removeTelegramForOrg: stubs.removeTelegramForOrg,
}));

vi.mock("../../server/integrations/telegram/api", () => ({
  setWebhook: stubs.setWebhook,
  deleteWebhook: stubs.deleteWebhook,
  getMe: stubs.getMe,
  getWebhookInfo: stubs.getWebhookInfo,
}));

vi.mock("../../server/integrations/telegram/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/telegram/identity")>();
  return {
    ...actual,
    telegramIdentitiesForUser: stubs.telegramIdentities,
    removeTelegramIdentitiesForUser: vi.fn(async () => 1),
  };
});

vi.mock("../../server/integrations/teams/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/teams/store")>();
  return {
    ...actual,
    getTeamsForOrg: stubs.getTeamsForOrg,
    saveTeamsConnection: stubs.saveTeamsConnection,
    removeTeamsForOrg: stubs.removeTeamsForOrg,
    allTeamsRows: stubs.allTeamsRows,
    secretOf: (config: { secret: string }) => config.secret,
  };
});

vi.mock("../../server/integrations/teams/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/teams/identity")>();
  return { ...actual, teamsIdentitiesForUser: stubs.teamsIdentities, removeTeamsIdentitiesForUser: vi.fn(async () => 1) };
});

await import("../../server/actions/github");
await import("../../server/actions/telegram");
await import("../../server/actions/teams");
const { ActionError, getAction, runAction } = await import("../../server/actions/registry");
const { resetLinkState } = await import("../../server/integrations/shared/linkCodes");

const ctxFor = (role: Role = "admin"): ActionContext => ({
  userId: 7,
  email: "dani@example.com",
  displayName: "Dani",
  orgId: 3,
  role,
  authType: "human",
  via: "web",
});

const ROLES: Record<string, Role> = {
  "github.status": "member",
  "github.list_mappings": "member",
  "github.map_stream": "admin",
  "github.unmap_stream": "admin",
  "github.sync_now": "admin",
  "github.disconnect": "admin",
  "telegram.status": "member",
  "telegram.register_webhook": "admin",
  "telegram.webhook_info": "admin",
  "telegram.link_code": "member",
  "telegram.unlink": "member",
  "telegram.disconnect": "admin",
  "teams.status": "member",
  "teams.connect": "admin",
  "teams.link_code": "member",
  "teams.unlink": "member",
  "teams.disconnect": "admin",
};

beforeEach(() => {
  process.env.GITHUB_APP_ID = "123456";
  process.env.GITHUB_APP_SLUG = "ptd-sync";
  process.env.GITHUB_WEBHOOK_SECRET = "whsec";
  process.env.GITHUB_APP_PRIVATE_KEY = "";
  process.env.TELEGRAM_BOT_TOKEN = "123456:AAH-test";
  process.env.PTD_SECRET_KEY = "actions-test-key";
  process.env.PTD_BASE_URL = "https://ptd.example.com";
  vi.clearAllMocks();
  // Link codes are a table now; the in-memory store keeps this suite database-free.
  resetLinkState();
  stubs.mapping.direction = "both";
  stubs.getGithubForOrg.mockResolvedValue(stubs.githubRow);
  stubs.getTelegramForOrg.mockResolvedValue(stubs.telegramRow);
  stubs.getTeamsForOrg.mockResolvedValue(stubs.teamsRow);
  stubs.setWebhook.mockResolvedValue({ ok: true });
  stubs.allTeamsRows.mockResolvedValue([stubs.teamsRow]);
});

describe("the role gate", () => {
  it("declares the roles the report claims, and the registry enforces them", async () => {
    for (const [name, role] of Object.entries(ROLES)) {
      expect(getAction(name), name).toBeDefined();
      expect(getAction(name)!.requiredRole, name).toBe(role);
    }
  });

  it("refuses every admin action for a manager", async () => {
    for (const [name, role] of Object.entries(ROLES)) {
      if (role !== "admin") continue;
      await expect(runAction(name, {}, ctxFor("manager")), name).rejects.toBeInstanceOf(ActionError);
    }
  });

  it("lets a member read a status and mint their own link code", async () => {
    await expect(runAction("github.status", {}, ctxFor("member"))).resolves.toBeTruthy();
    await expect(runAction("telegram.link_code", {}, ctxFor("member"))).resolves.toBeTruthy();
    await expect(runAction("teams.link_code", {}, ctxFor("member"))).resolves.toBeTruthy();
  });
});

describe("github actions", () => {
  it("status never returns a credential", async () => {
    const status = (await runAction("github.status", {}, ctxFor("member"))) as Record<string, unknown>;
    expect(status).toMatchObject({ appConfigured: false, connected: true, installationId: 555, canManage: false });
    expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(status)).not.toContain("whsec");
    expect((status.mappings as unknown[])[0]).toMatchObject({ repo: "danimoya/ptd", streamName: "Adapters", direction: "both" });
  });

  it("maps a stream, normalising the repository and remembering who did it", async () => {
    const result = (await runAction("github.map_stream", { streamId: 5, repo: "https://github.com/DaniMoya/PTD" }, ctxFor())) as Record<string, unknown>;
    expect(result).toMatchObject({ mapped: true, repo: "danimoya/ptd", direction: "both" });
    expect(stubs.putMapping).toHaveBeenCalledWith(3, expect.objectContaining({ streamId: 5, repo: "danimoya/ptd", mappedBy: 7 }));
  });

  it("refuses a repository that is not one, and one already mapped elsewhere", async () => {
    await expect(runAction("github.map_stream", { streamId: 5, repo: "nonsense" }, ctxFor())).rejects.toThrow(/owner\/name/);
    await expect(runAction("github.map_stream", { streamId: 9, repo: "danimoya/ptd" }, ctxFor())).rejects.toThrow(/already mapped/);
  });

  it("refuses to map anything before the App is installed", async () => {
    stubs.getGithubForOrg.mockResolvedValue(null);
    await expect(runAction("github.map_stream", { streamId: 5, repo: "danimoya/ptd" }, ctxFor())).rejects.toThrow(/not connected/);
  });

  it("syncs a mapped stream and records the outcome", async () => {
    const summary = (await runAction("github.sync_now", { streamId: 5 }, ctxFor())) as Record<string, unknown>;
    expect(summary).toMatchObject({ issues: 3, created: 2 });
    expect(stubs.importOpenIssues).toHaveBeenCalledWith(
      expect.objectContaining({ via: "github", orgId: 3, userId: 7 }),
      stubs.githubRow,
      stubs.mapping,
      expect.anything(),
    );
    expect(stubs.patchMapping).toHaveBeenCalledWith(3, 5, expect.objectContaining({ lastImported: 3, lastError: null }));
  });

  it("will not import from a stream mapped as out-only, or one that is not mapped", async () => {
    stubs.mapping.direction = "out";
    await expect(runAction("github.sync_now", { streamId: 5 }, ctxFor())).rejects.toThrow(/does not import/);
    await expect(runAction("github.sync_now", { streamId: 99 }, ctxFor())).rejects.toThrow(/not mapped/);
    expect(stubs.importOpenIssues).not.toHaveBeenCalled();
  });

  it("unmaps and disconnects", async () => {
    await expect(runAction("github.unmap_stream", { streamId: 5 }, ctxFor())).resolves.toMatchObject({ unmapped: true });
    stubs.removeMapping.mockResolvedValue({ row: stubs.githubRow, removed: 0 });
    await expect(runAction("github.unmap_stream", { streamId: 5 }, ctxFor())).rejects.toThrow(/not mapped/);

    await expect(runAction("github.disconnect", {}, ctxFor())).resolves.toMatchObject({ disconnected: true, mappingsDropped: 1 });
    stubs.getGithubForOrg.mockResolvedValue(null);
    await expect(runAction("github.disconnect", {}, ctxFor())).rejects.toThrow(/was not connected/);
  });
});

describe("telegram actions", () => {
  it("registers the webhook against the derived URL and stores the bot's username", async () => {
    const result = (await runAction("telegram.register_webhook", {}, ctxFor())) as Record<string, unknown>;
    expect(result).toMatchObject({ registered: true, botUsername: "ptd_test_bot", warning: null });
    const call = stubs.setWebhook.mock.calls[0][0] as { url: string; secretToken: string };
    expect(call.url).toMatch(/^https:\/\/ptd\.example\.com\/api\/integrations\/telegram\/webhook\/[0-9a-f]{32}$/);
    expect(call.secretToken).toMatch(/^[0-9a-f]{32}$/);
    expect(call.url.endsWith(call.secretToken)).toBe(true);
  });

  it("refuses to register against a non-https base URL — Telegram would refuse it anyway", async () => {
    process.env.PTD_BASE_URL = "http://127.0.0.1:3053";
    await expect(runAction("telegram.register_webhook", {}, ctxFor())).rejects.toThrow(/https/);
    expect(stubs.setWebhook).not.toHaveBeenCalled();
  });

  it("reports what Telegram said when setWebhook fails, and records it", async () => {
    stubs.setWebhook.mockResolvedValue({ ok: false, error: "Failed to resolve host" });
    await expect(runAction("telegram.register_webhook", {}, ctxFor())).rejects.toThrow(/Failed to resolve host/);
    expect(stubs.patchTelegramConfig).toHaveBeenCalledWith(3, { lastError: "Failed to resolve host" });
  });

  it("status never returns the bot token or the webhook secret", async () => {
    const status = (await runAction("telegram.status", {}, ctxFor("member"))) as Record<string, unknown>;
    expect(status).toMatchObject({ appConfigured: true, connected: true, botUsername: "ptd_test_bot", linked: true });
    expect(status.webhookPath).toBe("/api/integrations/telegram/webhook/<secret>");
    const json = JSON.stringify(status);
    expect(json).not.toContain("123456:AAH-test");
    expect(json).not.toMatch(/[0-9a-f]{32}/);
  });

  it("mints a link code only once the bot is switched on for the organization", async () => {
    const code = (await runAction("telegram.link_code", {}, ctxFor("member"))) as Record<string, unknown>;
    expect(code.command).toMatch(/^\/link [A-Z0-9]{6}$/);
    stubs.getTelegramForOrg.mockResolvedValue(null);
    await expect(runAction("telegram.link_code", {}, ctxFor("member"))).rejects.toThrow(/not switched on/);
  });

  it("leaves the shared webhook registered on disconnect unless asked", async () => {
    await expect(runAction("telegram.disconnect", {}, ctxFor())).resolves.toMatchObject({ disconnected: true, webhookRemoved: false });
    expect(stubs.deleteWebhook).not.toHaveBeenCalled();
    await runAction("telegram.disconnect", { deleteWebhook: true }, ctxFor());
    expect(stubs.deleteWebhook).toHaveBeenCalled();
  });
});

describe("teams actions", () => {
  it("stores a plausible secret and hands back the callback URL", async () => {
    const secret = Buffer.from("a-teams-outgoing-webhook-secret").toString("base64");
    const result = (await runAction("teams.connect", { secret, teamName: "Acme Engineering" }, ctxFor())) as Record<string, unknown>;
    expect(result).toMatchObject({ connected: true, callbackUrl: "https://ptd.example.com/api/integrations/teams/webhook" });
    expect(stubs.saveTeamsConnection).toHaveBeenCalledWith(3, 7, { secret, teamName: "Acme Engineering" });
  });

  it("refuses something that cannot be a Teams secret", async () => {
    await expect(runAction("teams.connect", { secret: "not a secret at all!!" }, ctxFor())).rejects.toThrow(/does not look like/);
    expect(stubs.saveTeamsConnection).not.toHaveBeenCalled();
  });

  it("refuses a secret another organization already uses — a delivery must not be ambiguous", async () => {
    const secret = Buffer.from("shared-across-two-orgs-secret").toString("base64");
    stubs.allTeamsRows.mockResolvedValue([{ ...stubs.teamsRow, orgId: 8, config: { ...stubs.teamsRow.config, secret } }]);
    await expect(runAction("teams.connect", { secret }, ctxFor())).rejects.toThrow(/already connected to another organization/);
  });

  it("status never returns the secret", async () => {
    const status = (await runAction("teams.status", {}, ctxFor("member"))) as Record<string, unknown>;
    expect(status).toMatchObject({ connected: true, teamName: "Acme Engineering", linked: true });
    expect(JSON.stringify(status)).not.toContain(stubs.teamsRow.config.secret);
  });

  it("mints a link code only once a webhook is connected", async () => {
    const code = (await runAction("teams.link_code", {}, ctxFor("member"))) as Record<string, unknown>;
    expect(code.command).toMatch(/^@PTD link [A-Z0-9]{6}$/);
    stubs.getTeamsForOrg.mockResolvedValue(null);
    await expect(runAction("teams.link_code", {}, ctxFor("member"))).rejects.toThrow(/not connected/);
  });

  it("disconnects once", async () => {
    await expect(runAction("teams.disconnect", {}, ctxFor())).resolves.toMatchObject({ disconnected: true });
    stubs.removeTeamsForOrg.mockResolvedValue(0);
    await expect(runAction("teams.disconnect", {}, ctxFor())).rejects.toThrow(/was not connected/);
  });
});
