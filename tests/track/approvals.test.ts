import { beforeEach, describe, expect, it, vi } from "vitest";

// The actions talk to drizzle; the fake answers those chains from canned rows.
vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import { db } from "../../db";
import { memberships, timeEntries } from "../../db/schema";
import { ActionError, getAction, runAction, type ActionContext } from "../../server/actions/registry";
import "../../server/actions/track";
import "../../server/actions/invoicing";
import type { FakeDb } from "./fake-db";

const fake = db as unknown as FakeDb;

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  userId: 1,
  email: "elena@atelier14.demo",
  displayName: "Elena Draftworks",
  orgId: 5,
  role: "owner",
  authType: "human",
  via: "web",
  ...over,
});

const managerCtx = (over: Partial<ActionContext> = {}) => ctx({ userId: 2, displayName: "Marcus Vellum", role: "manager", ...over });
const memberCtx = (over: Partial<ActionContext> = {}) => ctx({ userId: 3, displayName: "Priya Indigo", role: "member", ...over });

const profile = (over: Record<string, any> = {}) => ({
  userId: 3,
  displayName: "Priya Indigo",
  email: "priya@atelier14.demo",
  isAgent: false,
  role: "member",
  billable: true,
  hourlyRate: 40,
  currency: "USD",
  billingName: "Indigo Studio Ltd",
  billingAddress: null,
  taxId: "FR90210445",
  requireApproval: true,
  ...over,
});

const entry = (over: Record<string, any> = {}) => ({
  id: 14,
  userId: 3,
  userName: "Priya Indigo",
  orgId: 5,
  checkIn: new Date("2026-09-15T09:00:00Z"),
  checkOut: new Date("2026-09-15T12:20:00Z"),
  approvalStatus: "none",
  lockedInvoiceId: null,
  isBreak: false,
  notes: null,
  entrySource: "human",
  agentLabel: null,
  tokensUsed: null,
  apiCostUsd: null,
  taskId: 11,
  streamId: 3,
  customerId: 1,
  ...over,
});

beforeEach(() => fake.reset());

/* ── Who is external ──────────────────────────────────────────────────── */

describe("member.set_billing", () => {
  it("is admin's alone, because a rate is money", () => {
    expect(getAction("member.set_billing")!.requiredRole).toBe("admin");
    expect(getAction("member.set_billing")!.audited).toBe(true);
  });

  it("refuses a manager, never mind the member themselves", async () => {
    for (const who of [managerCtx(), memberCtx()]) {
      await expect(runAction("member.set_billing", { userId: 3, billable: true, hourlyRate: 900 }, who)).rejects.toThrow(/requires role admin/);
    }
  });

  it("writes the flag, the rate and the issuer details", async () => {
    fake.queue(memberships, [profile({ billable: false, hourlyRate: null, requireApproval: false })]);
    fake.queue(memberships, [profile()]);
    const r: any = await runAction(
      "member.set_billing",
      { userId: 3, billable: true, hourlyRate: 40, currency: "eur", billingName: "Indigo Studio Ltd", taxId: "FR90210445", requireApproval: true },
      ctx()
    );
    const written = fake.updates.find((u) => u.table === memberships)!.values;
    expect(written).toMatchObject({ billable: true, hourlyRate: 40, currency: "EUR", billingName: "Indigo Studio Ltd", taxId: "FR90210445", requireApproval: true });
    expect(r.displayName).toBe("Priya Indigo");
  });

  it("leaves a field alone when it is not named, so turning billing off keeps the rate", async () => {
    fake.queue(memberships, [profile()]);
    fake.queue(memberships, [profile({ billable: false })]);
    await runAction("member.set_billing", { userId: 3, billable: false }, ctx());
    const written = fake.updates.find((u) => u.table === memberships)!.values;
    expect(written).toEqual({ billable: false });
  });

  it("refuses someone who is not a member of this organization", async () => {
    fake.queue(memberships, []);
    await expect(runAction("member.set_billing", { userId: 99, billable: true }, ctx())).rejects.toThrow(/not a member of this organization/);
  });

  it("rejects a currency that is not a three-letter code, and a negative rate", async () => {
    await expect(runAction("member.set_billing", { userId: 3, billable: true, currency: "dollars" }, ctx())).rejects.toThrow(ActionError);
    await expect(runAction("member.set_billing", { userId: 3, billable: true, hourlyRate: -5 }, ctx())).rejects.toThrow(ActionError);
  });
});

