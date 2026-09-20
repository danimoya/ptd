import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import { fakeDb } from "./fake-db";

vi.mock("../../db", () => ({ db: fakeDb }));

const { registerAuthRoutes, RESET_TTL_MS } = await import("../../server/auth");
const { passwordResets, users } = await import("../../db/schema");
const { resetEmailTransport, setEmailTransport } = await import("../../server/email/transport");
const { hashOpaque } = await import("../../server/oauth/pkce");

/**
 * Forgotten-password, end to end through the routes.
 *
 * Two properties matter more than the happy path and are asserted on their own:
 * an unknown address gets exactly the answer a known one does (otherwise this
 * endpoint is an account-enumeration oracle), and a token can only be spent once.
 */

const REAL_ENV = { ...process.env };
const SAME_ANSWER = "If that address has an account, a reset link is on its way.";

/** A real token is 64 hex characters; the schema refuses anything shorter than 16. */
const TOKEN = "a1b2c3d4".repeat(8);
const OTHER_TOKEN = "f9e8d7c6".repeat(8);

const human = (over: Record<string, unknown> = {}) => ({
  id: 4,
  email: "theo@atelier14.demo",
  passwordHash: "$2a$12$oldhasholdhasholdhasholdhasholdhasholdhasholdhasholdha",
  displayName: "Theo Schibsted",
  isAgent: false,
  createdAt: new Date(),
  ...over,
});

const resetRow = (over: Record<string, unknown> = {}) => ({
  id: 9,
  userId: 4,
  tokenHash: hashOpaque(TOKEN),
  expiresAt: new Date(Date.now() + RESET_TTL_MS),
  usedAt: null,
  createdAt: new Date(),
  ...over,
});

function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  registerAuthRoutes(app);
  return app;
}

const box: Record<string, unknown>[] = [];

beforeEach(() => {
  fakeDb.reset();
  box.length = 0;
  for (const key of Object.keys(process.env)) if (key.startsWith("SMTP_")) delete process.env[key];
  process.env.PTD_BASE_URL = "https://ptd.example";
  resetEmailTransport();
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  resetEmailTransport();
});

/** Pretend SMTP is up, and keep whatever was "sent". */
function withMail() {
  setEmailTransport({
    sendMail: async (message: Record<string, unknown>) => {
      box.push(message);
      return { messageId: "<1@ptd>" };
    },
  } as never);
}

describe("POST /api/auth/forgot", () => {
  it("answers an unknown address exactly as it answers a known one", async () => {
    fakeDb.queue([]); // no user
    const unknown = await request(buildApp()).post("/api/auth/forgot").send({ email: "nobody@example.com" });

    fakeDb.reset().queue([human()]);
    const known = await request(buildApp()).post("/api/auth/forgot").send({ email: "theo@atelier14.demo" });

    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    expect(unknown.body.message).toBe(SAME_ANSWER);
    expect(known.body.message).toBe(SAME_ANSWER);
  });

  it("writes no token for an address with no account", async () => {
    fakeDb.queue([]);
    await request(buildApp()).post("/api/auth/forgot").send({ email: "nobody@example.com" });
    expect(fakeDb.inserts).toHaveLength(0);
  });

  it("stores only a digest of the token, with a thirty-minute life", async () => {
    fakeDb.queue([human()]);
    const res = await request(buildApp()).post("/api/auth/forgot").send({ email: "theo@atelier14.demo" });

    const written = fakeDb.lastInsert(passwordResets)!;
    const token = new URL(res.body.resetUrl).searchParams.get("reset")!;
    expect(written.userId).toBe(4);
    expect(written.tokenHash).toBe(hashOpaque(token));
    expect(written.tokenHash).not.toContain(token);
    const life = written.expiresAt.getTime() - Date.now();
    expect(life).toBeGreaterThan(25 * 60_000);
    expect(life).toBeLessThanOrEqual(30 * 60_000);
  });

  it("mails the link when there is a mail server, and does not hand it back", async () => {
    process.env.SMTP_HOST = "mail.foor.email";
    withMail();
    fakeDb.queue([human()]);

    const res = await request(buildApp()).post("/api/auth/forgot").send({ email: "theo@atelier14.demo" });

    expect(res.body.resetUrl).toBeUndefined();
    expect(box).toHaveLength(1);
    expect(box[0].to).toBe("theo@atelier14.demo");
    expect(String(box[0].text)).toContain("https://ptd.example/auth?reset=");
  });

  it("hands the link back only when there is no mail server to send it", async () => {
    fakeDb.queue([human()]);
    const res = await request(buildApp()).post("/api/auth/forgot").send({ email: "theo@atelier14.demo" });
    expect(res.body.resetUrl).toMatch(/^https:\/\/ptd\.example\/auth\?reset=[a-f0-9]{64}$/);
  });

  it("refuses to reset an agent seat — it has a token, not a mailbox", async () => {
    fakeDb.queue([human({ isAgent: true, email: "claude@agents.local" })]);
    const res = await request(buildApp()).post("/api/auth/forgot").send({ email: "claude@agents.local" });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe(SAME_ANSWER);
    expect(fakeDb.inserts).toHaveLength(0);
  });

  it("validates the address before looking for it", async () => {
    const res = await request(buildApp()).post("/api/auth/forgot").send({ email: "not-an-address" });
    expect(res.status).toBe(400);
    expect(fakeDb.selects).toBe(0);
  });
});

