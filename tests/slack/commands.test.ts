import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "../../db/schema";

// The mapping under test is pure orchestration: the registry's real action
// definitions supply the role gate, `runAction` is a spy, and the task lookup is
// stubbed — so no database is involved anywhere in this file.
vi.mock("../../db", () => ({ db: {} }));

// Importing these modules registers the real actions (and therefore the real
// requiredRole of each one). The other surfaces' action files are deliberately not
// imported: nothing here needs them.
await import("../../server/actions/core");
await import("../../server/actions/plan");
await import("../../server/actions/track");
await import("../../server/actions/overview");

const { ActionError } = await import("../../server/actions/registry");
const { SUBCOMMANDS, handleLink, handleSlashCommand, handleUnlink } = await import("../../server/integrations/slack/commands");
const { mintLinkCode, resetLinkState } = await import("../../server/integrations/slack/linkCodes");
import type { ActionContext } from "../../server/actions/registry";
import type { SlashPayload } from "../../server/integrations/slack/commands";
import type { SlackReply } from "../../server/integrations/slack/format";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");

const ctxFor = (role: Role = "member"): ActionContext => ({
  userId: 7,
  email: "dani@example.com",
  displayName: "Dani",
  orgId: 3,
  role,
  authType: "human",
  via: "slack",
});

const payloadFor = (text: string): SlashPayload => ({
  teamId: "T1",
  teamDomain: "acme",
  channelId: "C1",
  channelName: "general",
  userId: "U1",
  userName: "dani",
  command: "/ptd",
  text,
  responseUrl: "https://hooks.slack.com/commands/T1/1/x",
  triggerId: "trig",
  apiAppId: "A1",
});

let runAction: ReturnType<typeof vi.fn>;
let resolveTask: ReturnType<typeof vi.fn>;

const body = (reply: SlackReply): string => {
  const block = reply.blocks[0] as { text?: { text?: string } };
  return block.text?.text ?? "";
};
const contextOf = (reply: SlackReply): string => {
  const block = reply.blocks[1] as { elements?: { text?: string }[] } | undefined;
  return block?.elements?.[0]?.text ?? "";
};

const run = (text: string, role: Role = "member") =>
  handleSlashCommand({ ctx: ctxFor(role), payload: payloadFor(text), teamName: "Acme" }, { runAction, resolveTask, now: () => NOW });

beforeEach(() => {
  resetLinkState();
  runAction = vi.fn(async () => ({}));
  resolveTask = vi.fn(async () => ({ id: 42, title: "Ship the Slack adapter", externalKey: "PTD-12" }));
});

describe("every subcommand maps onto a registered action", () => {
  it("names actions that exist in the registry", async () => {
    const { getAction } = await import("../../server/actions/registry");
    for (const sub of SUBCOMMANDS) expect(getAction(sub.action), sub.action).toBeDefined();
  });
});

