import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";

vi.mock("../../db", () => ({ db: fakeDb }));

// The AI actions read through the Plan surface's own `task.get` / `task.list`, so
// both modules have to be registered for the end-to-end path to run.
await import("../../server/actions/plan");
await import("../../server/actions/ai");
const { ActionError, getAction, runAction } = await import("../../server/actions/registry");
const { resetUsage } = await import("../../server/ai/usage");
import { aiStub, DEFAULT_SUGGESTION } from "./stub";

const ORG_ID = 4;
const ctx = (role: "owner" | "admin" | "manager" | "member" = "manager") => ({
  userId: 1,
  email: "elena@atelier14.demo",
  displayName: "Elena",
  orgId: ORG_ID,
  role,
  authType: "human" as const,
  via: "web" as const,
});

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function taskRow(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    orgId: ORG_ID,
    title: `Card ${id}`,
    description: "<p>Something to do</p>",
    status: "backlog",
    streamId: 2,
    appId: null,
    assignedTo: null,
    startDate: null,
    dueDate: day("2026-09-25"),
    estimatedDuration: 120,
    dependencies: [],
    externalKey: null,
    urgency: 5,
    impact: 5,
    effort: 5,
    priorityScore: 5,
    prioritySource: "formula",
    priorityNote: null,
    tags: ["ops"],
    completed: false,
    createdBy: 1,
    createdAt: day("2026-09-01"),
    updatedAt: day("2026-09-01"),
    ...over,
  };
}

const REAL_ENV = { ...process.env };
let stub: ReturnType<typeof aiStub>;

function configure(provider = "anthropic", model?: string) {
  process.env.PTD_AI_PROVIDER = provider;
  process.env.PTD_AI_API_KEY = "sk-stub-key";
  process.env.PTD_AI_BASE_URL = "https://provider.test";
  if (model) process.env.PTD_AI_MODEL = model;
}

function unconfigure() {
  delete process.env.PTD_AI_PROVIDER;
  delete process.env.PTD_AI_API_KEY;
  delete process.env.PTD_AI_BASE_URL;
  delete process.env.PTD_AI_MODEL;
}

beforeEach(() => {
  resetUsage();
  fakeDb.reset().setTasks([taskRow(7)]);
  fakeDb.rows.streams = [{ id: 2, orgId: ORG_ID, name: "Platform hardening", color: null }];
  stub = aiStub();
  vi.stubGlobal("fetch", vi.fn(stub.fetchImpl as never));
  unconfigure();
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  vi.unstubAllGlobals();
  resetUsage();
});

describe("role gates", () => {
  it("puts status at member, the suggestions at manager and usage at admin", () => {
    expect(getAction("ai.status")?.requiredRole).toBe("member");
    expect(getAction("task.suggest_priority")?.requiredRole).toBe("manager");
    expect(getAction("task.suggest_priority_batch")?.requiredRole).toBe("manager");
    expect(getAction("ai.usage")?.requiredRole).toBe("admin");
  });

  it("files them all on the Overview surface, so the docs and MCP manifest group them", () => {
    for (const name of ["ai.status", "task.suggest_priority", "task.suggest_priority_batch", "ai.usage"]) {
      expect(getAction(name)?.surface).toBe("overview");
    }
  });

  it("refuses a member asking for a suggestion and a manager reading usage", async () => {
    configure();
    await expect(runAction("task.suggest_priority", { taskId: 7 }, ctx("member"))).rejects.toThrow(/requires role manager/);
    await expect(runAction("ai.usage", {}, ctx("manager"))).rejects.toThrow(/requires role admin/);
  });

  it("validates its input like every other action", async () => {
    configure();
    await expect(runAction("task.suggest_priority", {}, ctx())).rejects.toThrow(/taskId/);
    await expect(runAction("task.suggest_priority_batch", { limit: 99 }, ctx())).rejects.toThrow(/limit/);
  });
});

