import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outbound notifications. The Slack Web API and the database are stubbed; what is
 * asserted is which channel each event goes to, what it says, and that nothing in
 * here can throw into the caller (a task mutation must never fail because Slack is
 * down).
 */

const stubs = vi.hoisted(() => ({
  row: {
    id: 1,
    orgId: 3,
    enabled: true,
    createdBy: 1,
    createdAt: new Date(),
    config: { teamId: "T1", teamName: "Acme", botUserId: "B1", botToken: "sealed", channelId: "C9" } as Record<string, unknown>,
  },
  getSlackForOrg: vi.fn(),
  slackUserIdFor: vi.fn(async () => "U-ASSIGNEE"),
  postMessage: vi.fn(async () => ({ ok: true })),
  runAction: vi.fn(async () => [] as unknown),
}));

vi.mock("../../db", () => ({ db: {} }));

vi.mock("../../server/integrations/slack/store", () => ({
  getSlackForOrg: stubs.getSlackForOrg,
  botTokenOf: () => "xoxb-test",
}));

vi.mock("../../server/integrations/slack/identity", () => ({
  slackUserIdFor: stubs.slackUserIdFor,
}));

vi.mock("../../server/integrations/slack/web", () => ({
  postMessage: stubs.postMessage,
  slackApi: vi.fn(async () => ({ ok: true })),
  postToResponseUrl: vi.fn(async () => ({ ok: true })),
  oauthAccess: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../server/actions/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/actions/registry")>();
  return { ...actual, runAction: stubs.runAction };
});

const { checkStreamBudgets, notifySlack, resetSlackNotifyState, testSlackConnection } = await import("../../server/integrations/slack/notify");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const assignedEvent = (assignedTo: number | null) => ({
  kind: "task.assigned",
  taskId: 42,
  actor: { userId: 1, label: "Dani", isAgent: false },
  payload: {
    task: { id: 42, title: "Ship the Slack adapter", externalKey: "PTD-12", assignedTo, priorityScore: 63, dueDate: "2026-09-25T00:00:00.000Z", streamName: "Adapters" },
    changes: { assignedTo: { old: null, new: assignedTo } },
  },
});

const sent = () => stubs.postMessage.mock.calls.map(([, message]) => message as { channel: string; text: string; blocks?: { text?: { text?: string } }[] });
const textOf = (index = 0) => sent()[index]?.blocks?.[0]?.text?.text ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  resetSlackNotifyState();
  stubs.row.config = { teamId: "T1", teamName: "Acme", botUserId: "B1", botToken: "sealed", channelId: "C9" };
  stubs.getSlackForOrg.mockImplementation(async () => stubs.row);
  stubs.slackUserIdFor.mockImplementation(async () => "U-ASSIGNEE");
  stubs.postMessage.mockImplementation(async () => ({ ok: true }));
  stubs.runAction.mockImplementation(async () => []);
});

afterEach(() => {
  resetSlackNotifyState();
  vi.useRealTimers();
});

describe("task.assigned", () => {
  it("DMs the assignee's Slack account", async () => {
    await notifySlack(3, assignedEvent(9) as never);
    await settle();
    expect(stubs.slackUserIdFor).toHaveBeenCalledWith(9, "T1");
    expect(sent()[0].channel).toBe("U-ASSIGNEE");
    expect(textOf()).toContain("Dani assigned you");
    expect(textOf()).toContain("`PTD-12` Ship the Slack adapter");
  });

  it("stays quiet when the assignee has no Slack identity", async () => {
    stubs.slackUserIdFor.mockResolvedValueOnce(null as never);
    await notifySlack(3, assignedEvent(9) as never);
    await settle();
    expect(stubs.postMessage).not.toHaveBeenCalled();
  });

  it("does not notify someone who assigned the task to themselves, or an unassignment", async () => {
    await notifySlack(3, { ...assignedEvent(1), actor: { userId: 1, label: "Dani", isAgent: false } } as never);
    await notifySlack(3, assignedEvent(null) as never);
    await settle();
    expect(stubs.postMessage).not.toHaveBeenCalled();
  });
});

describe("task.completed", () => {
  it("posts to the org channel with the actor's label", async () => {
    await notifySlack(3, {
      kind: "task.completed",
      taskId: 42,
      actor: { userId: 5, label: "Nightly Triage Bot (agent)", isAgent: true },
      payload: { task: { id: 42, title: "Ship the Slack adapter", externalKey: "PTD-12" }, note: "shipped in 4.40" },
    } as never);
    await settle();
    expect(sent()[0].channel).toBe("C9");
    expect(textOf()).toContain("Nightly Triage Bot (agent) completed");
    expect(textOf()).toContain("`PTD-12`");
  });

  it("posts nothing when no channel has been chosen", async () => {
    stubs.row.config = { ...stubs.row.config, channelId: null };
    await notifySlack(3, { kind: "task.completed", taskId: 42, payload: { task: { id: 42, title: "x", externalKey: null } } } as never);
    await settle();
    expect(stubs.postMessage).not.toHaveBeenCalled();
  });

  it("posts nothing when the org has no install, or the install is disabled", async () => {
    stubs.getSlackForOrg.mockResolvedValueOnce(null as never);
    await notifySlack(3, { kind: "task.completed", taskId: 1, payload: {} } as never);
    stubs.getSlackForOrg.mockResolvedValueOnce({ ...stubs.row, enabled: false } as never);
    await notifySlack(3, { kind: "task.completed", taskId: 1, payload: {} } as never);
    await settle();
    expect(stubs.postMessage).not.toHaveBeenCalled();
  });
});