describe("member.billing", () => {
  it("lets a member read their own", async () => {
    fake.queue(memberships, [profile()]);
    const r: any = await runAction("member.billing", { userId: 3 }, memberCtx());
    expect(r.hourlyRate).toBe(40);
  });

  it("refuses a member reading someone else's rate", async () => {
    await expect(runAction("member.billing", { userId: 4 }, memberCtx())).rejects.toThrow(/requires manager or above/);
  });

  it("hands a manager the whole roll when no one is named", async () => {
    fake.queue(memberships, [profile(), profile({ userId: 4, displayName: "Theo Schibsted", billable: false })]);
    const rows: any = await runAction("member.billing", {}, managerCtx());
    expect(rows).toHaveLength(2);
  });
});

/* ── The approval workflow ────────────────────────────────────────────── */

describe("time_entry.submit", () => {
  it("moves a member's own finished entries to pending", async () => {
    fake.queue(timeEntries, [entry(), entry({ id: 15, approvalStatus: "rejected" })]);
    const r: any = await runAction("time_entry.submit", { from: "2026-09-01", to: "2026-09-30" }, memberCtx());
    expect(r.submitted).toBe(2);
    expect(r.entryIds).toEqual([14, 15]);
    expect(r.minutes).toBe(400);
    expect(fake.updates.at(-1)!.values).toMatchObject({ approvalStatus: "pending", approvedBy: null, approvedAt: null });
  });

  it("leaves already-approved lines alone rather than resetting them", async () => {
    fake.queue(timeEntries, [entry({ approvalStatus: "approved" })]);
    const r: any = await runAction("time_entry.submit", { from: "2026-09-01", to: "2026-09-30" }, memberCtx());
    expect(r.submitted).toBe(0);
    expect(r.alreadyApproved).toBe(1);
    expect(fake.updates).toHaveLength(0);
  });

  it("refuses a window that runs backwards", async () => {
    await expect(runAction("time_entry.submit", { from: "2026-09-30", to: "2026-09-01" }, memberCtx())).rejects.toThrow(/`from` is after `to`/);
  });
});

describe("time_entry.approve", () => {
  it("is a manager's signature, and records who signed", async () => {
    expect(getAction("time_entry.approve")!.requiredRole).toBe("manager");
    fake.queue(timeEntries, [entry({ approvalStatus: "pending" })]);
    const r: any = await runAction("time_entry.approve", { entryIds: [14] }, managerCtx());
    expect(r.approved).toBe(1);
    expect(r.approvedBy).toBe("Marcus Vellum");
    const written = fake.updates.at(-1)!.values;
    // Approver and time come from the credential, never from the request body.
    expect(written).toMatchObject({ approvalStatus: "approved", approvedBy: 2 });
    expect(written.approvedAt).toBeInstanceOf(Date);
  });

  it("takes a member and a window instead of a list of ids", async () => {
    fake.queue(timeEntries, [entry({ approvalStatus: "pending" }), entry({ id: 15, approvalStatus: "pending" })]);
    const r: any = await runAction("time_entry.approve", { userId: 3, from: "2026-09-01", to: "2026-09-30" }, managerCtx());
    expect(r.approved).toBe(2);
  });

  it("insists on one form or the other", async () => {
    await expect(runAction("time_entry.approve", { userId: 3 }, managerCtx())).rejects.toThrow(/Pass entryIds, or userId together with from and to/);
  });

  it("refuses ids it cannot act on rather than silently skipping them", async () => {
    fake.queue(timeEntries, [entry()]); // only 14 comes back; 15 is locked, a break or gone
    await expect(runAction("time_entry.approve", { entryIds: [14, 15] }, managerCtx())).rejects.toThrow(/Entry 15 cannot be approved or rejected/);
  });

  it("is closed to members", async () => {
    await expect(runAction("time_entry.approve", { entryIds: [14] }, memberCtx())).rejects.toThrow(/requires role manager/);
  });
});

describe("time_entry.reject", () => {
  it("sends the line back and clears any earlier approval", async () => {
    fake.queue(timeEntries, [entry({ approvalStatus: "approved", approvedBy: 2 })]);
    const r: any = await runAction("time_entry.reject", { entryIds: [14], reason: "logged against the wrong stream" }, managerCtx());
    expect(r.rejected).toBe(1);
    expect(r.reason).toBe("logged against the wrong stream");
    expect(fake.updates.at(-1)!.values).toMatchObject({ approvalStatus: "rejected", approvedBy: null, approvedAt: null });
  });

  it("insists on a reason", async () => {
    await expect(runAction("time_entry.reject", { entryIds: [14] }, managerCtx())).rejects.toThrow(ActionError);
    await expect(runAction("time_entry.reject", { entryIds: [14], reason: "" }, managerCtx())).rejects.toThrow(ActionError);
  });

  it("is audited, because it is a judgement about someone's pay", () => {
    expect(getAction("time_entry.reject")!.audited).toBe(true);
  });
});

