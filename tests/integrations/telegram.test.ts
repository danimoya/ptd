import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import type { ActionContext } from "../../server/actions/registry";

/**
 * The Telegram adapter: the derived webhook secret, the `Update` envelope, and the
 * command surface — including `/org`, which exists because a Telegram bot has no
 * workspace to imply an organization.
 *
 * The registry itself is real (the role gate being asserted is the one every adapter
 * goes through); only `runAction` and the database are stubbed.
 */

/**
 * The `/org` choice is a column on the caller's `chat_identities` row now, so the
 * database stub has to answer an UPDATE and a SELECT. Every test in this file talks
 * about the same Telegram account (55), which is why the stub can hold one value
 * instead of modelling the WHERE clause.
 */
const identity = vi.hoisted(() => ({ orgId: null as number | null }));

vi.mock("../../db", () => ({
  db: {
    update: () => ({
      set: (values: { orgId: number | null }) => ({
        where: async () => {
          identity.orgId = values.orgId ?? null;
        },
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ orgId: identity.orgId }] }) }) }),
  },
}));

// The verb table names real actions, so the modules that define them are imported.
await import("../../server/actions/core");
await import("../../server/actions/plan");
await import("../../server/actions/track");
await import("../../server/actions/overview");

const {
  isTelegramConfigured,
  secretPathMatches,
  telegramWebhookPath,
  telegramWebhookUrl,
  webhookSecretPath,
} = await import("../../server/integrations/telegram/config");
const { handleTelegramMessage, parseTelegramCommand, readUpdate } = await import("../../server/integrations/telegram/commands");
const { orgChoiceOf } = await import("../../server/integrations/telegram/identity");
const { mintLinkCode, resetLinkState } = await import("../../server/integrations/shared/linkCodes");
const { replyToTelegramHtml } = await import("../../server/integrations/shared/markup");
const { TELEGRAM_PROVIDER } = await import("../../server/integrations/shared/providers");

const TOKEN = "123456:AAH-test-bot-token";
const ORGS = [
  { orgId: 3, name: "Acme", slug: "acme", role: "member" as const },
  { orgId: 8, name: "Beta Lab", slug: "beta", role: "manager" as const },
];

const ctxFor = (orgId = 3, role: "member" | "manager" | "admin" | "owner" = "member"): ActionContext => ({
  userId: 7,
  email: "dani@example.com",
  displayName: "Dani",
  orgId,
  role,
  authType: "human",
  via: "telegram",
});

const update = (text: string, overrides: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: {
    message_id: 10,
    chat: { id: 90210, type: "private" },
    from: { id: 55, username: "danimoya", first_name: "Dani", is_bot: false },
    text,
    ...overrides,
  },
});

let runAction: ReturnType<typeof vi.fn>;
let resolveTask: ReturnType<typeof vi.fn>;
let link: ReturnType<typeof vi.fn>;
let unlink: ReturnType<typeof vi.fn>;
let caller: { ok: boolean; [key: string]: unknown };

const run = (text: string) =>
  handleTelegramMessage(readUpdate(update(text))!, {
    runAction: runAction as never,
    resolveTask: resolveTask as never,
    link: link as never,
    unlink: unlink as never,
    resolveCaller: (async () => caller) as never,
  });

const body = (reply: { blocks: unknown[] }): string => {
  const block = reply.blocks[0] as { text?: { text?: string } };
  return block.text?.text ?? "";
};
const contextOf = (reply: { blocks: unknown[] }): string => {
  const block = reply.blocks[1] as { elements?: { text?: string }[] } | undefined;
  return block?.elements?.[0]?.text ?? "";
};

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.PTD_SECRET_KEY = "telegram-test-key";
  process.env.PTD_BASE_URL = "https://ptd.example.com";
  resetLinkState(TELEGRAM_PROVIDER);
  identity.orgId = null;
  runAction = vi.fn(async () => ({}));
  resolveTask = vi.fn(async () => ({ id: 42, title: "Ship the adapter", externalKey: "PTD-12" }));
  link = vi.fn(async () => undefined);
  unlink = vi.fn(async () => 1);
  caller = { ok: true, ctx: ctxFor(), userId: 7, orgs: ORGS };
});

