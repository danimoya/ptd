import { beforeEach, describe, expect, it, vi } from "vitest";

// The actions talk to drizzle; the fake answers those chains from canned rows.
vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import { db } from "../../db";
import { customers, streams, tasks, timeEntries } from "../../db/schema";
import { ActionError, runAction, type ActionContext } from "../../server/actions/registry";
import "../../server/actions/track";
import type { FakeDb } from "./fake-db";

const fake = db as unknown as FakeDb;

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  userId: 2,
  email: "dana@track.test",
  displayName: "Dana Boss",
  orgId: 5,
  role: "owner",
  authType: "human",
  via: "web",
  ...over,
});

const agentCtx = (over: Partial<ActionContext> = {}) =>
  ctx({ userId: 3, displayName: "Claude Worker", role: "member", authType: "agent", via: "mcp", ...over });

const openRow = (over: Record<string, any> = {}) => ({
  id: 41,
  userId: 2,
  orgId: 5,
  taskId: 2,
  streamId: 9,
  customerId: null,
  checkIn: new Date(Date.now() - 45 * 60_000),
  checkOut: null,
  isBreak: false,
  notes: "morning block",
  entrySource: "human",
  agentLabel: null,
  tokensUsed: null,
  apiCostUsd: null,
  ...over,
});

/** openEntryFor → (task → stream) → insert → viewEntry */
function queueStart({ open = [] as any[], task = { id: 2, streamId: 9 }, stream = { id: 9, customerId: null } } = {}) {
  fake.queue(timeEntries, open);
  fake.queue(tasks, [task]);
  fake.queue(streams, [stream]);
  fake.queue(timeEntries, [openRow({ id: 77 })]); // what viewEntry reads back
}

const inserted = () => fake.inserts.at(-1)!.values;
const updated = () => fake.updates.at(-1)!.values;

async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (e: unknown) => e as ActionError
  );
}

beforeEach(() => fake.reset());

describe("time_entry.start — attribution comes from the credential", () => {
  it("writes entry_source 'human' for a session session and ignores a spoofed body", async () => {
    queueStart();
    await runAction(
      "time_entry.start",
      { taskId: 2, notes: "writing the ledger", entrySource: "agent", agentLabel: "Fake Bot", tokensUsed: 9999, apiCostUsd: 12 },
      ctx()
    );
    const values = inserted();
    expect(values.entrySource).toBe("human");
    expect(values.agentLabel).toBeNull();
    expect(values).not.toHaveProperty("tokensUsed");
    expect(values).not.toHaveProperty("apiCostUsd");
    expect(values.userId).toBe(2);
    expect(values.orgId).toBe(5);
  });

  it("writes entry_source 'agent' and the agent's name when a ptd_ token calls", async () => {
    queueStart();
    await runAction("time_entry.start", { taskId: 2 }, agentCtx());
    expect(inserted().entrySource).toBe("agent");
    expect(inserted().agentLabel).toBe("Claude Worker");
  });

  it("adopts the task's stream when none is named", async () => {
    queueStart({ task: { id: 2, streamId: 9 } });
    await runAction("time_entry.start", { taskId: 2 }, ctx());
    expect(inserted().streamId).toBe(9);
  });

  it("refuses a task from another organization", async () => {
    fake.queue(timeEntries, []);
    fake.queue(tasks, []);
    const err = await failure(runAction("time_entry.start", { taskId: 404 }, ctx()));
    expect(err).toBeInstanceOf(ActionError);
    expect(err!.code).toBe("not_found");
  });

  it("refuses a second work session while one is running", async () => {
    fake.queue(timeEntries, [openRow()]);
    const err = await failure(runAction("time_entry.start", {}, ctx()));
    expect(err!.code).toBe("conflict");
    expect(err!.message).toMatch(/time_entry.stop/);
    expect(fake.inserts).toHaveLength(0);
  });

  it("cuts the running session when the new entry is a break", async () => {
    fake.queue(timeEntries, [openRow()]);
    fake.queue(timeEntries, [openRow({ checkOut: new Date() })]); // the cut's returning row
    fake.queue(timeEntries, [openRow({ id: 78, isBreak: true })]); // viewEntry
    const res = (await runAction("time_entry.start", { isBreak: true, notes: "Lunch" }, ctx())) as any;
    expect(updated().checkOut).toBeInstanceOf(Date);
    expect(inserted().isBreak).toBe(true);
    expect(res.cut).toMatchObject({ id: 41 });
  });
});