describe("unconfigured", () => {
  it("answers ai.status honestly and refuses everything else with one message", async () => {
    // `ai.status` also reports whose key would answer; unconfigured, nobody's.
    expect(await runAction("ai.status", {}, ctx("member"))).toMatchObject({
      configured: false,
      provider: null,
      model: null,
      source: null,
      metered: false,
      orgKey: { connected: false, keyHint: null },
    });

    const expected = /AI provider not configured — set PTD_AI_PROVIDER and PTD_AI_API_KEY/;
    await expect(runAction("task.suggest_priority", { taskId: 7 }, ctx())).rejects.toThrow(expected);
    await expect(runAction("task.suggest_priority_batch", {}, ctx())).rejects.toThrow(expected);
    await expect(runAction("ai.usage", {}, ctx("admin"))).rejects.toThrow(expected);
    await expect(runAction("task.suggest_priority", { taskId: 7 }, ctx())).rejects.toBeInstanceOf(ActionError);
  });

  it("never reaches the network", async () => {
    await runAction("task.suggest_priority", { taskId: 7 }, ctx()).catch(() => undefined);
    expect(stub.calls).toHaveLength(0);
  });

  it("is off with a provider but no key, and with a key but no provider", async () => {
    process.env.PTD_AI_PROVIDER = "anthropic";
    expect(await runAction("ai.status", {}, ctx("member"))).toMatchObject({ configured: false });
    delete process.env.PTD_AI_PROVIDER;
    process.env.PTD_AI_API_KEY = "sk-x";
    expect(await runAction("ai.status", {}, ctx("member"))).toMatchObject({ configured: false });
  });
});

describe("ai.status when configured", () => {
  it("names the provider and the model it would use, and nothing else", async () => {
    configure("anthropic");
    expect(await runAction("ai.status", {}, ctx("member"))).toMatchObject({
      configured: true,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      // The deployment's own key, since this organization has connected none.
      source: "env",
      orgKey: { connected: false },
      deployment: { configured: true, provider: "anthropic", model: "claude-haiku-4-5" },
    });
    // Never the key itself, whatever else it says.
    expect(JSON.stringify(await runAction("ai.status", {}, ctx("member")))).not.toContain("sk-ant");
    configure("openai");
    expect(await runAction("ai.status", {}, ctx("member"))).toMatchObject({ provider: "openai", model: "gpt-4o-mini" });
  });
});