describe("the derived webhook secret", () => {
  it("is HMAC(PTD_SECRET_KEY, bot token), and is not the token", () => {
    const expected = createHmac("sha256", "telegram-test-key").update(`telegram-webhook:${TOKEN}`, "utf8").digest("hex").slice(0, 32);
    expect(webhookSecretPath()).toBe(expected);
    expect(webhookSecretPath()).toMatch(/^[0-9a-f]{32}$/);
    expect(webhookSecretPath()).not.toContain(TOKEN);
    expect(telegramWebhookPath()).toBe(`/api/integrations/telegram/webhook/${expected}`);
    expect(telegramWebhookUrl()).toBe(`https://ptd.example.com/api/integrations/telegram/webhook/${expected}`);
  });

  it("changes when either input changes — rotating one rotates the URL", () => {
    const first = webhookSecretPath();
    process.env.PTD_SECRET_KEY = "rotated";
    expect(webhookSecretPath()).not.toBe(first);
    process.env.PTD_SECRET_KEY = "telegram-test-key";
    expect(webhookSecretPath("999:other-token")).not.toBe(first);
  });

  it("matches only itself, and nothing at all without a token", () => {
    expect(secretPathMatches(webhookSecretPath())).toBe(true);
    expect(secretPathMatches(`${webhookSecretPath()}x`)).toBe(false);
    expect(secretPathMatches("")).toBe(false);
    expect(secretPathMatches("anything", "")).toBe(false);
    expect(isTelegramConfigured("")).toBe(false);
  });
});

describe("readUpdate", () => {
  it("reads a private message and an edited one", () => {
    expect(readUpdate(update("/next"))).toMatchObject({ fromId: "55", username: "danimoya", chatId: 90210, text: "/next" });
    expect(readUpdate({ update_id: 2, edited_message: update("/today").message })).toMatchObject({ text: "/today" });
  });

  it("ignores anything that is not a message from a person", () => {
    expect(readUpdate({ update_id: 3 })).toBeNull();
    expect(readUpdate({ update_id: 4, message: { chat: { id: 1 }, from: { id: 9, is_bot: true }, text: "/next" } })).toBeNull();
    expect(readUpdate(null)).toBeNull();
  });
});

describe("parseTelegramCommand", () => {
  it("strips the slash and the @botname a group chat appends", () => {
    expect(parseTelegramCommand("/log@ptd_bot 45m PTD-12")).toEqual({ command: "log", rest: "45m PTD-12", botName: "ptd_bot" });
    expect(parseTelegramCommand("/next")).toEqual({ command: "next", rest: "", botName: null });
    expect(parseTelegramCommand("  /START PTD-12 fixing it ")).toEqual({ command: "start", rest: "PTD-12 fixing it", botName: null });
    expect(parseTelegramCommand("next")).toEqual({ command: "next", rest: "", botName: null });
    expect(parseTelegramCommand("")).toEqual({ command: "", rest: "", botName: null });
  });
});

describe("commands → actions", () => {
  it("runs the same actions as Slack, with via telegram", async () => {
    await run("/next");
    expect(runAction).toHaveBeenCalledWith("next_task", { assignee: "me" }, expect.objectContaining({ via: "telegram", authType: "human" }));

    runAction.mockClear();
    await run("/start PTD-12 fixing the parser");
    expect(resolveTask).toHaveBeenCalledWith(3, "PTD-12");
    expect(runAction).toHaveBeenCalledWith("time_entry.start", { taskId: 42, notes: "fixing the parser" }, expect.anything());

    runAction.mockClear();
    await run("/log 1h30m PTD-12");
    const [name, args] = runAction.mock.calls[0];
    expect(name).toBe("time_entry.log_past");
    expect(Date.parse((args as { checkOut: string }).checkOut) - Date.parse((args as { checkIn: string }).checkIn)).toBe(90 * 60_000);

    runAction.mockClear();
    await run("/stop tokens=1200 cost=0.12 shipped it");
    expect(runAction).toHaveBeenCalledWith("time_entry.stop", { tokensUsed: 1200, apiCostUsd: 0.12, notes: "shipped it" }, expect.anything());

    runAction.mockClear();
    await run("/done PTD-12");
    expect(runAction).toHaveBeenCalledWith("task.complete", { taskId: 42 }, expect.anything());
  });

  it("writes its usage hints with Telegram's single slash, not /ptd", async () => {
    const reply = await run("/done");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply.reply)).toContain("`/done PTD-12`");
    expect(body(reply.reply)).not.toContain("/ptd");

    const logged = await run("/log PTD-12");
    expect(body(logged.reply)).toContain("`/log 45m PTD-12`");
    expect(body(logged.reply)).not.toContain("/ptd");
  });

  it("answers a bare /start with help, because Telegram sends it when the chat opens", async () => {
    const opened = await run("/start");
    expect(opened.command).toBe("start");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(opened.reply)).toContain("PTD commands");

    // With a task it is the timer verb again, exactly as in Slack.
    const started = await run("/start PTD-12");
    expect(runAction).toHaveBeenCalledWith("time_entry.start", { taskId: 42 }, expect.anything());
    expect(body(started.reply)).not.toContain("PTD commands");
  });

  it("applies the registry's role gate before it reaches the registry", async () => {
    const reply = await run("/stats");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply.reply)).toBe("Your role (member) can't do that — ask a manager.");
    expect(contextOf(reply.reply)).toContain("/stats` needs manager");

    caller = { ok: true, ctx: ctxFor(3, "manager"), userId: 7, orgs: ORGS };
    await run("/stats");
    expect(runAction).toHaveBeenCalledWith("stats", {}, expect.anything());
  });

  it("lists only the commands a role allows, Telegram's own included", async () => {
    const help = await run("/help");
    expect(body(help.reply)).toContain("/next");
    expect(body(help.reply)).toContain("/org &lt;id&gt;");
    expect(body(help.reply)).toContain("/unlink");
    expect(body(help.reply)).not.toContain("/stats");
    expect(contextOf(help.reply)).toContain("higher role");
  });

  it("says so when it does not know a command", async () => {
    const reply = await run("/frobnicate");
    expect(body(reply.reply)).toContain("/frobnicate");
    expect(contextOf(reply.reply)).toContain("/help");
  });
});

