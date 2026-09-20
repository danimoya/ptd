import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The layer the three chat adapters share.
 *
 * The point of these tests is parity: one verb table, one link-code store, one renderer,
 * and three dialects of the same reply. If Slack gains a verb and Telegram does not, or a
 * Telegram code can be spent in Slack, it fails here rather than in a user's chat window.
 */

vi.mock("../../db", () => ({ db: {} }));

await import("../../server/actions/core");
await import("../../server/actions/plan");
await import("../../server/actions/track");
await import("../../server/actions/overview");

const { getAction } = await import("../../server/actions/registry");
const { VERBS, canonicalVerb, usageOf, verbByName } = await import("../../server/integrations/shared/verbs");
const { SUBCOMMANDS, SLACK_PREFIX } = await import("../../server/integrations/slack/commands");
const { TELEGRAM_PREFIX } = await import("../../server/integrations/telegram/config");
const { TEAMS_PREFIX } = await import("../../server/integrations/teams/config");
const { emojify, linesOf, replyToPlainText, replyToTelegramHtml, resolveSlackTokens, toPlainText, toTelegramHtml } = await import(
  "../../server/integrations/shared/markup"
);
const { ephemeral, errorReply } = await import("../../server/integrations/shared/format");
const shared = await import("../../server/integrations/shared/linkCodes");
const slackCodes = await import("../../server/integrations/slack/linkCodes");

describe("the verb table", () => {
  it("names only actions that exist in the registry", () => {
    for (const verb of VERBS) expect(getAction(verb.action), verb.action).toBeDefined();
  });

  it("is the same vocabulary on all three surfaces, spelled each surface's way", () => {
    expect(SUBCOMMANDS.map((s) => s.name)).toEqual(VERBS.map((v) => v.name));
    expect(usageOf(verbByName("start")!, SLACK_PREFIX)).toBe("/ptd start <TASK-KEY> [notes]");
    expect(usageOf(verbByName("start")!, TELEGRAM_PREFIX)).toBe("/start <TASK-KEY> [notes]");
    expect(usageOf(verbByName("start")!, TEAMS_PREFIX)).toBe("@PTD start <TASK-KEY> [notes]");
    expect(usageOf(verbByName("next")!, TELEGRAM_PREFIX)).toBe("/next");
  });

  it("resolves the words people actually type, on every surface at once", () => {
    expect(canonicalVerb("begin")).toBe("start");
    expect(canonicalVerb("FINISH")).toBe("done");
    expect(canonicalVerb("list")).toBe("tasks");
    expect(canonicalVerb("")).toBe("help");
    expect(canonicalVerb("?")).toBe("help");
    expect(canonicalVerb("frobnicate")).toBe("frobnicate");
  });
});

describe("link codes are scoped per provider", () => {
  beforeEach(() => shared.resetLinkState());

  it("does not let a code minted for one provider be spent in another", () => {
    const telegram = shared.mintLinkCode("telegram", { userId: 7, orgId: 3, displayName: "Dani" });
    expect(shared.peekLinkCode("slack", telegram.code)).toBeNull();
    expect(shared.consumeLinkCode("slack", telegram.code)).toBeNull();
    expect(shared.consumeLinkCode("telegram", telegram.code)).toMatchObject({ userId: 7, orgId: 3 });
  });

  it("does not invalidate a person's Slack code when they mint a Telegram one", () => {
    const slack = shared.mintLinkCode("slack", { userId: 7, orgId: 3, displayName: "Dani" });
    shared.mintLinkCode("telegram", { userId: 7, orgId: 3, displayName: "Dani" });
    expect(shared.peekLinkCode("slack", slack.code)).not.toBeNull();
  });

  it("still drops the previous code of the same person in the same provider and org", () => {
    const first = shared.mintLinkCode("teams", { userId: 7, orgId: 3, displayName: "Dani" });
    shared.mintLinkCode("teams", { userId: 7, orgId: 3, displayName: "Dani" });
    expect(shared.peekLinkCode("teams", first.code)).toBeNull();
  });

  it("counts failures per provider and per account", () => {
    for (let i = 0; i < 11; i++) shared.recordLinkFailure("telegram", "55");
    expect(shared.linkAttemptsBlocked("telegram", "55")).toBe(true);
    expect(shared.linkAttemptsBlocked("slack", "55")).toBe(false);
    expect(shared.linkAttemptsBlocked("telegram", "66")).toBe(false);
    shared.clearLinkFailures("telegram", "55");
    expect(shared.linkAttemptsBlocked("telegram", "55")).toBe(false);
  });

  it("keeps the Slack adapter's own door onto it working unchanged", () => {
    slackCodes.resetLinkState();
    const minted = slackCodes.mintLinkCode({ userId: 7, orgId: 3, displayName: "Dani" });
    expect(minted.code).toHaveLength(slackCodes.LINK_CODE_LENGTH);
    expect(shared.peekLinkCode("slack", minted.code)).not.toBeNull();
    expect(slackCodes.consumeLinkCode(minted.code)).toMatchObject({ userId: 7 });
    expect(slackCodes.consumeLinkCode(minted.code)).toBeNull();
  });
});