describe("subcommand → action", () => {
  it("/ptd next asks for the caller's own next task", async () => {
    await run("next");
    expect(runAction).toHaveBeenCalledWith("next_task", { assignee: "me" }, expect.objectContaining({ via: "slack", authType: "human" }));
  });

  it("/ptd start resolves the task key and keeps the rest as notes", async () => {
    await run("start PTD-12 fixing the parser");
    expect(resolveTask).toHaveBeenCalledWith(3, "PTD-12");
    expect(runAction).toHaveBeenCalledWith("time_entry.start", { taskId: 42, notes: "fixing the parser" }, expect.anything());
  });

  it("/ptd start without a task asks for one and runs nothing", async () => {
    const reply = await run("start");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply)).toContain("Name a task");
  });

  it("/ptd stop parses tokens= and cost= and leaves the note alone", async () => {
    await run("stop tokens=1200 cost=0.12 shipped it");
    expect(runAction).toHaveBeenCalledWith("time_entry.stop", { tokensUsed: 1200, apiCostUsd: 0.12, notes: "shipped it" }, expect.anything());
  });

  it("/ptd stop with nothing sends no arguments", async () => {
    await run("stop");
    expect(runAction).toHaveBeenCalledWith("time_entry.stop", {}, expect.anything());
  });

  it("/ptd stop refuses a non-numeric metric", async () => {
    const reply = await run("stop tokens=lots");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply)).toContain("tokens=lots");
  });

  it("/ptd log 1h30m ends now and starts 90 minutes earlier", async () => {
    await run("log 1h30m PTD-12 pairing on the adapter");
    const [name, args] = runAction.mock.calls[0];
    expect(name).toBe("time_entry.log_past");
    expect(args).toMatchObject({ taskId: 42, notes: "pairing on the adapter" });
    expect(args.checkOut).toBe(new Date(NOW).toISOString());
    expect(Date.parse(args.checkOut) - Date.parse(args.checkIn)).toBe(90 * 60_000);
  });

  it("/ptd log 45m works and /ptd log 30h does not", async () => {
    await run("log 45m PTD-12");
    const [, args] = runAction.mock.calls[0];
    expect(Date.parse(args.checkOut) - Date.parse(args.checkIn)).toBe(45 * 60_000);

    runAction.mockClear();
    const reply = await run("log 30h PTD-12");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply)).toContain("longer than a day");
  });

  it("/ptd log without a duration explains the format", async () => {
    const reply = await run("log PTD-12");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply)).toContain("45m");
  });

  it("/ptd today and /ptd who take no arguments", async () => {
    await run("today");
    await run("who");
    expect(runAction.mock.calls.map((c) => c[0])).toEqual(["today_summary", "whoami"]);
    expect(runAction.mock.calls.every((c) => Object.keys(c[1] as object).length === 0)).toBe(true);
  });

  it("/ptd tasks passes a status through and rejects a made-up one", async () => {
    await run("tasks in-progress");
    expect(runAction).toHaveBeenCalledWith("task.list", { status: "in-progress" }, expect.anything());

    runAction.mockClear();
    await run("tasks completed");
    expect(runAction).toHaveBeenCalledWith("task.list", { status: "completed", includeCompleted: true }, expect.anything());

    runAction.mockClear();
    const reply = await run("tasks nearly-done");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply)).toContain("backlog");
  });

  it("/ptd plan needs a manager, a key and an ISO date", async () => {
    await run("plan PTD-12 2026-10-01 3", "manager");
    expect(runAction).toHaveBeenCalledWith("task.schedule", { taskId: 42, startDate: "2026-10-01", estimatedDuration: 3 }, expect.anything());

    runAction.mockClear();
    await run("plan PTD-12 2026-10-01", "manager");
    expect(runAction).toHaveBeenCalledWith("task.schedule", { taskId: 42, startDate: "2026-10-01" }, expect.anything());

    runAction.mockClear();
    const reply = await run("plan PTD-12 next-week", "manager");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply)).toContain("YYYY-MM-DD");
  });

  it("/ptd done completes a task and carries an optional note", async () => {
    await run("done PTD-12 shipped in 4.40");
    expect(runAction).toHaveBeenCalledWith("task.complete", { taskId: 42, note: "shipped in 4.40" }, expect.anything());
  });

  it("accepts the words people actually type", async () => {
    await run("list");
    await run("begin PTD-12");
    await run("finish PTD-12");
    await run("day");
    expect(runAction.mock.calls.map((c) => c[0])).toEqual(["task.list", "time_entry.start", "task.complete", "today_summary"]);
  });

  it("says so when it does not know a subcommand", async () => {
    const reply = await run("frobnicate");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply)).toContain("/ptd frobnicate");
    expect(contextOf(reply)).toContain("/ptd help");
  });
});

describe("the role gate", () => {
  it("refuses /ptd stats for a member before it reaches the registry", async () => {
    const reply = await run("stats");
    expect(runAction).not.toHaveBeenCalled();
    expect(body(reply)).toBe("Your role (member) can't do that — ask a manager.");
    expect(contextOf(reply)).toContain("manager");
  });

  it("refuses /ptd plan for a member and allows it for a manager", async () => {
    await run("plan PTD-12 2026-10-01");
    expect(runAction).not.toHaveBeenCalled();
    await run("plan PTD-12 2026-10-01", "manager");
    expect(runAction).toHaveBeenCalledWith("task.schedule", expect.objectContaining({ startDate: "2026-10-01" }), expect.anything());
  });

  it("allows /ptd stats for a manager", async () => {
    await run("stats", "manager");
    expect(runAction).toHaveBeenCalledWith("stats", {}, expect.anything());
  });

  it("translates a registry ActionError(forbidden) into the same sentence", async () => {
    runAction = vi.fn(async () => {
      throw new ActionError("forbidden", "Members may only complete tasks assigned to themselves");
    });
    const reply = await run("done PTD-12");
    expect(body(reply)).toBe("Your role (member) can't do that — ask a manager.");
    expect(contextOf(reply)).toContain("assigned to themselves");
  });

  it("passes not_found, invalid and conflict through with their own wording", async () => {
    runAction = vi.fn(async () => {
      throw new ActionError("conflict", "A session has been running since 09:00");
    });
    expect(body(await run("start PTD-12"))).toContain("running since 09:00");

    runAction = vi.fn(async () => {
      throw new ActionError("not_found", "Nothing is running");
    });
    expect(body(await run("stop"))).toContain("Nothing is running");
  });

  it("does not leak an unexpected error to Slack", async () => {
    runAction = vi.fn(async () => {
      throw new Error("db exploded");
    });
    const reply = await run("today");
    expect(body(reply)).not.toContain("db exploded");
    expect(body(reply)).toContain("Something went wrong");
  });
});