describe("task.suggest_priority", () => {
  it("builds the prompt from the card, asks the provider and writes nothing", async () => {
    configure();
    const res = (await runAction("task.suggest_priority", { taskId: 7 }, ctx())) as Record<string, any>;

    expect(res.suggestion).toMatchObject({ urgency: 8, impact: 7, effort: 3, priorityScore: 19, rationale: DEFAULT_SUGGESTION.rationale });
    expect(res.current.priorityScore).toBe(5);
    expect(res.delta.priorityScore).toBe(14);
    expect(res.applied).toBe(false);
    expect(fakeDb.updates).toHaveLength(0);
    expect(fakeDb.inserts).toHaveLength(0);

    // The prompt carries the card, stripped of its HTML, plus the calibration block.
    const body = stub.last().body as Record<string, any>;
    expect(body.messages[0].content).toContain("title: Card 7");
    expect(body.messages[0].content).toContain("Something to do");
    expect(body.messages[0].content).not.toContain("<p>");
    expect(body.messages[0].content).toContain("stream: Platform hardening");
    expect(body.messages[0].content).toContain("open cards: 1");
  });

  it("writes the three inputs, the derived score and the rationale on apply", async () => {
    configure();
    const res = (await runAction("task.suggest_priority", { taskId: 7, apply: true }, ctx())) as Record<string, any>;

    expect(res.applied).toBe(true);
    expect(fakeDb.task(7)).toMatchObject({
      urgency: 8,
      impact: 7,
      effort: 3,
      priorityScore: 19,
      prioritySource: "ai",
      priorityNote: DEFAULT_SUGGESTION.rationale,
    });
    expect(res.task).toMatchObject({ id: 7, priorityScore: 19, prioritySource: "ai" });
  });

  it("records one priority_changed event naming the person who accepted it", async () => {
    configure();
    await runAction("task.suggest_priority", { taskId: 7, apply: true }, ctx());

    const events = fakeDb.inserts.filter((i) => i.table === "task_events");
    expect(events).toHaveLength(1);
    expect(events[0].values).toMatchObject({
      taskId: 7,
      orgId: ORG_ID,
      kind: "priority_changed",
      note: "AI suggestion applied by Elena",
      actorLabel: "Elena",
      via: "web",
    });
    expect(events[0].values.changes).toMatchObject({
      urgency: { old: 5, new: 8 },
      priorityScore: { old: 5, new: 19 },
      prioritySource: { old: "formula", new: "ai" },
    });
  });

  it("marks an agent's own acceptance as an agent in history", async () => {
    configure();
    await runAction("task.suggest_priority", { taskId: 7, apply: true }, { ...ctx(), authType: "agent", displayName: "Ada", via: "mcp" });
    const event = fakeDb.inserts.find((i) => i.table === "task_events")!;
    expect(event.values).toMatchObject({ actorLabel: "Ada (agent)", via: "mcp", note: "AI suggestion applied by Ada" });
  });

  it("leaves a hand-set score alone, and says why", async () => {
    configure();
    fakeDb.setTasks([taskRow(7, { prioritySource: "manual", priorityScore: 80, priorityNote: "CEO asked" })]);
    const res = (await runAction("task.suggest_priority", { taskId: 7, apply: true }, ctx())) as Record<string, any>;

    expect(res.applied).toBe(false);
    expect(res.skipped).toBe("manual");
    expect(fakeDb.updates).toHaveLength(0);
    expect(fakeDb.task(7)).toMatchObject({ priorityScore: 80, prioritySource: "manual", priorityNote: "CEO asked" });
    // The proposal is still returned, so a manager can see what they are refusing.
    expect(res.suggestion.priorityScore).toBe(19);
  });

  it("overwrites it only with overrideManual", async () => {
    configure();
    fakeDb.setTasks([taskRow(7, { prioritySource: "manual", priorityScore: 80 })]);
    const res = (await runAction("task.suggest_priority", { taskId: 7, apply: true, overrideManual: true }, ctx())) as Record<string, any>;
    expect(res.applied).toBe(true);
    expect(fakeDb.task(7)).toMatchObject({ priorityScore: 19, prioritySource: "ai" });
  });

  it("stays inside the organization", async () => {
    configure();
    fakeDb.setTasks([taskRow(7, { orgId: 99 })]);
    await expect(runAction("task.suggest_priority", { taskId: 7 }, ctx())).rejects.toThrow(/not found in this organization/);
    expect(stub.calls).toHaveLength(0);
  });

  it("turns a provider failure into an invalid-input error carrying the provider's words", async () => {
    configure();
    stub = aiStub({ replies: [{ kind: "error", status: 429, message: "rate limited, retry in 3s" }] });
    vi.stubGlobal("fetch", vi.fn(stub.fetchImpl as never));
    await expect(runAction("task.suggest_priority", { taskId: 7 }, ctx())).rejects.toThrow(/rate limited, retry in 3s/);
    await expect(runAction("task.suggest_priority", { taskId: 7 }, ctx())).rejects.toBeInstanceOf(ActionError);
  });
});