describe("POST /api/auth/reset", () => {
  it("sets the new password with the same work factor as registration", async () => {
    fakeDb.queue([resetRow()], [human()]);
    const res = await request(buildApp()).post("/api/auth/reset").send({ token: TOKEN, password: "theo.brand.new.1" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user?.passwordHash).toBeUndefined();

    const written = fakeDb.lastUpdate(users)!;
    expect(written.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare("theo.brand.new.1", written.passwordHash)).toBe(true);
  });

  it("spends the token, and every other one outstanding on that account", async () => {
    fakeDb.queue([resetRow()], [human()]);
    await request(buildApp()).post("/api/auth/reset").send({ token: TOKEN, password: "theo.brand.new.1" });

    const stamped = fakeDb.lastUpdate(passwordResets)!;
    expect(stamped.usedAt).toBeInstanceOf(Date);
    // One statement stamps the lot: the row just used and every unused sibling.
    expect(fakeDb.updates.filter((u) => u.table === passwordResets)).toHaveLength(1);
  });

  it("refuses a token it has never seen", async () => {
    fakeDb.queue([]);
    const res = await request(buildApp()).post("/api/auth/reset").send({ token: OTHER_TOKEN, password: "whatever.123" });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("unknown");
    expect(fakeDb.updates).toHaveLength(0);
  });

  it("refuses a token that has already been spent", async () => {
    fakeDb.queue([resetRow({ usedAt: new Date() })]);
    const res = await request(buildApp()).post("/api/auth/reset").send({ token: TOKEN, password: "whatever.123" });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("used");
    expect(fakeDb.updates).toHaveLength(0);
  });

  it("refuses a token that has expired", async () => {
    fakeDb.queue([resetRow({ expiresAt: new Date(Date.now() - 60_000) })]);
    const res = await request(buildApp()).post("/api/auth/reset").send({ token: TOKEN, password: "whatever.123" });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("expired");
    expect(fakeDb.updates).toHaveLength(0);
  });

  it("refuses a token whose account has since been deleted", async () => {
    fakeDb.queue([resetRow()], []);
    const res = await request(buildApp()).post("/api/auth/reset").send({ token: TOKEN, password: "whatever.123" });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("unknown");
  });

  it("will not set a password shorter than the register form allows", async () => {
    const res = await request(buildApp()).post("/api/auth/reset").send({ token: TOKEN, password: "short" });
    expect(res.status).toBe(400);
    expect(fakeDb.selects).toBe(0);
  });
});