describe("identity and organization", () => {
  it("tells an unlinked account how to link, without running anything", async () => {
    caller = { ok: false, reason: "not_linked" };
    const reply = await run("/today");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply.reply)).toContain("not linked");
    expect(body(reply.reply)).toContain("/link <code>");
  });

  it("links with a code minted in any organization — the bot serves all of them", async () => {
    const { code } = await mintLinkCode(TELEGRAM_PROVIDER, { userId: 7, orgId: 8, displayName: "Dani" });
    const reply = await run(`/link ${code}`);
    expect(link).toHaveBeenCalledWith(7, "55");
    expect(body(reply.reply)).toContain("Linked.");
    expect(body(reply.reply)).toContain("@danimoya");
  });

  it("spends the code once and refuses a Slack code", async () => {
    const { code } = await mintLinkCode(TELEGRAM_PROVIDER, { userId: 7, orgId: 3, displayName: "Dani" });
    await run(`/link ${code}`);
    expect(body((await run(`/link ${code}`)).reply)).toContain("not valid");

    const slack = await mintLinkCode("slack", { userId: 7, orgId: 3, displayName: "Dani" });
    expect(body((await run(`/link ${slack.code}`)).reply)).toContain("not valid");
  });

  it("unlinks, and says so when there was nothing to unlink", async () => {
    expect(body((await run("/unlink")).reply)).toContain("Unlinked.");
    unlink = vi.fn(async () => 0);
    expect(body((await run("/unlink")).reply)).toContain("not linked");
  });

  it("/org lists the organizations and /org <id> selects one", async () => {
    const listed = await run("/org");
    expect(body(listed.reply)).toContain("Acme");
    expect(body(listed.reply)).toContain("Beta Lab");

    const chosen = await run("/org 8");
    expect(body(chosen.reply)).toContain("Beta Lab");
    await expect(orgChoiceOf("55")).resolves.toBe(8);
  });

  it("refuses an organization the caller does not belong to", async () => {
    const reply = await run("/org 99");
    expect(body(reply.reply)).toContain("not a member of organization 99");
    await expect(orgChoiceOf("55")).resolves.toBeNull();
    expect(body((await run("/org nope")).reply)).toContain("not an organization id");
  });

  it("makes them choose again when they lost the membership they had selected", async () => {
    caller = { ok: false, reason: "not_a_member_of_choice", userId: 7, orgs: ORGS };
    const reply = await run("/today");
    expect(body(reply.reply)).toContain("no longer a member");
    expect(contextOf(reply.reply)).toContain("3, 8");
    expect(runAction).not.toHaveBeenCalled();
  });
});

describe("rendering for Telegram", () => {
  it("turns the shared mrkdwn into HTML Telegram accepts, with content escaped", async () => {
    runAction = vi.fn(async () => ({
      task: { id: 42, title: "<script> & friends", externalKey: "PTD-12", status: "triaged", priorityScore: 63 },
      why: { formula: "urgency 7 × impact 9 ÷ effort 1 = 63", band: "high" },
    }));
    const reply = await run("/next");
    const html = replyToTelegramHtml(reply.reply);
    expect(html).toContain("<b>");
    expect(html).toContain("<code>PTD-12</code>");
    expect(html).toContain("&lt;script&gt; &amp; friends");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("*");
  });

  it("resolves the Slack-only date token into readable text", async () => {
    runAction = vi.fn(async () => ({
      entry: { taskTitle: "Ship it", checkIn: new Date("2026-09-19T10:00:00.000Z"), checkOut: null },
    }));
    const html = replyToTelegramHtml((await run("/start PTD-12")).reply);
    expect(html).not.toContain("<!date");
    expect(html).toContain("2026-09-19 10:00Z");
  });
});