describe("one reply, three dialects", () => {
  const reply = ephemeral(
    ["*Next up* — `PTD-12` <script> & friends", "_score 63_"],
    ["start it with `/ptd start PTD-12`"],
  );

  it("pulls the body and the context line out of Block Kit", () => {
    const { body, context } = linesOf(reply);
    expect(body).toContain("Next up");
    expect(context).toBe("start it with `/ptd start PTD-12`");
  });

  it("turns mrkdwn into Telegram HTML, and only emits tags of its own", () => {
    const html = toTelegramHtml("*bold* _italic_ `code` plain");
    expect(html).toBe("<b>bold</b> <i>italic</i> <code>code</code> plain");
    expect(replyToTelegramHtml(reply)).toContain("<i>start it with <code>/ptd start PTD-12</code></i>");
  });

  it("leaves content that came through `escape` escaped, so a title cannot inject a tag", () => {
    const html = replyToTelegramHtml(reply);
    expect(html).toContain("&lt;script&gt; &amp; friends");
    expect(html).not.toContain("<script>");
  });

  it("does not turn an unbalanced marker into runaway emphasis", () => {
    expect(toTelegramHtml("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(toTelegramHtml("a_b_c")).toBe("a_b_c");
    expect(toTelegramHtml("snake_case_name here")).toBe("snake_case_name here");
    expect(toTelegramHtml("*unclosed")).toBe("*unclosed");
  });

  it("keeps an asterisk inside a code span literal", () => {
    expect(toTelegramHtml("`a*b*c` and *bold*")).toBe("<code>a*b*c</code> and <b>bold</b>");
  });

  it("resolves the Slack-only tokens, which mean nothing anywhere else", () => {
    expect(resolveSlackTokens("<!date^1789812000^{date_short_pretty} {time}|2026-09-19 10:00Z>")).toBe("2026-09-19 10:00Z");
    expect(resolveSlackTokens("linked to <@U123>")).toBe("linked to @U123");
    expect(resolveSlackTokens("in <#C1|general>")).toBe("in #general");
  });

  it("turns the shortcodes the renderers use into real emoji", () => {
    expect(emojify(":white_check_mark: done")).toBe("✅ done");
    expect(emojify(":not_a_real_emoji:")).toBe(":not_a_real_emoji:");
  });

  it("flattens to plain text for Teams: markers gone, entities restored, newlines kept", () => {
    const text = replyToPlainText(reply);
    expect(text).not.toMatch(/[*`_]/);
    expect(text).toContain("<script> & friends");
    expect(text).toContain("\n(start it with /ptd start PTD-12)");
    expect(toPlainText("*bold* `code`")).toBe("bold code");
  });

  it("handles a reply with no context line on either surface", () => {
    const bare = errorReply("Nothing found.");
    expect(replyToTelegramHtml(bare)).toBe("Nothing found.");
    expect(replyToPlainText(bare)).toBe("Nothing found.");
  });
});
