import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * The route end of the Telegram adapter.
 *
 * Two things are worth asserting here and nowhere else: the secret in the path is the
 * credential (a wrong one is indistinguishable from a route that does not exist), and the
 * reply travels back as a Bot API method call on the same connection — which is what
 * makes a command work without any outbound network access.
 */

const stubs = vi.hoisted(() => ({
  handleTelegramMessage: vi.fn(async () => ({
    command: "next",
    orgId: 3,
    reply: { response_type: "ephemeral" as const, text: "Next up", blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Next up* — `PTD-12` Ship it" } }] },
  })),
}));

vi.mock("../../db", () => ({ db: {} }));

vi.mock("../../server/integrations/telegram/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/telegram/commands")>();
  return { ...actual, handleTelegramMessage: stubs.handleTelegramMessage };
});

const { registerTelegramRoutes } = await import("../../server/integrations/telegram/routes");
const { webhookSecretPath, TELEGRAM_SECRET_HEADER } = await import("../../server/integrations/telegram/config");

const TOKEN = "123456:AAH-test-bot-token";

function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerTelegramRoutes(app);
  return app;
}

let app: express.Express;

const update = (text: string) => ({
  update_id: 1,
  message: { message_id: 10, chat: { id: 90210, type: "private" }, from: { id: 55, username: "danimoya", is_bot: false }, text },
});

const post = (secret: string, body: unknown, header?: string) => {
  const req = request(app).post(`/api/integrations/telegram/webhook/${secret}`).set("Content-Type", "application/json");
  if (header !== undefined) req.set(TELEGRAM_SECRET_HEADER, header);
  return req.send(body as object);
};

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.PTD_SECRET_KEY = "telegram-route-test-key";
  process.env.PTD_BASE_URL = "https://ptd.example.com";
  vi.clearAllMocks();
  stubs.handleTelegramMessage.mockResolvedValue({
    command: "next",
    orgId: 3,
    reply: { response_type: "ephemeral", text: "Next up", blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Next up* — `PTD-12` Ship it" } }] },
  });
  app = buildApp();
});

describe("POST /webhook/<secret>", () => {
  it("answers with a sendMessage call carrying the reply as Telegram HTML", async () => {
    const res = await post(webhookSecretPath(), update("/next"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      method: "sendMessage",
      chat_id: 90210,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    expect(res.body.text).toBe("<b>Next up</b> — <code>PTD-12</code> Ship it");
    expect(stubs.handleTelegramMessage).toHaveBeenCalledWith(expect.objectContaining({ fromId: "55", text: "/next" }));
  });

  it("is a 404 on a wrong secret — the same answer as a URL that does not exist", async () => {
    const res = await post(`${webhookSecretPath()}x`, update("/next"));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect(stubs.handleTelegramMessage).not.toHaveBeenCalled();
  });

  it("refuses a delivery whose secret_token header does not match", async () => {
    const res = await post(webhookSecretPath(), update("/next"), "wrong-token");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("bad_secret_token");
    expect(stubs.handleTelegramMessage).not.toHaveBeenCalled();
  });

  it("accepts the matching secret_token header", async () => {
    const res = await post(webhookSecretPath(), update("/next"), webhookSecretPath());
    expect(res.status).toBe(200);
    expect(res.body.method).toBe("sendMessage");
  });

  it("answers 503 when the server has no bot token", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "";
    const res = await post("anything", update("/next"));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("telegram_not_configured");
  });

  it("acknowledges an update that is not a text message, so Telegram stops retrying it", async () => {
    const res = await post(webhookSecretPath(), { update_id: 2, my_chat_member: { chat: { id: 1 } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(stubs.handleTelegramMessage).not.toHaveBeenCalled();
  });

  it("answers with an apology rather than a 500 when the handler throws", async () => {
    stubs.handleTelegramMessage.mockRejectedValue(new Error("boom"));
    const res = await post(webhookSecretPath(), update("/next"));
    expect(res.status).toBe(200);
    expect(res.body.method).toBe("sendMessage");
    expect(res.body.text).toContain("Something went wrong");
  });
});
