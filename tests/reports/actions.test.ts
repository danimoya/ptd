import { beforeEach, describe, expect, it, vi } from "vitest";

// The actions talk to drizzle; the fake answers those chains from canned rows.
vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import { db } from "../../db";
import { invoices } from "../../db/schema";
import { ActionError, getAction, runAction, type ActionContext } from "../../server/actions/registry";
import "../../server/actions/reports";
import type { FakeDb } from "./fake-db";

const fake = db as unknown as FakeDb;

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  userId: 2,
  email: "elena@atelier14.demo",
  displayName: "Elena Draftworks",
  orgId: 5,
  role: "owner",
  authType: "human",
  via: "web",
  ...over,
});

const member = (over: Partial<ActionContext> = {}) => ctx({ userId: 9, displayName: "Priya Indigo", role: "member", ...over });

const WINDOW = { from: "2026-09-14", to: "2026-09-20" };

const entry = (over: Record<string, unknown> = {}) => ({
  id: 1,
  userId: 2,
  userName: "Elena Draftworks",
  streamId: 1,
  streamName: "Security audit",
  streamColor: "#B8451A",
  streamCustomerId: 1,
  taskId: 10,
  taskTitle: "Threat model the checkout flow",
  customerId: null,
  checkIn: new Date(2026, 8, 14, 9, 0),
  checkOut: new Date(2026, 8, 14, 11, 0),
  isBreak: false,
  notes: null,
  entrySource: "human",
  tokensUsed: null,
  apiCostUsd: null,
  ...over,
});

beforeEach(() => fake.reset());

describe("registration", () => {
  const expected = [
    ["report.range", "member"],
    ["report.compare", "member"],
    ["report.search", "member"],
    ["insights.patterns", "member"],
    ["insights.summary", "member"],
    ["customer.goals", "manager"],
    ["invoice.preview", "manager"],
    ["invoice.generate", "manager"],
    ["invoice.list", "manager"],
  ] as const;

  it.each(expected)("registers %s on the track surface at role %s", (name, role) => {
    const action = getAction(name);
    expect(action).toBeDefined();
    expect(action!.requiredRole).toBe(role);
    expect(action!.surface).toBe("track");
  });

  it("describes every action, so MCP callers get more than a name", () => {
    for (const [name] of expected) {
      expect(getAction(name)!.description.length).toBeGreaterThan(60);
      expect(getAction(name)!.title).toBeTruthy();
    }
  });
});

describe("report.range", () => {
  it("reads the caller's own ledger and folds it", async () => {
    fake.queue([entry(), entry({ id: 2, entrySource: "agent", tokensUsed: 5000, apiCostUsd: 0.5, checkOut: new Date(2026, 8, 14, 9, 30) })]);
    const r: any = await runAction("report.range", { ...WINDOW, groupBy: "day" }, ctx());
    expect(r.human.minutes).toBe(120);
    expect(r.agent).toEqual({ minutes: 30, tokens: 5000, costUsd: 0.5 });
    expect(r.buckets).toHaveLength(7);
    expect(r.groupBy).toBe("day");
  });

  it("defaults to day buckets when the caller does not say", async () => {
    fake.queue([]);
    const r: any = await runAction("report.range", WINDOW, ctx());
    expect(r.groupBy).toBe("day");
  });

  it("refuses another member's ledger below manager", async () => {
    await expect(runAction("report.range", { ...WINDOW, groupBy: "day", userId: 2 }, member())).rejects.toThrow(ActionError);
    expect(fake.selects).toBe(0);
  });

  it("refuses the whole organization below manager", async () => {
    await expect(runAction("report.range", { ...WINDOW, groupBy: "day", userId: "all" }, member())).rejects.toThrow(/manager or above/);
  });

  it("lets a member ask for their own userId explicitly", async () => {
    fake.queue([]);
    await expect(runAction("report.range", { ...WINDOW, groupBy: "day", userId: 9 }, member())).resolves.toBeDefined();
  });

  it("lets a manager read the whole organization", async () => {
    fake.queue([entry()]);
    const r: any = await runAction("report.range", { ...WINDOW, groupBy: "day", userId: "all" }, ctx({ role: "manager" }));
    expect(r.minutes).toBe(120);
  });

  it("rejects a window that runs backwards", async () => {
    await expect(runAction("report.range", { from: "2026-09-20", to: "2026-09-14", groupBy: "day" }, ctx())).rejects.toThrow(/after/);
  });

  it("rejects an unknown bucket size rather than guessing", async () => {
    await expect(runAction("report.range", { ...WINDOW, groupBy: "fortnight" }, ctx())).rejects.toThrow(ActionError);
  });
});

describe("report.compare", () => {
  it("reads both windows and reports the movement between them", async () => {
    fake.queue([entry()], [entry({ checkOut: new Date(2026, 8, 7, 10, 0), checkIn: new Date(2026, 8, 7, 9, 0) })]);
    const c: any = await runAction(
      "report.compare",
      { current: WINDOW, previous: { from: "2026-09-07", to: "2026-09-13" }, groupBy: "day" },
      ctx()
    );
    expect(c.current.minutes).toBe(120);
    expect(c.previous.minutes).toBe(60);
    expect(c.delta.minutes).toBe(60);
    expect(c.trend.minutes.arrow).toBe("↑");
    expect(c.trend.minutes.better).toBe(true);
  });

  it("applies the same scope gate to both windows", async () => {
    await expect(
      runAction("report.compare", { current: WINDOW, previous: WINDOW, userId: "all" }, member())
    ).rejects.toThrow(/manager or above/);
  });
});