describe("/ptd help", () => {
  it("lists only what the caller's role allows", async () => {
    const asMember = body(await run("help"));
    expect(asMember).toContain("/ptd next");
    expect(asMember).toContain("/ptd start");
    expect(asMember).not.toContain("/ptd stats");
    expect(asMember).not.toContain("/ptd plan");
    expect(contextOf(await run("help"))).toContain("higher role");

    const asManager = body(await run("help", "manager"));
    expect(asManager).toContain("/ptd stats");
    expect(asManager).toContain("/ptd plan");
  });

  it("answers a bare /ptd and a /ptd ? with the same help", async () => {
    expect(body(await run(""))).toContain("PTD commands");
    expect(body(await run("?"))).toContain("PTD commands");
  });

  it("mentions unlink to a linked caller", async () => {
    expect(body(await run("help"))).toContain("/ptd unlink");
  });
});

describe("rendering", () => {
  it("shows the task key, the score and how to start it", async () => {
    runAction = vi.fn(async () => ({
      task: { id: 42, title: "Ship the Slack adapter", externalKey: "PTD-12", status: "triaged", priorityScore: 63, streamName: "Adapters", dueDate: "2026-09-25T00:00:00.000Z" },
      why: { formula: "urgency 7 × impact 9 ÷ effort 1 = 63", band: "high" },
    }));
    const reply = await run("next");
    expect(reply.response_type).toBe("ephemeral");
    expect(body(reply)).toContain("`PTD-12` Ship the Slack adapter");
    expect(body(reply)).toContain("score *63*");
    expect(body(reply)).toContain("urgency 7");
    expect(contextOf(reply)).toContain("/ptd start PTD-12");
    expect(reply.text).not.toContain("*");
  });

  it("formats a stop as minutes with the ignored agent metrics explained", async () => {
    runAction = vi.fn(async () => ({
      entry: { taskTitle: "Ship the Slack adapter", checkIn: "2026-09-19T10:00:00.000Z", checkOut: "2026-09-19T11:30:00.000Z" },
      minutes: 90,
      ignored: ["tokensUsed", "apiCostUsd"],
      ignoredReason: "this entry is human work",
    }));
    const reply = await run("stop tokens=10");
    expect(body(reply)).toContain("1h 30m logged");
    expect(contextOf(reply)).toContain("tokensUsed, apiCostUsd ignored");
  });

  it("escapes content that would otherwise be read as Slack markup", async () => {
    resolveTask = vi.fn(async () => ({ id: 1, title: "<script> & friends", externalKey: null }));
    runAction = vi.fn(async () => ({ task: { id: 1, title: "<script> & friends", externalKey: null }, changed: true }));
    const reply = await run("done 1");
    expect(body(reply)).toContain("&lt;script&gt; &amp; friends");
  });

  it("renders a Date the registry returned in-process, not a dash", async () => {
    runAction = vi.fn(async () => ({
      entry: { taskTitle: "Ship the Slack adapter", checkIn: new Date("2026-09-19T10:00:00.000Z"), checkOut: null },
    }));
    const started = body(await run("start PTD-12"));
    expect(started).toContain("<!date^1789812000^");
    expect(started).not.toContain("since —");

    runAction = vi.fn(async () => ({
      entry: { taskTitle: "Ship it", checkIn: new Date("2026-09-19T10:00:00.000Z"), checkOut: new Date("2026-09-19T11:30:00.000Z") },
      minutes: 90,
      ignored: [],
    }));
    expect(body(await run("stop"))).toMatch(/<!date\^\d+\^.*→.*<!date\^\d+\^/);
  });

  it("never calls an assigned task unassigned just because the payload has no name", async () => {
    runAction = vi.fn(async () => ({
      count: 3,
      tasks: [
        { id: 1, title: "With a name", externalKey: "A-1", status: "triaged", priorityScore: 10, assignedTo: 4, assigneeName: "Priya Indigo" },
        { id: 2, title: "Id only", externalKey: "A-2", status: "triaged", priorityScore: 9, assignedTo: 4 },
        { id: 3, title: "Nobody", externalKey: "A-3", status: "backlog", priorityScore: 8, assignedTo: null },
      ],
    }));
    const reply = body(await run("tasks"));
    expect(reply).toContain("Priya Indigo");
    expect(reply).toContain("assigned to #4");
    expect(reply).toContain("unassigned");
    expect(reply.match(/unassigned/g)).toHaveLength(1);
  });

  it("says something useful when there is nothing to do", async () => {
    runAction = vi.fn(async () => ({ task: null, why: null }));
    expect(body(await run("next"))).toContain("Nothing claimable");
  });
});

