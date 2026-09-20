import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import type { ActionContext } from "../../server/actions/registry";

/**
 * The Teams adapter: the HMAC that doubles as tenant resolution, the mention stripping,
 * and the command surface.
 *
 * The registry itself is real (the role gate being asserted is the one every adapter goes
 * through); only `runAction` and the database are stubbed.
 */

vi.mock("../../db", () => ({ db: {} }));

// The verb table names real actions, so the modules that define them are imported.
await import("../../server/actions/core");
await import("../../server/actions/plan");
await import("../../server/actions/track");
await import("../../server/actions/overview");

const { stripMention } = await import("../../server/integrations/teams/config");
const { looksLikeTeamsSecret, teamsSignature, verifyTeamsRequest } = await import("../../server/integrations/teams/verify");
const { handleTeamsActivity, readActivity } = await import("../../server/integrations/teams/commands");
const { mintLinkCode, resetLinkState } = await import("../../server/integrations/shared/linkCodes");
const { replyToPlainText } = await import("../../server/integrations/shared/markup");
const { TEAMS_PROVIDER } = await import("../../server/integrations/shared/providers");

const SECRET = Buffer.from("a-teams-outgoing-webhook-secret").toString("base64");
const OTHER_SECRET = Buffer.from("a-different-organizations-secret").toString("base64");

const ctxFor = (role: "member" | "manager" | "admin" | "owner" = "member"): ActionContext => ({
  userId: 7,
  email: "dani@example.com",
  displayName: "Dani",
  orgId: 3,
  role,
  authType: "human",
  via: "teams",
});

const activityBody = (text: string, overrides: Record<string, unknown> = {}) => ({
  type: "message",
  text,
  from: { id: "29:abc", name: "Dani Moya", aadObjectId: "AAD-OBJ-1" },
  conversation: { id: "19:channel@thread.tacv2", name: "Engineering" },
  channelData: { team: { name: "Acme Engineering" } },
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  ...overrides,
});

let runAction: ReturnType<typeof vi.fn>;
let resolveTask: ReturnType<typeof vi.fn>;
let link: ReturnType<typeof vi.fn>;
let unlink: ReturnType<typeof vi.fn>;
let caller: { ok: boolean; [key: string]: unknown };

const run = (text: string, overrides: Record<string, unknown> = {}) =>
  handleTeamsActivity(
    { activity: readActivity(activityBody(text, overrides))!, orgId: 3, orgName: "Acme", teamName: "Acme Engineering" },
    {
      runAction: runAction as never,
      resolveTask: resolveTask as never,
      link: link as never,
      unlink: unlink as never,
      resolveCaller: (async () => caller) as never,
    },
  );

const body = (reply: { blocks: unknown[] }): string => {
  const block = reply.blocks[0] as { text?: { text?: string } };
  return block.text?.text ?? "";
};
const contextOf = (reply: { blocks: unknown[] }): string => {
  const block = reply.blocks[1] as { elements?: { text?: string }[] } | undefined;
  return block?.elements?.[0]?.text ?? "";
};

beforeEach(() => {
  process.env.PTD_SECRET_KEY = "teams-test-key";
  resetLinkState(TEAMS_PROVIDER);
  runAction = vi.fn(async () => ({}));
  resolveTask = vi.fn(async () => ({ id: 42, title: "Ship the adapter", externalKey: "PTD-12" }));
  link = vi.fn(async () => undefined);
  unlink = vi.fn(async () => 1);
  caller = { ok: true, ctx: ctxFor(), userId: 7 };
});

