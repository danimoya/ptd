import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import { db } from "../../db";
import {
  buildContractorInvoice,
  contractorDataFromSnapshot,
  contractorReference,
  contractorSnapshot,
  foldContractorLines,
  includedFor,
} from "../../server/invoices/contractor";
import { entrySha256, type SnapshotLine } from "../../server/invoices/snapshot";
import type { FakeDb } from "./fake-db";

const fake = db as unknown as FakeDb;

let nextId = 100;

/** One frozen line, at a local wall-clock time so the day grouping is testable. */
function line(over: Partial<SnapshotLine> & { day: number; hour: number; minutes: number }): SnapshotLine {
  const checkIn = new Date(2026, 8, over.day, over.hour, 0, 0);
  const checkOut = new Date(checkIn.getTime() + over.minutes * 60_000);
  const { day, hour, minutes, ...rest } = over;
  return {
    entryId: nextId++,
    checkIn: checkIn.toISOString(),
    checkOut: checkOut.toISOString(),
    minutes,
    taskId: 11,
    taskKey: "MOB-1",
    taskTitle: "Onboarding copy and screens",
    streamId: 3,
    streamName: "Mobile onboarding",
    entrySource: "human",
    tokensUsed: null,
    apiCostUsd: null,
    approvalStatus: "approved",
    entrySha256: "0".repeat(64),
    ...rest,
  };
}

const profile = (over: Record<string, unknown> = {}) => ({
  userId: 3,
  displayName: "Priya Indigo",
  email: "priya@atelier14.demo",
  isAgent: false,
  role: "member",
  billable: true,
  hourlyRate: 40,
  currency: "USD",
  billingName: "Indigo Studio Ltd",
  billingAddress: "9 Rue Bleue\n75009 Paris",
  taxId: "FR90210445",
  requireApproval: true,
  ...over,
});

const entryRow = (over: Record<string, unknown> = {}) => ({
  id: 14,
  userId: 3,
  userName: "Priya Indigo",
  checkIn: new Date(2026, 8, 15, 9, 0, 0),
  checkOut: new Date(2026, 8, 15, 12, 20, 0),
  taskId: 11,
  taskKey: "MOB-1",
  taskTitle: "Onboarding copy and screens",
  streamId: 3,
  streamName: "Mobile onboarding",
  streamCustomerId: 1,
  streamHourlyRate: null,
  customerId: 1,
  isBreak: false,
  entrySource: "human",
  tokensUsed: null,
  apiCostUsd: null,
  approvalStatus: "approved",
  lockedInvoiceId: null,
  ...over,
});

beforeEach(() => {
  fake.reset();
  nextId = 100;
});

describe("foldContractorLines", () => {
  it("groups one line per day × stream × task, chronologically", () => {
    const { lines } = foldContractorLines(
      [
        line({ day: 15, hour: 9, minutes: 120 }),
        line({ day: 15, hour: 14, minutes: 80 }),
        line({ day: 16, hour: 9, minutes: 160 }),
        line({ day: 16, hour: 13, minutes: 45, taskId: 12, taskKey: "MOB-2", taskTitle: "Empty states" }),
      ],
      40
    );
    expect(lines.map((l) => [l.date, l.taskKey, l.minutes, l.sessions])).toEqual([
      ["2026-09-15", "MOB-1", 200, 2],
      ["2026-09-16", "MOB-1", 160, 1],
      ["2026-09-16", "MOB-2", 45, 1],
    ]);
  });

  it("prices each line and the month from the member's rate", () => {
    const { lines, totals } = foldContractorLines([line({ day: 15, hour: 9, minutes: 200 }), line({ day: 16, hour: 9, minutes: 160 }), line({ day: 18, hour: 9, minutes: 90 })], 40);
    expect(lines.map((l) => l.amountCents)).toEqual([13333, 10667, 6000]);
    expect(totals.minutes).toBe(450);
    expect(totals.hours).toBe(7.5);
    // Priced from the month's total, not the sum of the lines, so no cent drifts.
    expect(totals.amountCents).toBe(30000);
  });

  it("states hours and no money when the membership carries no rate", () => {
    const { lines, totals } = foldContractorLines([line({ day: 15, hour: 9, minutes: 200 })], null);
    expect(lines[0].amountCents).toBeNull();
    expect(totals.amountCents).toBeNull();
    expect(totals.minutes).toBe(200);
  });

  it("marks a day human, agent or mixed, and carries the agent's tokens", () => {
    const { lines, totals } = foldContractorLines(
      [
        line({ day: 15, hour: 9, minutes: 60 }),
        line({ day: 15, hour: 11, minutes: 30, entrySource: "agent", tokensUsed: 48_200, apiCostUsd: 0.61 }),
        line({ day: 16, hour: 9, minutes: 20, entrySource: "agent", tokensUsed: 1_000, apiCostUsd: 0.1 }),
      ],
      40
    );
    expect(lines.map((l) => l.source)).toEqual(["mixed", "agent"]);
    expect(lines[0].tokens).toBe(48_200);
    expect(totals.humanMinutes).toBe(60);
    expect(totals.agentMinutes).toBe(50);
    expect(totals.tokens).toBe(49_200);
    expect(totals.costUsd).toBe(0.71);
  });

  it("says `mixed` when a day's approval state is not uniform", () => {
    const { lines } = foldContractorLines(
      [line({ day: 15, hour: 9, minutes: 60, approvalStatus: "approved" }), line({ day: 15, hour: 11, minutes: 30, approvalStatus: "pending" })],
      40
    );
    expect(lines[0].approval).toBe("mixed");
  });

  it("bills nothing, and totals zero, for an empty month", () => {
    const { lines, totals } = foldContractorLines([], 40);
    expect(lines).toEqual([]);
    expect(totals).toEqual({ sessions: 0, minutes: 0, hours: 0, humanMinutes: 0, agentMinutes: 0, tokens: 0, costUsd: 0, amountCents: 0 });
  });
});