describe("report.search", () => {
  it("requires something to search for", async () => {
    await expect(runAction("report.search", { query: "" }, ctx())).rejects.toThrow(ActionError);
  });

  it("pages from the top by default", async () => {
    fake.queue([], [{ total: "0", seconds: "0" }]);
    const r: any = await runAction("report.search", { query: "csrf" }, ctx());
    expect([r.limit, r.offset, r.total, r.hasMore]).toEqual([25, 0, 0, false]);
  });

  it("caps the page size a caller can ask for", async () => {
    await expect(runAction("report.search", { query: "csrf", limit: 5000 }, ctx())).rejects.toThrow(ActionError);
  });
});

describe("insights", () => {
  it("summarises the caller's own window in three to six sentences", async () => {
    fake.queue([entry()]);
    const s: any = await runAction("insights.summary", {}, ctx());
    expect(s.sentences.length).toBeGreaterThanOrEqual(3);
    expect(s.sentences.length).toBeLessThanOrEqual(6);
    expect(s.facts.minutes).toBe(120);
  });

  it("always includes a sentence about agent cost", async () => {
    fake.queue([entry()]);
    const s: any = await runAction("insights.summary", {}, ctx());
    expect(s.sentences.some((line: string) => line.includes("$"))).toBe(true);
  });

  it("returns the heat matrix the strip needs", async () => {
    fake.queue([entry()]);
    const p: any = await runAction("insights.patterns", {}, ctx());
    expect(p.heat).toHaveLength(7);
    expect(p.heat[0]).toHaveLength(24);
    expect(p.heatAgent).toHaveLength(7);
    expect(p.byHour).toHaveLength(24);
    expect(p.byWeekday).toHaveLength(7);
  });

  it("refuses to read another member's habits below manager", async () => {
    await expect(runAction("insights.patterns", { userId: 2 }, member())).rejects.toThrow(/manager or above/);
  });
});

describe("invoices", () => {
  it("previews a month without writing anything", async () => {
    fake.queue([{ name: "Atelier 14" }], [{ id: 1, name: "Maison Corbeau", billingAddress: null, billingEmail: null }], [entry()]);
    const p: any = await runAction("invoice.preview", { customerId: 1, month: 9, year: 2026 }, ctx());
    expect(p.status).toBe("preview");
    expect(p.invoiceId).toBeNull();
    expect(p.reference).toBe("PTD-2026-09-DRAFT");
    expect(p.totals.minutes).toBe(120);
    expect(fake.inserts).toHaveLength(0);
  });

  it("refuses a customer from another organization", async () => {
    fake.queue([{ name: "Atelier 14" }], []);
    await expect(runAction("invoice.preview", { customerId: 99, month: 9, year: 2026 }, ctx())).rejects.toThrow(/not in this organization/);
  });

  it("records the invoice with the total in minutes and hands back its PDF url", async () => {
    fake.queue([{ name: "Atelier 14" }], [{ id: 1, name: "Maison Corbeau", billingAddress: null, billingEmail: null }], [entry()]);
    const result: any = await runAction("invoice.generate", { customerId: 1, month: 9, year: 2026 }, ctx());
    expect(result.pdfUrl).toBe("/api/track/invoices/77.pdf");
    expect(result.reference).toBe("PTD-2026-09-0077");
    expect(result.status).toBe("generated");

    const written = fake.inserts.find((i) => i.table === invoices)!;
    expect(written.values).toMatchObject({ orgId: 5, customerId: 1, userId: 2, month: 9, year: 2026, status: "generated", totalAmount: 120 });
    // The url is stamped back onto the row once the id is known.
    expect(fake.updates.at(-1)!.values).toMatchObject({ pdfUrl: "/api/track/invoices/77.pdf" });
  });

  it("rejects a month outside 1–12", async () => {
    await expect(runAction("invoice.generate", { customerId: 1, month: 13, year: 2026 }, ctx())).rejects.toThrow(ActionError);
  });

  it("falls back to a derived pdf url for a row that never stored one", async () => {
    fake.queue([{ id: 4, customerId: 1, customerName: "Maison Corbeau", userId: 2, issuedBy: "Elena", month: 9, year: 2026, status: "generated", totalMinutes: null, pdfUrl: null, createdAt: new Date() }]);
    const rows: any = await runAction("invoice.list", {}, ctx());
    expect(rows[0].pdfUrl).toBe("/api/track/invoices/4.pdf");
    expect(rows[0].totalMinutes).toBe(0);
    expect(rows[0].periodLabel).toBe("September 2026");
  });

  it("is closed to members", async () => {
    for (const name of ["customer.goals", "invoice.preview", "invoice.generate", "invoice.list"]) {
      await expect(runAction(name, { customerId: 1, month: 9, year: 2026 }, member())).rejects.toThrow(/requires role manager/);
    }
  });
});