describe("time_entry.pending", () => {
  it("shows a member only their own queue", async () => {
    fake.queue(timeEntries, [entry({ approvalStatus: "pending" })]);
    const rows: any = await runAction("time_entry.pending", {}, memberCtx());
    expect(rows).toHaveLength(1);
    expect(rows[0].minutes).toBe(200);
  });

  it("refuses a member asking after someone else", async () => {
    await expect(runAction("time_entry.pending", { userId: 4 }, memberCtx())).rejects.toThrow(/requires manager or above/);
  });
});

/* ── The lock a certified invoice puts on an entry ────────────────────── */

describe("an entry frozen into a certified invoice", () => {
  it("refuses a correction, whatever the caller's role, and says how to undo it", async () => {
    for (const who of [ctx(), managerCtx(), memberCtx()]) {
      fake.reset();
      fake.queue(timeEntries, [entry({ lockedInvoiceId: 7 })]);
      await expect(runAction("time_entry.update", { entryId: 14, notes: "tampering" }, who)).rejects.toThrow(
        /frozen into certified invoice 7.*invoice\.void/s
      );
      expect(fake.updates).toHaveLength(0);
    }
  });

  it("refuses being struck from the ledger", async () => {
    fake.queue(timeEntries, [entry({ lockedInvoiceId: 7 })]);
    await expect(runAction("time_entry.delete", { entryId: 14 }, ctx())).rejects.toThrow(/frozen into certified invoice 7/);
    expect(fake.deletes).toHaveLength(0);
  });

  it("answers `conflict`, so the HTTP face is a 409 rather than a 403", async () => {
    fake.queue(timeEntries, [entry({ lockedInvoiceId: 7 })]);
    await expect(runAction("time_entry.update", { entryId: 14, notes: "x" }, ctx())).rejects.toMatchObject({ code: "conflict" });
  });

  it("still accepts a correction once the lock is gone", async () => {
    const loose = entry({ lockedInvoiceId: null, taskId: null, streamId: null, customerId: null });
    fake.queue(timeEntries, [loose]);
    fake.queue(timeEntries, [{ ...loose, notes: "corrected" }]);
    fake.queue(timeEntries, [{ ...loose, notes: "corrected" }]);
    await runAction("time_entry.update", { entryId: 14, notes: "corrected" }, ctx());
    expect(fake.updates.at(-1)!.values).toMatchObject({ notes: "corrected" });
  });
});

/* ── Where a finished entry starts in the workflow ────────────────────── */

describe("a gated member's entries", () => {
  it("close as pending on stop", async () => {
    // Recent, so the 24-hour runaway-timer guard does not fire first.
    fake.queue(timeEntries, [entry({ checkIn: new Date(Date.now() - 45 * 60_000), checkOut: null, taskId: null, streamId: null })]);
    fake.queue(memberships, [{ requireApproval: true }]);
    fake.queue(timeEntries, [entry({ approvalStatus: "pending" })]); // the update's returning
    fake.queue(timeEntries, [entry({ approvalStatus: "pending" })]); // viewEntry
    const r: any = await runAction("time_entry.stop", {}, memberCtx());
    expect(fake.updates.find((u) => u.table === timeEntries)!.values).toMatchObject({ approvalStatus: "pending" });
    expect(r.approvalStatus).toBe("pending");
  });

  it("close as pending on log_past", async () => {
    fake.queue(memberships, [{ requireApproval: true }]);
    fake.queue(timeEntries, [entry({ approvalStatus: "pending" })]);
    fake.queue(timeEntries, [entry({ approvalStatus: "pending" })]);
    await runAction("time_entry.log_past", { checkIn: "2026-09-15T09:00:00", checkOut: "2026-09-15T12:20:00" }, memberCtx());
    expect(fake.inserts.find((i) => i.table === timeEntries)!.values).toMatchObject({ approvalStatus: "pending" });
  });

  it("leaves an ordinary member's entries at `none`", async () => {
    fake.queue(memberships, [{ requireApproval: false }]);
    fake.queue(timeEntries, [entry()]);
    fake.queue(timeEntries, [entry()]);
    await runAction("time_entry.log_past", { checkIn: "2026-09-15T09:00:00", checkOut: "2026-09-15T12:20:00" }, memberCtx());
    expect(fake.inserts.find((i) => i.table === timeEntries)!.values.approvalStatus).toBe("none");
  });

  it("never asks anyone to approve a break", async () => {
    fake.queue(memberships, [{ requireApproval: true }]);
    fake.queue(timeEntries, [entry({ isBreak: true })]);
    fake.queue(timeEntries, [entry({ isBreak: true })]);
    await runAction("time_entry.log_past", { checkIn: "2026-09-15T13:00:00", checkOut: "2026-09-15T13:30:00", isBreak: true }, memberCtx());
    expect(fake.inserts.find((i) => i.table === timeEntries)!.values.approvalStatus).toBe("none");
  });
});