describe("includedFor", () => {
  it("bills only approved entries for a member whose hours need signing off", () => {
    const keep = includedFor(profile() as never, true);
    expect(["approved", "pending", "rejected", "none"].filter((s) => keep({ approvalStatus: s }))).toEqual(["approved"]);
  });

  it("bills everything except an explicit rejection when no approval is required", () => {
    const keep = includedFor(profile({ requireApproval: false }) as never, false);
    expect(["approved", "pending", "rejected", "none"].filter((s) => keep({ approvalStatus: s }))).toEqual(["approved", "pending", "none"]);
  });
});

describe("references", () => {
  it("numbers the contractor series apart from the customer one", () => {
    expect(contractorReference(2026, 9, 1)).toBe("PTD-CTR-2026-09-0001");
    expect(contractorReference(2026, 12, 123)).toBe("PTD-CTR-2026-12-0123");
    expect(contractorReference(2026, 9, null)).toBe("PTD-CTR-2026-09-DRAFT");
  });
});

describe("buildContractorInvoice", () => {
  it("assembles the month from the ledger at the member's rate", async () => {
    fake.queue([profile()], [entryRow(), entryRow({ id: 15, checkIn: new Date(2026, 8, 16, 9, 0), checkOut: new Date(2026, 8, 16, 11, 40) })]);
    const data = await buildContractorInvoice({ orgId: 1, orgName: "Atelier 14", userId: 3, month: 9, year: 2026 });
    expect(data.kind).toBe("contractor");
    expect(data.reference).toBe("PTD-CTR-2026-09-DRAFT");
    expect(data.currency).toBe("USD");
    expect(data.rate).toBe(40);
    expect(data.contractor).toMatchObject({ billingName: "Indigo Studio Ltd", taxId: "FR90210445" });
    expect(data.totals.minutes).toBe(360);
    expect(data.totals.amountCents).toBe(24000);
    expect(data.entries).toHaveLength(2);
    expect(data.lines).toHaveLength(2);
  });

  it("defaults `onlyApproved` to the member's own approval setting", async () => {
    fake.queue([profile()], [entryRow({ approvalStatus: "pending" })]);
    const gated = await buildContractorInvoice({ orgId: 1, orgName: "Atelier 14", userId: 3, month: 9, year: 2026 });
    expect(gated.onlyApproved).toBe(true);
    expect(gated.entries).toHaveLength(0);
    expect(gated.excluded.pendingMinutes).toBe(200);

    fake.reset().queue([profile({ requireApproval: false })], [entryRow({ approvalStatus: "pending" })]);
    const open = await buildContractorInvoice({ orgId: 1, orgName: "Atelier 14", userId: 3, month: 9, year: 2026 });
    expect(open.onlyApproved).toBe(false);
    expect(open.entries).toHaveLength(1);
  });

  it("separates what was left out, and why", async () => {
    fake.queue(
      [profile()],
      [
        entryRow({ id: 14, approvalStatus: "approved" }),
        entryRow({ id: 15, approvalStatus: "pending", checkIn: new Date(2026, 8, 16, 9, 0), checkOut: new Date(2026, 8, 16, 10, 0) }),
        entryRow({ id: 16, approvalStatus: "rejected", checkIn: new Date(2026, 8, 17, 9, 0), checkOut: new Date(2026, 8, 17, 9, 30) }),
        entryRow({ id: 17, approvalStatus: "none", checkIn: new Date(2026, 8, 18, 9, 0), checkOut: new Date(2026, 8, 18, 9, 15) }),
      ]
    );
    const data = await buildContractorInvoice({ orgId: 1, orgName: "Atelier 14", userId: 3, month: 9, year: 2026 });
    expect(data.entries.map((e) => e.entryId)).toEqual([14]);
    expect(data.excluded).toEqual({ pendingMinutes: 60, rejectedMinutes: 30, unsubmittedMinutes: 15 });
  });

  it("names entries an earlier invoice already froze", async () => {
    fake.queue([profile()], [entryRow({ lockedInvoiceId: 9 })]);
    const data = await buildContractorInvoice({ orgId: 1, orgName: "Atelier 14", userId: 3, month: 9, year: 2026 });
    expect(data.alreadyInvoiced).toEqual([{ entryId: 14, invoiceId: 9 }]);
  });

  it("refuses a member who is not marked billable, and says how to fix it", async () => {
    fake.queue([profile({ billable: false })]);
    await expect(buildContractorInvoice({ orgId: 1, orgName: "Atelier 14", userId: 3, month: 9, year: 2026 })).rejects.toThrow(
      /not marked billable.*member\.set_billing/s
    );
  });

  it("refuses someone who is not in the organization", async () => {
    fake.queue([]);
    await expect(buildContractorInvoice({ orgId: 1, orgName: "Atelier 14", userId: 99, month: 9, year: 2026 })).rejects.toThrow(/not a member of this organization/);
  });

  it("hashes each entry so a later edit is detectable", async () => {
    const row = entryRow();
    fake.queue([profile()], [row]);
    const data = await buildContractorInvoice({ orgId: 1, orgName: "Atelier 14", userId: 3, month: 9, year: 2026 });
    expect(data.entries[0].entrySha256).toBe(entrySha256(row as never));
    expect(data.entries[0].entrySha256).not.toBe(entrySha256({ ...row, checkOut: new Date(2026, 8, 15, 18, 0) } as never));
  });
});

