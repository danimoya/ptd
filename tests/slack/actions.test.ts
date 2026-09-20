import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "../../db/schema";
import type { ActionContext } from "../../server/actions/registry";

/**
 * The Slack control actions, driven through the real registry — so the role gate
 * being asserted here is the one every adapter goes through.
 */

const stubs = vi.hoisted(() => ({
  row: {
    id: 1,
    orgId: 3,
    enabled: true,
    createdBy: 1,
    createdAt: new Date(),
    config: { teamId: "T1", teamName: "Acme", botUserId: "B1", botToken: "sealed", channelId: "C9", installedAt: "2026-09-01T00:00:00.000Z", installedBy: 7 },
  },
  getSlackForOrg: vi.fn(),
  patchSlackConfig: vi.fn(),
  removeSlackForOrg: vi.fn(async () => 1),
  testSlackConnection: vi.fn(async () => ({ posted: true, channel: "C9", error: null })),
  checkStreamBudgets: vi.fn(async () => ({ checked: 2, overBudget: 1, posted: 1, skipped: [] })),
  slackIdentitiesForUser: vi.fn(async () => ["T1:U1"]),
  removeSlackIdentitiesForUser: vi.fn(async () => 1),
}));

vi.mock("../../db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ name: "Acme" }] }) }) }) },
}));

vi.mock("../../server/integrations/slack/store", () => ({
  getSlackForOrg: stubs.getSlackForOrg,
  patchSlackConfig: stubs.patchSlackConfig,
  removeSlackForOrg: stubs.removeSlackForOrg,
}));

vi.mock("../../server/integrations/slack/notify", () => ({
  testSlackConnection: stubs.testSlackConnection,
  checkStreamBudgets: stubs.checkStreamBudgets,
}));

vi.mock("../../server/integrations/slack/identity", () => ({
  slackIdentitiesForUser: stubs.slackIdentitiesForUser,
  removeSlackIdentitiesForUser: stubs.removeSlackIdentitiesForUser,
  teamOf: (externalId: string) => externalId.split(":")[0],
}));

const { normaliseChannelId } = await import("../../server/actions/slack");
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

beforeEach(() => {
  vi.clearAllMocks();
  // Link codes live in `link_codes`; the in-memory store keeps this suite database-free.
  resetLinkState();
  process.env.SLACK_CLIENT_ID = "1234.5678";
  process.env.SLACK_CLIENT_SECRET = "shh";
  process.env.SLACK_SIGNING_SECRET = "testsecret";
  stubs.getSlackForOrg.mockImplementation(async () => stubs.row);
  stubs.patchSlackConfig.mockImplementation(async () => ({ ...stubs.row, config: { ...stubs.row.config, channelId: "C0123456789" } }));
  stubs.slackIdentitiesForUser.mockImplementation(async () => ["T1:U1"]);
});

describe("normaliseChannelId", () => {
  it("takes an id or a pasted channel mention", () => {
    expect(normaliseChannelId("C0123456789")).toBe("C0123456789");
    expect(normaliseChannelId(" c0123456789 ")).toBe("C0123456789");
    expect(normaliseChannelId("<#C0123456789|general>")).toBe("C0123456789");
    expect(normaliseChannelId("G01234567")).toBe("G01234567");
  });

  it("refuses a name, a URL or junk", () => {
    // "general" is the trap: upper-cased it looks like a G… id unless a digit is required.
    for (const bad of ["#general", "general", "GENERALS", "", "X0123456789", "C123", "https://acme.slack.com/archives/C0123456789"]) {
      expect(normaliseChannelId(bad), bad).toBeNull();
    }
  });
});

describe("registration", () => {
  it("puts every slack action behind the intended role", () => {
    const roles = Object.fromEntries(
      ["slack.status", "slack.link_code", "slack.unlink", "slack.set_channel", "slack.test", "slack.check_budgets", "slack.disconnect"].map((name) => [name, getAction(name)?.requiredRole]),
    );
    expect(roles).toEqual({
      "slack.status": "member",
      "slack.link_code": "member",
      "slack.unlink": "member",
      "slack.set_channel": "admin",
      "slack.test": "admin",
      "slack.check_budgets": "admin",
      "slack.disconnect": "admin",
    });
    expect(getAction("slack.status")?.surface).toBe("org");
  });
});