describe("time_entry.stop — tokens and cost are agent-only", () => {
  it("drops them on a human entry and names what it dropped", async () => {
    fake.queue(timeEntries, [openRow({ entrySource: "human" })]);
    fake.queue(timeEntries, [openRow({ checkOut: new Date() })]);
    fake.queue(timeEntries, [openRow({ checkOut: new Date() })]);
    const res = (await runAction("time_entry.stop", { tokensUsed: 1200, apiCostUsd: 0.04 }, ctx())) as any;
    expect(updated()).not.toHaveProperty("tokensUsed");
    expect(updated()).not.toHaveProperty("apiCostUsd");
    expect(updated().checkOut).toBeInstanceOf(Date);
    expect(res.ignored).toEqual(["tokensUsed", "apiCostUsd"]);
    expect(res.ignoredReason).toMatch(/agent/);
  });

  it("persists them on an agent entry", async () => {
    fake.queue(timeEntries, [openRow({ userId: 3, entrySource: "agent", agentLabel: "Claude Worker" })]);
    fake.queue(timeEntries, [openRow({ userId: 3, checkOut: new Date() })]);
    fake.queue(timeEntries, [openRow({ userId: 3, checkOut: new Date() })]);
    const res = (await runAction("time_entry.stop", { tokensUsed: 1200, apiCostUsd: 0.04 }, agentCtx())) as any;
    expect(updated().tokensUsed).toBe(1200);
    expect(updated().apiCostUsd).toBe(0.04);
    expect(res.ignored).toEqual([]);
  });

  it("judges by the entry's own source, so an agent entry stopped from the web keeps agent metrics", async () => {
    fake.queue(timeEntries, [openRow({ entrySource: "agent", agentLabel: "Claude Worker" })]);
    fake.queue(timeEntries, [openRow({ checkOut: new Date() })]);
    fake.queue(timeEntries, [openRow({ checkOut: new Date() })]);
    await runAction("time_entry.stop", { tokensUsed: 50 }, ctx());
    expect(updated().tokensUsed).toBe(50);
  });

  it("reports when nothing is running", async () => {
    fake.queue(timeEntries, []);
    const err = await failure(runAction("time_entry.stop", {}, ctx()));
    expect(err!.code).toBe("not_found");
  });

  it("refuses to close a timer left running for more than a day", async () => {
    fake.queue(timeEntries, [openRow({ checkIn: new Date(Date.now() - 30 * 60 * 60_000) })]);
    const err = await failure(runAction("time_entry.stop", {}, ctx()));
    expect(err!.code).toBe("conflict");
    expect(fake.updates).toHaveLength(0);
  });
});

describe("time_entry.log_past", () => {
  it("rejects a backwards window", async () => {
    const err = await failure(
      runAction("time_entry.log_past", { checkIn: "2026-09-19T12:00:00Z", checkOut: "2026-09-19T11:00:00Z" }, ctx())
    );
    expect(err!.code).toBe("invalid");
  });

  it("rejects a session longer than a day", async () => {
    const err = await failure(
      runAction("time_entry.log_past", { checkIn: "2026-09-17T00:00:00Z", checkOut: "2026-09-18T01:00:00Z" }, ctx())
    );
    expect(err!.code).toBe("invalid");
  });

  it("stores an agent's tokens and cost on a retroactive entry", async () => {
    fake.queue(timeEntries, [openRow({ id: 90 })]);
    const res = (await runAction(
      "time_entry.log_past",
      { checkIn: "2026-09-19T11:00:00Z", checkOut: "2026-09-19T11:45:00Z", tokensUsed: 18400, apiCostUsd: 0.33 },
      agentCtx()
    )) as any;
    expect(inserted()).toMatchObject({ entrySource: "agent", agentLabel: "Claude Worker", tokensUsed: 18400, apiCostUsd: 0.33 });
    expect(res.minutes).toBe(45);
  });
});