describe("task.suggest_priority_batch", () => {
  beforeEach(() => {
    fakeDb.setTasks([
      taskRow(1, { priorityScore: 90 }),
      taskRow(2, { priorityScore: 70 }),
      taskRow(3, { priorityScore: 50, prioritySource: "manual" }),
      taskRow(4, { priorityScore: 30, completed: true, status: "completed" }),
    ]);
  });

  it("scores the open, non-manual cards and reports what the run cost", async () => {
    configure();
    const res = (await runAction("task.suggest_priority_batch", { limit: 5 }, ctx())) as Record<string, any>;

    expect(res.considered).toBe(2);
    expect(res.scored).toBe(2);
    expect(res.applied).toBe(0);
    expect(res.results.map((r: any) => r.taskId)).toEqual([1, 2]);
    expect(res.skipped).toEqual([{ taskId: 3, title: "Card 3", reason: "manual" }]);
    expect(res.totals).toMatchObject({ calls: 2, inputTokens: 1240, outputTokens: 180 });
    expect(res.totals.costUsd).toBeCloseTo(0.00214, 8);
    expect(fakeDb.updates).toHaveLength(0);
  });

  it("writes them all with apply, and only then", async () => {
    configure();
    const res = (await runAction("task.suggest_priority_batch", { limit: 5, apply: true }, ctx())) as Record<string, any>;
    expect(res.applied).toBe(2);
    expect(fakeDb.task(1)).toMatchObject({ priorityScore: 19, prioritySource: "ai" });
    expect(fakeDb.task(2)).toMatchObject({ priorityScore: 19, prioritySource: "ai" });
    expect(fakeDb.task(3)).toMatchObject({ priorityScore: 50, prioritySource: "manual" });
    expect(fakeDb.task(4)).toMatchObject({ priorityScore: 30 });
  });

  it("includes the hand-scored card once asked", async () => {
    configure();
    const res = (await runAction("task.suggest_priority_batch", { limit: 5, apply: true, overrideManual: true }, ctx())) as Record<string, any>;
    expect(res.considered).toBe(3);
    expect(res.skipped).toEqual([]);
    expect(fakeDb.task(3)).toMatchObject({ prioritySource: "ai" });
  });

  it("honours the stream filter and the limit", async () => {
    configure();
    const capped = (await runAction("task.suggest_priority_batch", { limit: 1 }, ctx())) as Record<string, any>;
    expect(capped.results.map((r: any) => r.taskId)).toEqual([1]);

    const elsewhere = (await runAction("task.suggest_priority_batch", { streamId: 999 }, ctx())) as Record<string, any>;
    expect(elsewhere).toMatchObject({ considered: 0, scored: 0 });
  });
});

describe("ai.usage", () => {
  it("writes one ai_usage row per provider call, billed to the caller's organization", async () => {
    configure();
    await runAction("task.suggest_priority", { taskId: 7 }, ctx());
    await runAction("task.suggest_priority_batch", { limit: 1 }, ctx());
    // The insert is fire-and-forget on the suggestion path; let it land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ledger = fakeDb.inserts.filter((i) => i.table === "ai_usage").map((i) => i.values);
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ orgId: ORG_ID, userId: 1, provider: "anthropic", model: "claude-haiku-4-5", action: "task.suggest_priority" });
    expect(ledger[1]).toMatchObject({ action: "task.suggest_priority_batch" });
    expect(ledger[0].inputTokens).toBeGreaterThan(0);
  });

  it("still reports what this process spent, by model and by action", async () => {
    configure();
    await runAction("task.suggest_priority", { taskId: 7 }, ctx());
    await runAction("task.suggest_priority_batch", { limit: 1 }, ctx());

    const usage = (await runAction("ai.usage", {}, ctx("admin"))) as Record<string, any>;
    expect(usage).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5", days: 30 });
    const mine = usage.thisProcess;
    expect(mine).toMatchObject({ calls: 2, failures: 0, unpriced: 0, windowSize: 500, truncated: false });
    expect(mine.inputTokens).toBe(1240);
    expect(mine.costUsd).toBeCloseTo(0.00214, 8);
    expect(mine.byModel).toEqual([expect.objectContaining({ model: "claude-haiku-4-5", calls: 2 })]);
    expect(mine.byLabel.map((b: any) => b.label).sort()).toEqual(["task.suggest_priority", "task.suggest_priority_batch"]);
  });

  it("starts empty, and never leaks the key", async () => {
    configure();
    const usage = (await runAction("ai.usage", {}, ctx("admin"))) as Record<string, any>;
    expect(usage).toMatchObject({ calls: 0, costUsd: 0, byDay: [], byUser: [], byModel: [] });
    expect(usage.thisProcess).toMatchObject({ calls: 0, firstAt: null, lastAt: null });
    expect(JSON.stringify(usage)).not.toContain("sk-stub-key");
  });
});