describe("linking", () => {
  it("binds the Slack user to the PTD user the code was minted for", async () => {
    const linkIdentity = vi.fn(async () => undefined);
    const { code } = await mintLinkCode({ userId: 7, orgId: 3, displayName: "Dani" });
    const reply = await handleLink({ payload: payloadFor(`link ${code}`), orgId: 3, orgName: "Acme", code }, { linkIdentity });
    expect(linkIdentity).toHaveBeenCalledWith(7, "T1", "U1");
    expect(body(reply)).toContain("Linked.");
    expect(body(reply)).toContain("Dani");
  });

  it("spends the code, so a replay fails", async () => {
    const linkIdentity = vi.fn(async () => undefined);
    const { code } = await mintLinkCode({ userId: 7, orgId: 3, displayName: "Dani" });
    await handleLink({ payload: payloadFor(`link ${code}`), orgId: 3, orgName: "Acme", code }, { linkIdentity });
    const again = await handleLink({ payload: payloadFor(`link ${code}`), orgId: 3, orgName: "Acme", code }, { linkIdentity });
    expect(linkIdentity).toHaveBeenCalledTimes(1);
    expect(body(again)).toContain("not valid");
  });

  it("refuses a code minted in a different organization", async () => {
    const linkIdentity = vi.fn(async () => undefined);
    const { code } = await mintLinkCode({ userId: 7, orgId: 99, displayName: "Dani" });
    const reply = await handleLink({ payload: payloadFor(`link ${code}`), orgId: 3, orgName: "Acme", code }, { linkIdentity });
    expect(linkIdentity).not.toHaveBeenCalled();
    expect(body(reply)).toContain("different PTD organization");
  });

  it("asks for the code when none was typed", async () => {
    const reply = await handleLink({ payload: payloadFor("link"), orgId: 3, orgName: "Acme", code: undefined });
    expect(body(reply)).toContain("/ptd link ABC123");
  });

  it("stops guessing after too many bad codes", async () => {
    const linkIdentity = vi.fn(async () => undefined);
    for (let i = 0; i < 11; i++) {
      await handleLink({ payload: payloadFor("link ZZZZZZ"), orgId: 3, orgName: "Acme", code: "ZZZZZZ" }, { linkIdentity });
    }
    const { code } = await mintLinkCode({ userId: 7, orgId: 3, displayName: "Dani" });
    const blocked = await handleLink({ payload: payloadFor(`link ${code}`), orgId: 3, orgName: "Acme", code }, { linkIdentity });
    expect(body(blocked)).toContain("Too many bad codes");
    expect(linkIdentity).not.toHaveBeenCalled();
  });

  it("unlinks, and says so when there was nothing to unlink", async () => {
    const unlinkIdentity = vi.fn(async () => 1);
    expect(body(await handleUnlink({ payload: payloadFor("unlink") }, { unlinkIdentity }))).toContain("Unlinked.");
    const none = vi.fn(async () => 0);
    expect(body(await handleUnlink({ payload: payloadFor("unlink") }, { unlinkIdentity: none }))).toContain("not linked");
  });

  it("tells an already-linked caller how to change accounts", async () => {
    expect(body(await run("link ABC123"))).toContain("already linked");
  });
});
