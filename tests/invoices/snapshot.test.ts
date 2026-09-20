import { describe, expect, it } from "vitest";
import {
  amountCentsFor,
  canonicalJson,
  contentHashOf,
  entrySha256,
  lineMinutes,
  sha256Hex,
  shortHash,
  SNAPSHOT_VERSION,
  type HashableEntry,
  type InvoiceSnapshot,
} from "../../server/invoices/snapshot";

/**
 * The hash is the whole promise, so what is tested here is the property the
 * promise rests on: the same facts always serialise to the same bytes, and any
 * change to a fact that matters changes them.
 */

const entry = (over: Partial<HashableEntry> = {}): HashableEntry => ({
  id: 14,
  userId: 3,
  checkIn: new Date("2026-09-15T09:00:00.000Z"),
  checkOut: new Date("2026-09-15T12:20:00.000Z"),
  isBreak: false,
  taskId: 11,
  streamId: 3,
  customerId: 1,
  entrySource: "human",
  tokensUsed: null,
  apiCostUsd: null,
  ...over,
});

describe("canonicalJson", () => {
  it("sorts keys at every depth, so column order cannot change a hash", () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it("keeps array order, because a ledger is ordered", () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("renders dates as ISO-8601 and drops undefined members", () => {
    expect(canonicalJson({ at: new Date("2026-09-15T09:00:00.000Z"), gone: undefined })).toBe('{"at":"2026-09-15T09:00:00.000Z"}');
  });

  it("writes null rather than NaN or Infinity, so the output is always valid JSON", () => {
    expect(canonicalJson({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: null })).toBe('{"a":null,"b":null,"c":null}');
    expect(() => JSON.parse(canonicalJson({ a: Number.NaN }))).not.toThrow();
  });

  it("distinguishes a string from the number that looks like it", () => {
    expect(canonicalJson({ n: 1 })).not.toBe(canonicalJson({ n: "1" }));
  });
});

describe("entrySha256", () => {
  it("is stable across a Date and the ISO string of the same instant", () => {
    expect(entrySha256(entry())).toBe(entrySha256(entry({ checkIn: "2026-09-15T09:00:00.000Z", checkOut: "2026-09-15T12:20:00.000Z" })));
  });

  it("changes when any hour, attribution or attachment changes", () => {
    const base = entrySha256(entry());
    const changes: Partial<HashableEntry>[] = [
      { checkOut: new Date("2026-09-15T18:00:00.000Z") },
      { checkIn: new Date("2026-09-15T08:00:00.000Z") },
      { userId: 4 },
      { taskId: 12 },
      { streamId: 2 },
      { customerId: 2 },
      { entrySource: "agent" },
      { isBreak: true },
      { tokensUsed: 10 },
      { apiCostUsd: 0.5 },
      { id: 15 },
    ];
    for (const change of changes) expect(entrySha256(entry(change))).not.toBe(base);
  });

  it("ignores the note, which is prose a member may fix without changing an hour", () => {
    // `notes` is not part of HashableEntry at all; passing it must not matter.
    expect(entrySha256({ ...entry(), notes: "anything" } as HashableEntry)).toBe(entrySha256(entry()));
  });

  it("survives float4's round-trip on the agent cost column", () => {
    // 0.04 stored as float4 reads back as 0.03999999910593033.
    expect(entrySha256(entry({ entrySource: "agent", apiCostUsd: 0.04 }))).toBe(
      entrySha256(entry({ entrySource: "agent", apiCostUsd: 0.03999999910593033 }))
    );
  });

  it("is a 64-character hex digest", () => {
    expect(entrySha256(entry())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("contentHashOf", () => {
  const snapshot = (over: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot => ({
    version: SNAPSHOT_VERSION,
    kind: "contractor",
    org: { id: 1, name: "Atelier 14" },
    contractor: { userId: 3, name: "Priya Indigo", billingName: "Indigo Studio Ltd", taxId: "FR90210445" },
    period: { month: 9, year: 2026, label: "September 2026", from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" },
    currency: "USD",
    rate: 40,
    lines: [
      {
        entryId: 14,
        checkIn: "2026-09-15T09:00:00.000Z",
        checkOut: "2026-09-15T12:20:00.000Z",
        minutes: 200,
        taskId: 11,
        taskKey: "MOB-1",
        taskTitle: "Onboarding copy and screens",
        streamId: 3,
        streamName: "Mobile onboarding",
        entrySource: "human",
        tokensUsed: null,
        apiCostUsd: null,
        approvalStatus: "approved",
        entrySha256: entrySha256(entry()),
      },
    ],
    totals: { minutes: 200, amountCents: 13333, humanMinutes: 200, agentMinutes: 0, tokens: 0, costUsd: 0 },
    issuedAt: "2026-09-20T12:00:00.000Z",
    reference: "PTD-CTR-2026-09-0001",
    ...over,
  });

  it("is reproducible from the same record", () => {
    expect(contentHashOf(snapshot())).toBe(contentHashOf(snapshot()));
  });

  it("moves when the totals, the rate, the reference or a line moves", () => {
    const base = contentHashOf(snapshot());
    expect(contentHashOf(snapshot({ totals: { minutes: 9000, amountCents: 600000, humanMinutes: 9000, agentMinutes: 0, tokens: 0, costUsd: 0 } }))).not.toBe(base);
    expect(contentHashOf(snapshot({ rate: 45 }))).not.toBe(base);
    expect(contentHashOf(snapshot({ reference: "PTD-CTR-2026-09-0002" }))).not.toBe(base);
    expect(contentHashOf(snapshot({ lines: [] }))).not.toBe(base);
  });

  it("survives a round trip through JSONB, where key order is not preserved", () => {
    // Rebuild every object with its keys in reverse order — what a driver handing
    // back a jsonb column in a different order amounts to.
    const shuffle = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(shuffle);
      if (node && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(node as object).reverse()) out[key] = shuffle((node as Record<string, unknown>)[key]);
        return out;
      }
      return node;
    };
    const original = snapshot();
    const reordered = shuffle(JSON.parse(JSON.stringify(original))) as InvoiceSnapshot;
    expect(Object.keys(reordered).join()).not.toBe(Object.keys(original).join());
    expect(contentHashOf(reordered)).toBe(contentHashOf(original));
  });
});

describe("presentation and money", () => {
  it("prints a short hash a person can read aloud", () => {
    expect(shortHash("752a0434bbb6560f88c56c653563daead28d18f21820418e6da978a1d5728803")).toBe("752A 0434 BBB6");
  });

  it("rounds money once, at the end", () => {
    expect(amountCentsFor(200, 40)).toBe(13333);
    expect(amountCentsFor(450, 40)).toBe(30000);
    expect(amountCentsFor(901, 120)).toBe(180200);
    expect(amountCentsFor(0, 40)).toBe(0);
  });

  it("states no money at all when no rate is recorded", () => {
    expect(amountCentsFor(450, null)).toBeNull();
  });

  it("measures a line in whole minutes", () => {
    expect(lineMinutes("2026-09-15T09:00:00Z", "2026-09-15T12:20:00Z")).toBe(200);
    expect(lineMinutes("2026-09-15T09:00:00Z", "2026-09-15T09:00:29Z")).toBe(0);
    expect(lineMinutes("2026-09-15T09:00:00Z", "2026-09-15T09:00:31Z")).toBe(1);
  });

  it("hashes a string to the same digest node's crypto would", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