describe("slack.status", () => {
  it("reports the install without ever returning the bot token", async () => {
    const status = (await runAction("slack.status", {}, ctxFor("admin"))) as Record<string, unknown>;
    expect(status).toMatchObject({
      appConfigured: true,
      connected: true,
      canManage: true,
      teamId: "T1",
      teamName: "Acme",
      channelId: "C9",
      linked: true,
      slackUserId: "U1",
    });
    expect(JSON.stringify(status)).not.toContain("sealed");
    expect(status.scopes).toEqual(["commands", "chat:write", "users:read", "users:read.email"]);
  });

  it("says the app is not configured when the env vars are missing", async () => {
    process.env.SLACK_CLIENT_SECRET = "";
    const status = (await runAction("slack.status", {}, ctxFor("member"))) as Record<string, unknown>;
    expect(status).toMatchObject({ appConfigured: false, canManage: false });
  });

  it("reports a member with no link, and no install at all", async () => {
    stubs.slackIdentitiesForUser.mockResolvedValue([] as never);
    stubs.getSlackForOrg.mockResolvedValue(null as never);
    const status = (await runAction("slack.status", {}, ctxFor("member"))) as Record<string, unknown>;
    expect(status).toMatchObject({ connected: false, linked: false, teamId: null, channelId: null, slackUserId: null });
  });
});

describe("slack.link_code", () => {
  it("mints a code and the command to paste into Slack", async () => {
    const minted = (await runAction("slack.link_code", {}, ctxFor("member"))) as Record<string, string>;
    expect(minted.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(minted.command).toBe(`/ptd link ${minted.code}`);
    expect(Date.parse(minted.expiresAt)).toBeGreaterThan(Date.now());
    expect(minted.ttlMinutes).toBe(10);
  });

  it("will not mint one before a workspace is connected", async () => {
    stubs.getSlackForOrg.mockResolvedValue(null as never);
    await expect(runAction("slack.link_code", {}, ctxFor("member"))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("slack.set_channel", () => {
  it("normalises the id and stores it", async () => {
    const result = await runAction("slack.set_channel", { channelId: "<#C0123456789|general>" }, ctxFor("admin"));
    expect(stubs.patchSlackConfig).toHaveBeenCalledWith(3, { channelId: "C0123456789" });
    expect(result).toEqual({ channelId: "C0123456789" });
  });

  it("rejects something that is not a channel id", async () => {
    await expect(runAction("slack.set_channel", { channelId: "#general" }, ctxFor("admin"))).rejects.toBeInstanceOf(ActionError);
    expect(stubs.patchSlackConfig).not.toHaveBeenCalled();
  });

  it("is closed to managers and members by the registry, not by itself", async () => {
    for (const role of ["member", "manager"] as Role[]) {
      await expect(runAction("slack.set_channel", { channelId: "C0123456789" }, ctxFor(role))).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(stubs.getSlackForOrg).not.toHaveBeenCalled();
  });
});

describe("slack.test / slack.check_budgets / slack.disconnect", () => {
  it("posts the test message through the notifier", async () => {
    expect(await runAction("slack.test", {}, ctxFor("admin"))).toEqual({ posted: true, channel: "C9", error: null });
    expect(stubs.testSlackConnection).toHaveBeenCalledWith(3, "Dani");
  });

  it("turns a missing channel into an actionable error", async () => {
    stubs.testSlackConnection.mockResolvedValue({ posted: false, channel: null, error: "no_channel_configured" } as never);
    await expect(runAction("slack.test", {}, ctxFor("admin"))).rejects.toMatchObject({ code: "invalid" });
  });

  it("forces a budget sweep", async () => {
    expect(await runAction("slack.check_budgets", {}, ctxFor("owner"))).toMatchObject({ overBudget: 1, posted: 1 });
    expect(stubs.checkStreamBudgets).toHaveBeenCalledWith(3, { force: true });
  });

  it("disconnects, and refuses when there is nothing to disconnect", async () => {
    expect(await runAction("slack.disconnect", {}, ctxFor("admin"))).toMatchObject({ disconnected: true, removed: 1 });
    stubs.removeSlackForOrg.mockResolvedValue(0 as never);
    await expect(runAction("slack.disconnect", {}, ctxFor("admin"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("unlinks the caller's own Slack identities", async () => {
    expect(await runAction("slack.unlink", {}, ctxFor("member"))).toEqual({ removed: 1 });
    expect(stubs.removeSlackIdentitiesForUser).toHaveBeenCalledWith(7);
  });
});