describe("task.cascade_shifted", () => {
  it("coalesces a burst of shifts into one message", async () => {
    vi.useFakeTimers();
    for (const taskId of [7, 8, 9]) {
      await notifySlack(3, { kind: "task.cascade_shifted", taskId, payload: { rootId: 5 } } as never);
    }
    expect(stubs.postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stubs.postMessage).toHaveBeenCalledTimes(1);
    expect(textOf()).toContain("3 tasks shifted");
    expect(textOf()).toContain("#5");
  });

  it("uses the singular for a single shift", async () => {
    vi.useFakeTimers();
    await notifySlack(3, { kind: "task.cascade_shifted", taskId: 7, payload: { rootId: 5 } } as never);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(textOf()).toContain("1 task shifted");
  });
});

describe("agent-budget alerts", () => {
  const overBudget = [
    { streamId: 4, name: "Agent swarm", agentBudgetUsd: 10, minutes: 300, bySource: { human: { minutes: 0 }, agent: { minutes: 300, tokens: 1_000_000, costUsd: 12.4 } }, overBudget: true },
    { streamId: 5, name: "Within budget", agentBudgetUsd: 50, minutes: 60, bySource: { human: { minutes: 0 }, agent: { minutes: 60, tokens: 10, costUsd: 1 } }, overBudget: false },
  ];

  it("asks stream.totals and posts one alert per over-budget stream", async () => {
    stubs.runAction.mockResolvedValue(overBudget as never);
    const sweep = await checkStreamBudgets(3, { force: true });
    expect(stubs.runAction).toHaveBeenCalledWith("stream.totals", {}, expect.objectContaining({ orgId: 3, role: "admin" }));
    expect(sweep).toMatchObject({ checked: 2, overBudget: 1, posted: 1 });
    expect(textOf()).toContain("Agent budget exceeded");
    expect(textOf()).toContain("Agent swarm");
    expect(sent()[0].blocks?.[1]).toBeDefined();
  });

  it("alerts a stream once, then holds off until the cooldown passes", async () => {
    stubs.runAction.mockResolvedValue(overBudget as never);
    await checkStreamBudgets(3);
    const second = await checkStreamBudgets(3);
    expect(second).toMatchObject({ overBudget: 1, posted: 0 });
    expect(second.skipped.some((s) => s.startsWith("cooldown:"))).toBe(true);
    expect(stubs.postMessage).toHaveBeenCalledTimes(1);

    const later = await checkStreamBudgets(3, { now: Date.now() + 13 * 60 * 60 * 1000 });
    expect(later.posted).toBe(1);
  });

  it("does nothing without an install or a channel", async () => {
    stubs.getSlackForOrg.mockResolvedValueOnce(null as never);
    expect((await checkStreamBudgets(3)).skipped).toEqual(["not_connected"]);
    stubs.row.config = { ...stubs.row.config, channelId: null };
    expect((await checkStreamBudgets(3)).skipped).toEqual(["no_channel_configured"]);
    expect(stubs.postMessage).not.toHaveBeenCalled();
  });

  it("records a failed post instead of counting it", async () => {
    stubs.runAction.mockResolvedValue(overBudget as never);
    stubs.postMessage.mockResolvedValue({ ok: false, error: "not_in_channel" } as never);
    const sweep = await checkStreamBudgets(3, { force: true });
    expect(sweep.posted).toBe(0);
    expect(sweep.skipped.some((s) => s.startsWith("post_failed:"))).toBe(true);
  });
});

describe("resilience", () => {
  it("never throws, whatever the database or Slack does", async () => {
    stubs.getSlackForOrg.mockRejectedValue(new Error("db exploded") as never);
    await expect(notifySlack(3, { kind: "task.completed", taskId: 1, payload: {} } as never)).resolves.toBeUndefined();

    stubs.getSlackForOrg.mockImplementation(async () => stubs.row);
    stubs.postMessage.mockRejectedValue(new Error("slack down") as never);
    await expect(notifySlack(3, assignedEvent(9) as never)).resolves.toBeUndefined();
  });

  it("ignores event kinds it has nothing to say about", async () => {
    await notifySlack(3, { kind: "task.updated", taskId: 1, payload: {} } as never);
    await notifySlack(3, { kind: "stream.created", payload: {} } as never);
    await settle();
    expect(stubs.postMessage).not.toHaveBeenCalled();
  });
});

describe("testSlackConnection", () => {
  it("posts PTD connected into the chosen channel", async () => {
    const result = await testSlackConnection(3, "Dani");
    expect(result).toEqual({ posted: true, channel: "C9", error: null });
    expect(textOf()).toContain("PTD connected");
    expect(sent()[0].blocks?.[1]).toBeDefined();
  });

  it("reports why it could not post", async () => {
    stubs.row.config = { ...stubs.row.config, channelId: null };
    expect(await testSlackConnection(3, "Dani")).toEqual({ posted: false, channel: null, error: "no_channel_configured" });

    stubs.row.config = { ...stubs.row.config, channelId: "C9" };
    stubs.postMessage.mockResolvedValue({ ok: false, error: "not_in_channel" } as never);
    expect(await testSlackConnection(3, "Dani")).toEqual({ posted: false, channel: "C9", error: "not_in_channel" });

    stubs.getSlackForOrg.mockResolvedValueOnce(null as never);
    expect(await testSlackConnection(3, "Dani")).toEqual({ posted: false, channel: null, error: "not_connected" });
  });
});