describe("contractorSnapshot", () => {
  it("freezes the identity, the period, the rate and one line per entry", async () => {
    fake.queue([profile()], [entryRow()]);
    const data = await buildContractorInvoice({ orgId: 1, orgName: "Atelier 14", userId: 3, month: 9, year: 2026, invoiceId: 1 });
    const snap = contractorSnapshot({ ...data, reference: contractorReference(2026, 9, 1) });
    expect(snap).toMatchObject({
      version: 1,
      kind: "contractor",
      org: { id: 1, name: "Atelier 14" },
      contractor: { userId: 3, name: "Priya Indigo", billingName: "Indigo Studio Ltd", taxId: "FR90210445" },
      currency: "USD",
      rate: 40,
      reference: "PTD-CTR-2026-09-0001",
    });
    expect(snap.lines).toHaveLength(1);
    expect(snap.totals.minutes).toBe(200);
    // A snapshot carries no address and no email — it is served to strangers.
    expect(JSON.stringify(snap)).not.toContain("Rue Bleue");
    expect(JSON.stringify(snap)).not.toContain("@");
  });

  it("re-draws the same document from the snapshot alone", async () => {
    fake.queue([profile()], [entryRow()]);
    const data = await buildContractorInvoice({ orgId: 1, orgName: "Atelier 14", userId: 3, month: 9, year: 2026, invoiceId: 1 });
    const snap = contractorSnapshot({ ...data, reference: contractorReference(2026, 9, 1) });
    const redrawn = contractorDataFromSnapshot(snap, { invoiceId: 1, status: "issued" });
    expect(redrawn.totals.minutes).toBe(data.totals.minutes);
    expect(redrawn.totals.amountCents).toBe(data.totals.amountCents);
    expect(redrawn.lines.map((l) => [l.date, l.minutes])).toEqual(data.lines.map((l) => [l.date, l.minutes]));
    expect(redrawn.contractor.billingName).toBe("Indigo Studio Ltd");
  });
});