describe("verifyTeamsRequest", () => {
  const BODY = JSON.stringify({ type: "message", text: "<at>PTD</at> next" });

  it("is HMAC <base64 HMAC-SHA256 of the raw body> keyed with the DECODED secret", () => {
    const expected = `HMAC ${createHmac("sha256", Buffer.from(SECRET, "base64")).update(BODY, "utf8").digest("base64")}`;
    expect(teamsSignature(SECRET, BODY)).toBe(expected);
    expect(verifyTeamsRequest({ rawBody: BODY, header: expected, secrets: [SECRET] })).toEqual({ ok: true, secret: SECRET });
  });

  it("would not verify if the key were the secret string rather than its bytes", () => {
    const wrong = `HMAC ${createHmac("sha256", SECRET).update(BODY, "utf8").digest("base64")}`;
    expect(verifyTeamsRequest({ rawBody: BODY, header: wrong, secrets: [SECRET] })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("names WHICH secret matched — that is how the organization is resolved", () => {
    const header = teamsSignature(OTHER_SECRET, BODY);
    expect(verifyTeamsRequest({ rawBody: BODY, header, secrets: [SECRET, OTHER_SECRET] })).toEqual({ ok: true, secret: OTHER_SECRET });
  });

  it("rejects a changed body, a wrong secret, a missing header and no secrets at all", () => {
    const header = teamsSignature(SECRET, BODY);
    expect(verifyTeamsRequest({ rawBody: `${BODY} `, header, secrets: [SECRET] })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTeamsRequest({ rawBody: BODY, header, secrets: [OTHER_SECRET] })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTeamsRequest({ rawBody: BODY, header: null, secrets: [SECRET] })).toEqual({ ok: false, reason: "missing_header" });
    expect(verifyTeamsRequest({ rawBody: BODY, header: "Bearer x", secrets: [SECRET] })).toEqual({ ok: false, reason: "missing_header" });
    expect(verifyTeamsRequest({ rawBody: BODY, header, secrets: [] })).toEqual({ ok: false, reason: "no_secret" });
  });

  it("refuses a pasted value that cannot be a Teams secret", () => {
    expect(looksLikeTeamsSecret(SECRET)).toBe(true);
    for (const bad of ["", "short", "not base64 at all!", "AAAA"]) expect(looksLikeTeamsSecret(bad), bad).toBe(false);
  });
});

describe("stripMention", () => {
  it("removes the mention however Teams rendered it", () => {
    expect(stripMention("<at>PTD</at> next")).toBe("next");
    expect(stripMention('<at id="0">PTD</at>  start PTD-12 now')).toBe("start PTD-12 now");
    expect(stripMention("PTD next")).toBe("next");
    expect(stripMention("@PTD: next")).toBe("next");
    expect(stripMention(" <at>PTD</at> today")).toBe("today");
    expect(stripMention("<at>PTD</at>")).toBe("");
  });

  it("leaves a task key that merely contains the bot's name alone", () => {
    expect(stripMention("<at>PTD</at> done PTD-12")).toBe("done PTD-12");
  });
});

describe("readActivity", () => {
  it("takes the Entra object id, the team name and the de-mentioned text", () => {
    expect(readActivity(activityBody("<at>PTD</at> next"))).toMatchObject({
      aadObjectId: "AAD-OBJ-1",
      fromName: "Dani Moya",
      text: "next",
      teamName: "Acme Engineering",
    });
  });

  it("ignores an activity that is not a message", () => {
    expect(readActivity({ type: "conversationUpdate" })).toBeNull();
  });
});

describe("commands → actions", () => {
  it("runs the same actions as Slack, with via teams", async () => {
    await run("<at>PTD</at> next");
    expect(runAction).toHaveBeenCalledWith("next_task", { assignee: "me" }, expect.objectContaining({ via: "teams", authType: "human" }));

    runAction.mockClear();
    await run("<at>PTD</at> start PTD-12 pairing");
    expect(resolveTask).toHaveBeenCalledWith(3, "PTD-12");
    expect(runAction).toHaveBeenCalledWith("time_entry.start", { taskId: 42, notes: "pairing" }, expect.anything());

    runAction.mockClear();
    await run("<at>PTD</at> tasks in-progress");
    expect(runAction).toHaveBeenCalledWith("task.list", { status: "in-progress" }, expect.anything());
  });

  it("writes its usage hints as @PTD …", async () => {
    const reply = await run("<at>PTD</at> done");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply.reply)).toContain("`@PTD done PTD-12`");
  });

  it("applies the role gate before it reaches the registry", async () => {
    const refused = await run("<at>PTD</at> stats");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(refused.reply)).toBe("Your role (member) can't do that — ask a manager.");
    expect(contextOf(refused.reply)).toContain("@PTD stats` needs manager");

    caller = { ok: true, ctx: ctxFor("manager"), userId: 7 };
    await run("<at>PTD</at> stats");
    expect(runAction).toHaveBeenCalledWith("stats", {}, expect.anything());
  });

  it("lists role-filtered help with @PTD usages", async () => {
    const help = await run("<at>PTD</at> help");
    expect(body(help.reply)).toContain("@PTD next");
    expect(body(help.reply)).toContain("@PTD unlink");
    expect(body(help.reply)).not.toContain("@PTD stats");
  });
});

describe("identity", () => {
  it("tells an unlinked account how to link, without running anything", async () => {
    caller = { ok: false, reason: "not_linked" };
    const reply = await run("<at>PTD</at> today");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply.reply)).toContain("not linked");
    expect(body(reply.reply)).toContain("@PTD link <code>");
  });

  it("links with a code minted in this organization and binds the Entra object id", async () => {
    const { code } = await mintLinkCode(TEAMS_PROVIDER, { userId: 7, orgId: 3, displayName: "Dani" });
    const reply = await run(`<at>PTD</at> link ${code}`);
    expect(link).toHaveBeenCalledWith(7, "AAD-OBJ-1");
    expect(body(reply.reply)).toContain("Linked.");
    expect(body(reply.reply)).toContain("Dani Moya");
  });

  it("refuses a code minted in another organization — Teams knows its org from the secret", async () => {
    const { code } = await mintLinkCode(TEAMS_PROVIDER, { userId: 7, orgId: 99, displayName: "Dani" });
    const reply = await run(`<at>PTD</at> link ${code}`);
    expect(link).not.toHaveBeenCalled();
    expect(body(reply.reply)).toContain("different PTD organization");
    expect(body(reply.reply)).toContain("Teams team");
  });

  it("explains a linked account that is not a member of the connected organization", async () => {
    caller = { ok: false, reason: "no_membership", userId: 7 };
    const reply = await run("<at>PTD</at> today");
    expect(body(reply.reply)).toContain("not a member of Acme");
  });

  it("refuses to act for an account Teams gave no Entra id for", async () => {
    const reply = await run("<at>PTD</at> next", { from: { id: "29:abc", name: "Anonymous" } });
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply.reply)).toContain("did not tell me who you are");
  });

  it("unlinks, and says so when there was nothing to unlink", async () => {
    expect(body((await run("<at>PTD</at> unlink")).reply)).toContain("Unlinked.");
    unlink = vi.fn(async () => 0);
    expect(body((await run("<at>PTD</at> unlink")).reply)).toContain("not linked");
  });
});

describe("rendering for Teams", () => {
  it("is flat text: no markers, entities restored, newlines kept", async () => {
    runAction = vi.fn(async () => ({
      task: { id: 42, title: "<script> & friends", externalKey: "PTD-12", status: "triaged", priorityScore: 63 },
      why: { formula: "urgency 7 × impact 9 ÷ effort 1 = 63", band: "high" },
    }));
    const text = replyToPlainText((await run("<at>PTD</at> next")).reply);
    expect(text).not.toMatch(/[*`]/);
    expect(text).toContain("<script> & friends");
    expect(text).toContain("Next up");
    expect(text).toContain("\n");
  });
});
