import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { fakeDb } from "./fake-db";

vi.mock("../../db", () => ({ db: fakeDb }));

const { registerOrgRoutes, mailInvitation, INVITATION_TTL_MS } = await import("../../server/orgs");
const { invitations } = await import("../../db/schema");
const { ActionError, getAction, runAction } = await import("../../server/actions/registry");
const { resetEmailTransport, setEmailTransport } = await import("../../server/email/transport");
await import("../../server/actions/org");

import type { ActionContext } from "../../server/actions/registry";

/**
 * The invitation link: what an unauthenticated visitor may learn from it, and
 * who may send it again.
 */

const REAL_ENV = { ...process.env };
const TOKEN = "a7d79f60fb54ee50998212ff08d1dd3011e1b4affbfdb56b";

const inviteRow = (over: Record<string, unknown> = {}) => ({
  id: 2,
  orgId: 1,
  email: "nadia@atelier14.demo",
  role: "manager",
  token: TOKEN,
  invitedBy: 1,
  expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
  acceptedAt: null,
  createdAt: new Date(),
  ...over,
});

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  userId: 1,
  email: "elena@atelier14.demo",
  displayName: "Elena Draftworks",
  orgId: 1,
  role: "admin",
  authType: "human",
  via: "web",
  ...over,
});

const box: Record<string, unknown>[] = [];

function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  registerOrgRoutes(app);
  return app;
}

beforeEach(() => {
  fakeDb.reset();
  box.length = 0;
  process.env.PTD_BASE_URL = "https://ptd.example";
  resetEmailTransport();
  setEmailTransport({
    sendMail: async (message: Record<string, unknown>) => {
      box.push(message);
      return { messageId: "<1@ptd>" };
    },
  } as never);
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  resetEmailTransport();
});

describe("GET /api/invitations/:token", () => {
  it("names the organization and the role, without a session", async () => {
    fakeDb.queue([{ email: "nadia@atelier14.demo", role: "manager", expiresAt: new Date(Date.now() + 86_400_000), acceptedAt: null, orgName: "Atelier 14" }]);
    const res = await request(buildApp()).get(`/api/invitations/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orgName: "Atelier 14", role: "manager", email: "nadia@atelier14.demo", expired: false, accepted: false });
  });

  it("says when it has expired rather than pretending it is good", async () => {
    fakeDb.queue([{ email: "nadia@atelier14.demo", role: "member", expiresAt: new Date(Date.now() - 86_400_000), acceptedAt: null, orgName: "Atelier 14" }]);
    const res = await request(buildApp()).get(`/api/invitations/${TOKEN}`);
    expect(res.body.expired).toBe(true);
  });

  it("says when it has already been accepted", async () => {
    fakeDb.queue([{ email: "nadia@atelier14.demo", role: "member", expiresAt: new Date(Date.now() + 86_400_000), acceptedAt: new Date(), orgName: "Atelier 14" }]);
    const res = await request(buildApp()).get(`/api/invitations/${TOKEN}`);
    expect(res.body.accepted).toBe(true);
  });

  it("is a 404 for a token nobody issued", async () => {
    fakeDb.queue([]);
    const res = await request(buildApp()).get(`/api/invitations/${TOKEN}`);
    expect(res.status).toBe(404);
  });

  it("refuses a malformed token without asking the database", async () => {
    const res = await request(buildApp()).get("/api/invitations/not-a-token");
    expect(res.status).toBe(404);
    expect(fakeDb.selects).toBe(0);
  });
});

describe("mailInvitation", () => {
  it("writes to the invited address, with the link built from PTD_BASE_URL", async () => {
    const result = await mailInvitation(inviteRow() as never, "Atelier 14", "Elena Draftworks");
    expect(result.sent).toBe(true);
    expect(box[0].to).toBe("nadia@atelier14.demo");
    expect(String(box[0].text)).toContain(`https://ptd.example/auth?invite=${TOKEN}`);
    expect(String(box[0].text)).toContain("Elena Draftworks has invited you");
  });
});

describe("invitation.resend", () => {
  it("is an admin action on the org surface", () => {
    const def = getAction("invitation.resend")!;
    expect(def.requiredRole).toBe("admin");
    expect(def.surface).toBe("org");
  });

  it("renews the expiry, keeps the token, and mails it again", async () => {
    fakeDb.queue([inviteRow({ expiresAt: new Date(Date.now() - 86_400_000) })], [{ name: "Atelier 14" }]);

    const result = (await runAction("invitation.resend", { invitationId: 2 }, ctx())) as Record<string, any>;

    expect(result.acceptUrl).toBe(`https://ptd.example/auth?invite=${TOKEN}`);
    expect(result.orgName).toBe("Atelier 14");
    expect(result.delivery.sent).toBe(true);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(fakeDb.lastUpdate(invitations)!.expiresAt).toBeInstanceOf(Date);
    expect(box[0].subject).toBe("You're invited to Atelier 14 as manager");
  });

  it("refuses an invitation that has already been accepted", async () => {
    fakeDb.queue([inviteRow({ acceptedAt: new Date() })]);
    await expect(runAction("invitation.resend", { invitationId: 2 }, ctx())).rejects.toMatchObject({ code: "conflict" });
    expect(box).toHaveLength(0);
  });

  it("refuses an id from another organization", async () => {
    fakeDb.queue([]);
    await expect(runAction("invitation.resend", { invitationId: 2 }, ctx())).rejects.toBeInstanceOf(ActionError);
    await expect(runAction("invitation.resend", { invitationId: 2 }, ctx())).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a manager — sending mail in the org's name is an admin act", async () => {
    await expect(runAction("invitation.resend", { invitationId: 2 }, ctx({ role: "manager" }))).rejects.toMatchObject({ code: "forbidden" });
    expect(fakeDb.selects).toBe(0);
  });

  it("reports an SMTP refusal rather than losing the invitation", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setEmailTransport({
      sendMail: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    } as never);
    fakeDb.queue([inviteRow()], [{ name: "Atelier 14" }]);

    const result = (await runAction("invitation.resend", { invitationId: 2 }, ctx())) as Record<string, any>;

    expect(result.delivery).toMatchObject({ sent: false, reason: "smtp_error" });
    expect(result.acceptUrl).toContain(TOKEN);
    spy.mockRestore();
  });
});