describe("time_entry.update — attribution is immutable", () => {
  it("never writes entry_source, agentLabel, tokens or cost", async () => {
    fake.queue(timeEntries, [openRow({ userId: 3, entrySource: "agent", agentLabel: "Claude Worker", tokensUsed: 18400 })]);
    fake.queue(tasks, [{ id: 2, streamId: 9 }]);
    fake.queue(streams, [{ id: 9, customerId: null }]);
    fake.queue(timeEntries, [openRow({ id: 41 })]);
    fake.queue(timeEntries, [openRow({ id: 41 })]);
    await runAction(
      "time_entry.update",
      { entryId: 41, notes: "reviewed", entrySource: "human", tokensUsed: 0, apiCostUsd: 0 },
      ctx({ role: "manager" })
    );
    expect(Object.keys(updated())).not.toContain("entrySource");
    expect(Object.keys(updated())).not.toContain("agentLabel");
    expect(Object.keys(updated())).not.toContain("tokensUsed");
    expect(Object.keys(updated())).not.toContain("apiCostUsd");
    expect(updated().notes).toBe("reviewed");
  });

  it("stops a member from editing someone else's line", async () => {
    fake.queue(timeEntries, [openRow({ userId: 99 })]);
    const err = await failure(runAction("time_entry.update", { entryId: 41, notes: "hijack" }, ctx({ role: "member" })));
    expect(err!.code).toBe("forbidden");
  });

  it("lets a manager edit it", async () => {
    fake.queue(timeEntries, [openRow({ userId: 99 })]);
    // The refs on the row are re-validated against this org on every edit.
    fake.queue(tasks, [{ id: 2, streamId: 9 }]);
    fake.queue(streams, [{ id: 9, customerId: null }]);
    fake.queue(timeEntries, [openRow({ userId: 99 })]);
    fake.queue(timeEntries, [openRow({ userId: 99 })]);
    await runAction("time_entry.update", { entryId: 41, notes: "corrected" }, ctx({ role: "manager" }));
    expect(updated().notes).toBe("corrected");
  });
});

describe("time_entry.delete", () => {
  it("stops a member striking another member's line", async () => {
    fake.queue(timeEntries, [openRow({ userId: 99 })]);
    const err = await failure(runAction("time_entry.delete", { entryId: 41 }, ctx({ role: "member" })));
    expect(err!.code).toBe("forbidden");
    expect(fake.deletes).toHaveLength(0);
  });

  it("lets a member strike their own", async () => {
    fake.queue(timeEntries, [openRow({ userId: 2, checkOut: new Date() })]);
    const res = (await runAction("time_entry.delete", { entryId: 41 }, ctx({ role: "member" }))) as any;
    expect(res.deleted).toBe(true);
    expect(fake.deletes).toHaveLength(1);
  });
});

describe("time_entry.list", () => {
  it("refuses another member's ledger below manager", async () => {
    const err = await failure(runAction("time_entry.list", { userId: 99 }, ctx({ role: "member" })));
    expect(err!.code).toBe("forbidden");
  });

  it("refuses the whole-org read below manager", async () => {
    const err = await failure(runAction("time_entry.list", { userId: "all" }, ctx({ role: "member" })));
    expect(err!.code).toBe("forbidden");
  });

  it("lets a manager read the whole organization", async () => {
    fake.queue(timeEntries, [openRow(), openRow({ id: 42, userId: 3, entrySource: "agent" })]);
    const rows = (await runAction("time_entry.list", { userId: "all" }, ctx({ role: "manager" }))) as any[];
    expect(rows).toHaveLength(2);
  });
});

describe("task.totals — the contract the Plan surface reads", () => {
  it("returns an array of { taskId, minutes, bySource } split by source", async () => {
    fake.queue(timeEntries, [
      { key: 2, entrySource: "human", seconds: "5400", tokens: "0", cost: "0" },
      { key: 2, entrySource: "agent", seconds: "2700", tokens: "18400", cost: "0.33" },
    ]);
    const rows = (await runAction("task.totals", { taskId: 2 }, ctx())) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      taskId: 2,
      minutes: 135,
      bySource: { human: { minutes: 90 }, agent: { minutes: 45, tokens: 18400, costUsd: 0.33 } },
    });
  });

  it("returns a zeroed row rather than an empty array for a task with no time", async () => {
    fake.queue(timeEntries, []);
    const rows = (await runAction("task.totals", { taskId: 7 }, ctx())) as any[];
    expect(rows).toEqual([{ taskId: 7, minutes: 0, bySource: { human: { minutes: 0 }, agent: { minutes: 0, tokens: 0, costUsd: 0 } } }]);
  });

  it("sorts a stream's tasks by time spent", async () => {
    fake.queue(timeEntries, [
      { key: 2, entrySource: "human", seconds: "600" },
      { key: 3, entrySource: "agent", seconds: "3600", tokens: "10", cost: "0.1" },
    ]);
    const rows = (await runAction("task.totals", { streamId: 9 }, ctx())) as any[];
    expect(rows.map((r) => r.taskId)).toEqual([3, 2]);
  });
});

describe("stream.totals", () => {
  it("flags a stream whose agent spend passed its budget", async () => {
    fake.queue(timeEntries, [{ key: 9, entrySource: "agent", seconds: "2700", tokens: "19600", cost: "0.37" }]);
    fake.queue(streams, [{ id: 9, name: "Ledger rewrite", color: "#B8451A", archived: false, agentBudgetUsd: 0.02, position: 0 }]);
    const rows = (await runAction("stream.totals", {}, ctx())) as any[];
    expect(rows[0]).toMatchObject({ streamId: 9, minutes: 45, overBudget: true });
    expect(rows[0].bySource.agent).toEqual({ minutes: 45, tokens: 19600, costUsd: 0.37 });
  });

  it("leaves a stream without a budget alone", async () => {
    fake.queue(timeEntries, [{ key: 9, entrySource: "agent", seconds: "60", tokens: "1", cost: "9999" }]);
    fake.queue(streams, [{ id: 9, name: "Open-ended", color: null, archived: false, agentBudgetUsd: null, position: 0 }]);
    const rows = (await runAction("stream.totals", {}, ctx())) as any[];
    expect(rows[0].overBudget).toBe(false);
  });
});

describe("role gates", () => {
  it("keeps customer.create to manager and above", async () => {
    const err = await failure(runAction("customer.create", { name: "Acme" }, ctx({ role: "member" })));
    expect(err!.code).toBe("forbidden");
    expect(fake.inserts).toHaveLength(0);
  });

  it("lets a manager create one", async () => {
    fake.queue(customers, [{ id: 1, name: "Acme" }]);
    const row = (await runAction("customer.create", { name: "Acme" }, ctx({ role: "manager" }))) as any;
    expect(row.name).toBe("Acme");
    expect(fake.inserts.at(-1)!.values.orgId).toBe(5);
  });

  it("lets every member read customers", async () => {
    fake.queue(customers, [{ id: 1, name: "Acme" }]);
    const rows = (await runAction("customer.list", {}, ctx({ role: "member" }))) as any[];
    expect(rows).toHaveLength(1);
  });
});

describe("templates", () => {
  it("scopes a new template to the caller", async () => {
    fake.queue(streams, [{ id: 9, customerId: 4 }]);
    fake.queue(customers, [{ id: 4 }]); // the derived customer is checked too
    await runAction("template.create", { name: "Standup", icon: "call", streamId: 9 }, ctx());
    expect(fake.inserts.at(-1)!.values).toMatchObject({ userId: 2, orgId: 5, streamId: 9, customerId: 4, isBreak: false });
  });

  it("rejects an icon that is not a slug", async () => {
    const err = await failure(runAction("template.create", { name: "X", icon: "../../etc/passwd" }, ctx()));
    expect(err!.code).toBe("invalid");
  });

  it("will not delete someone else's template", async () => {
    fake.queue(timeEntries, []);
    const err = await failure(runAction("template.delete", { templateId: 3 }, ctx()));
    expect(err!.code).toBe("not_found");
  });
});

describe("time_entry.switch_break", () => {
  it("needs a template or a label", async () => {
    const err = await failure(runAction("time_entry.switch_break", {}, ctx()));
    expect(err!.code).toBe("invalid");
  });

  it("closes what is running and opens the break", async () => {
    fake.queue(timeEntries, [openRow()]);
    fake.queue(timeEntries, [openRow({ checkOut: new Date() })]);
    fake.queue(timeEntries, [openRow({ id: 80, isBreak: true })]);
    const res = (await runAction("time_entry.switch_break", { label: "Coffee break" }, ctx())) as any;
    expect(res.cut).toMatchObject({ id: 41 });
    expect(inserted()).toMatchObject({ isBreak: true, notes: "Coffee break", entrySource: "human" });
  });
});
