import { describe, expect, it, vi } from "vitest";

vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import {
  foldInvoiceLines,
  hm,
  hoursOf,
  invoiceReference,
  monthLabel,
  monthWindow,
  money,
  renderContractorInvoicePdf,
  renderInvoicePdf,
  customerDataFromSnapshot,
  thousands,
  type InvoiceData,
} from "../../server/track/invoice";
import { foldContractorLines } from "../../server/invoices/contractor";
import type { ReportRow } from "../../server/track/reports";

let nextId = 1;

function row(over: Partial<ReportRow> & { checkIn: Date; checkOut: Date | null }): ReportRow {
  return {
    id: nextId++,
    userId: 1,
    userName: "Marcus Vellum",
    streamId: 1,
    streamName: "Security audit",
    streamColor: "#B8451A",
    streamCustomerId: 1,
    taskId: 10,
    taskTitle: "Threat model the checkout flow",
    customerId: null,
    isBreak: false,
    notes: null,
    entrySource: "human",
    tokensUsed: null,
    apiCostUsd: null,
    ...over,
  };
}

const span = (day: number, hour: number, minutes: number) => ({
  checkIn: new Date(2026, 8, day, hour, 0, 0),
  checkOut: new Date(2026, 8, day, hour, minutes, 0),
});

describe("foldInvoiceLines", () => {
  const rows = [
    row(span(7, 9, 150)),
    row(span(8, 10, 95)),
    row({ ...span(9, 14, 22), taskId: 11, taskTitle: "Rotate leaked staging credentials", entrySource: "agent", tokensUsed: 48_200, apiCostUsd: 0.61 }),
    row({ ...span(16, 9, 41), taskId: 12, taskTitle: "Add CSRF tokens to every form", entrySource: "agent", tokensUsed: 132_900, apiCostUsd: 1.74 }),
    row({ ...span(16, 15, 45), taskId: 12, taskTitle: "Add CSRF tokens to every form" }),
    row({ ...span(17, 12, 30), isBreak: true }),
    row({ checkIn: new Date(2026, 8, 18, 9), checkOut: null }),
  ];

  it("bills one line per stream × task, busiest first", () => {
    const { lines } = foldInvoiceLines(rows);
    expect(lines.map((l) => [l.taskTitle, l.minutes])).toEqual([
      ["Threat model the checkout flow", 245],
      ["Add CSRF tokens to every form", 86],
      ["Rotate leaked staging credentials", 22],
    ]);
  });

  it("marks each line by who did the work", () => {
    const { lines } = foldInvoiceLines(rows);
    expect(lines.map((l) => l.source)).toEqual(["human", "mixed", "agent"]);
  });

  it("splits human and agent minutes within a mixed line and carries its spend", () => {
    const mixed = foldInvoiceLines(rows).lines.find((l) => l.source === "mixed")!;
    expect(mixed.humanMinutes).toBe(45);
    expect(mixed.agentMinutes).toBe(41);
    expect(mixed.tokens).toBe(132_900);
    expect(mixed.costUsd).toBe(1.74);
    expect(mixed.sessions).toBe(2);
  });

  it("never bills a break or a session still running", () => {
    const { totals } = foldInvoiceLines(rows);
    expect(totals.sessions).toBe(5);
    expect(totals.minutes).toBe(353);
  });

  it("totals the month with the human/agent split and the pass-through cost", () => {
    const { totals } = foldInvoiceLines(rows);
    expect(totals.humanMinutes).toBe(290);
    expect(totals.agentMinutes).toBe(63);
    expect(totals.humanSessions).toBe(3);
    expect(totals.agentSessions).toBe(2);
    expect(totals.tokens).toBe(181_100);
    expect(totals.costUsd).toBe(2.35);
    expect(totals.hours).toBe(5.88);
  });

  it("names an unattributed line rather than leaving the description blank", () => {
    const { lines } = foldInvoiceLines([row({ ...span(7, 9, 60), streamId: null, streamName: null, taskId: null, taskTitle: null })]);
    expect(lines[0].streamName).toBe("Unassigned");
    expect(lines[0].taskTitle).toBeNull();
  });

  it("bills nothing, and totals zero, for an empty month", () => {
    const { lines, totals } = foldInvoiceLines([]);
    expect(lines).toEqual([]);
    expect(totals).toEqual({
      sessions: 0,
      humanSessions: 0,
      agentSessions: 0,
      humanMinutes: 0,
      agentMinutes: 0,
      minutes: 0,
      hours: 0,
      tokens: 0,
      costUsd: 0,
      // No line carried a rate, so the document states hours and no money.
      amountCents: null,
    });
  });
});

describe("monthWindow", () => {
  it("covers the whole calendar month in local time", () => {
    const { from, to } = monthWindow(9, 2026);
    expect(from.getFullYear()).toBe(2026);
    expect(from.getMonth()).toBe(8);
    expect(from.getDate()).toBe(1);
    expect(from.getHours()).toBe(0);
    expect(to.getDate()).toBe(30);
    expect(to.getHours()).toBe(23);
  });

  it("knows how long February is in a leap year", () => {
    expect(monthWindow(2, 2024).to.getDate()).toBe(29);
    expect(monthWindow(2, 2026).to.getDate()).toBe(28);
  });
});

describe("references and formatting", () => {
  it("numbers an issued invoice and marks an unsaved one a draft", () => {
    expect(invoiceReference(2026, 9, 7)).toBe("PTD-2026-09-0007");
    expect(invoiceReference(2026, 9, null)).toBe("PTD-2026-09-DRAFT");
  });

  it("labels a period the way the document prints it", () => {
    expect(monthLabel(9, 2026)).toBe("September 2026");
  });

  it("prints durations in the monospace column as hours and minutes", () => {
    expect(hm(901)).toBe("15:01");
    expect(hm(45)).toBe("0:45");
    expect(hm(0)).toBe("0:00");
  });

  it("states hours to two decimals and money to the cent", () => {
    expect(hoursOf(901)).toBe("15.02");
    expect(money(9.4)).toBe("$9.40");
    expect(thousands(725_600)).toBe("725,600");
  });
});

/* ── The document itself ─────────────────────────────────────────────── */

const data = (over: Partial<InvoiceData> = {}): InvoiceData => {
  const { lines, totals } = foldInvoiceLines([
    row(span(7, 9, 150)),
    row({ ...span(9, 14, 22), taskId: 11, taskTitle: "Rotate leaked staging credentials", entrySource: "agent", tokensUsed: 48_200, apiCostUsd: 0.61 }),
  ]);
  return {
    orgName: "Atelier 14",
    invoiceId: 7,
    reference: invoiceReference(2026, 9, 7),
    status: "generated",
    customer: {
      id: 1,
      name: "Maison Corbeau",
      billingAddress: "14 rue des Graveurs\n75011 Paris\nFrance",
      billingEmail: "comptes@maisoncorbeau.example",
    },
    period: { month: 9, year: 2026, label: "September 2026", from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" },
    lines,
    totals,
    issuedAt: "2026-09-19T12:00:00.000Z",
    ...over,
  };
};

/** Pull the text-showing operators out of a PDF's decompressed content streams. */
async function pdfText(buffer: Buffer): Promise<string> {
  const { inflateSync } = await import("zlib");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer.toString("latin1"))) !== null) {
    const start = m.index + m[0].length;
    const end = buffer.toString("latin1").indexOf("endstream", start);
    if (end < 0) continue;
    try {
      out.push(inflateSync(buffer.subarray(start, end)).toString("latin1"));
    } catch {
      /* not a deflate stream — a font or an image */
    }
  }
  const content = out.join("\n");
  return (content.match(/<([0-9a-fA-F]+)>/g) ?? [])
    .map((hex) => Buffer.from(hex.slice(1, -1), "hex").toString("latin1"))
    .join("");
}

describe("renderInvoicePdf", () => {
  it("resolves with a PDF, not an HTTP response", async () => {
    const pdf = await renderInvoicePdf(data());
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.subarray(-6).toString()).toContain("EOF");
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it("prints the masthead, the addressee and the period", async () => {
    const text = await pdfText(await renderInvoicePdf(data()));
    expect(text).toContain("INVOICE");
    expect(text).toContain("PTD-2026-09-0007");
    expect(text).toContain("Atelier 14.");
    expect(text).toContain("RENDERED TO");
    expect(text).toContain("Maison Corbeau");
    expect(text).toContain("September 2026");
  });

  it("carries the four ruled sections in order", async () => {
    const text = await pdfText(await renderInvoicePdf(data()));
    const at = (needle: string) => text.indexOf(needle);
    expect(at("I.  HUMAN  /  AGENT")).toBeGreaterThan(-1);
    expect(at("II.  RECORDED WORK")).toBeGreaterThan(at("I.  HUMAN  /  AGENT"));
    expect(at("III.  TOTAL RENDERED")).toBeGreaterThan(at("II.  RECORDED WORK"));
    expect(at("IV.  AGENT API COST")).toBeGreaterThan(at("III.  TOTAL RENDERED"));
  });

  it("gives human and agent a summary line each", async () => {
    const text = await pdfText(await renderInvoicePdf(data()));
    expect(text).toContain("HUMAN");
    expect(text).toContain("AGENT");
    expect(text).toContain("48,200 tokens");
    expect(text).toContain("2:30"); // 150 human minutes
    expect(text).toContain("0:22"); // 22 agent minutes
  });

  it("gives the table a source column and names each line's source", async () => {
    const text = await pdfText(await renderInvoicePdf(data()));
    expect(text).toContain("SOURCE");
    expect(text).toContain("STREAM  ·  TASK");
    expect(text).toContain("Security audit · Threat model");
  });

  it("states the agent's API cost as a pass-through, at face value", async () => {
    const text = await pdfText(await renderInvoicePdf(data()));
    expect(text).toContain("Agent API cost (pass-through)");
    expect(text).toContain("$0.61");
    expect(text).toContain("billed at cost, no markup");
  });

  it("says why there is no money column for the hours", async () => {
    const text = await pdfText(await renderInvoicePdf(data()));
    expect(text).toContain("No hourly rate is recorded for this customer or its streams");
  });

  it("closes with an italic colophon naming the organization", async () => {
    const text = await pdfText(await renderInvoicePdf(data()));
    expect(text).toContain("Issued by Atelier 14 through Plan Track Done");
  });

  it("renders an empty month without failing, and says the page is bare", async () => {
    const empty = data({ ...foldInvoiceLines([]), invoiceId: null, reference: invoiceReference(2026, 9, null) });
    const pdf = await renderInvoicePdf(empty);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pdfText(pdf)).toContain("No recorded work sessions in this period.");
  });

  it("paginates a long month instead of printing off the bottom of the page", async () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      row({ ...span(7, 9, 30 + i), taskId: 100 + i, taskTitle: `Line item number ${i} with a deliberately long description that must be elided` })
    );
    const pdf = await renderInvoicePdf(data({ ...foldInvoiceLines(many) }));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // More than one page object means the table broke rather than overprinted.
    expect((pdf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length).toBeGreaterThan(1);
  });

  it("carries a customer with no billing details at all", async () => {
    const pdf = await renderInvoicePdf(data({ customer: { id: 2, name: "Verso Press", billingAddress: null, billingEmail: null } }));
    expect(await pdfText(pdf)).toContain("Verso Press");
  });
});

/* ── Certification, and the contractor layout ───────────────────────────── */

const CERT = {
  reference: "PTD-CTR-2026-09-0001",
  contentHash: "752a0434bbb6560f88c56c653563daead28d18f21820418e6da978a1d5728803",
  keyId: 1,
  algorithm: "ed25519",
  verifyUrl: "https://ptd.example.com/verify/f58bcb303d70aa83a9aa6e362c68752cb92d367a2940c63c7aacc0144817f8cf",
  issuedAt: "2026-09-20T12:00:00.000Z",
  voided: false,
};

const snapshotLines = [
  {
    entryId: 14,
    checkIn: new Date(2026, 8, 15, 9, 0).toISOString(),
    checkOut: new Date(2026, 8, 15, 12, 20).toISOString(),
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
    entrySha256: "a".repeat(64),
  },
  {
    entryId: 15,
    checkIn: new Date(2026, 8, 16, 9, 0).toISOString(),
    checkOut: new Date(2026, 8, 16, 11, 40).toISOString(),
    minutes: 160,
    taskId: 11,
    taskKey: "MOB-1",
    taskTitle: "Onboarding copy and screens",
    streamId: 3,
    streamName: "Mobile onboarding",
    entrySource: "agent",
    tokensUsed: 48_200,
    apiCostUsd: 0.61,
    approvalStatus: "approved",
    entrySha256: "b".repeat(64),
  },
];

function contractorData(over: Record<string, unknown> = {}) {
  const { lines, totals } = foldContractorLines(snapshotLines, 40);
  return {
    kind: "contractor" as const,
    orgName: "Atelier 14",
    org: { id: 1, name: "Atelier 14" },
    invoiceId: 1,
    reference: "PTD-CTR-2026-09-0001",
    status: "issued",
    contractor: {
      userId: 3,
      name: "Priya Indigo",
      billingName: "Indigo Studio Ltd",
      billingAddress: "9 Rue Bleue\n75009 Paris",
      taxId: "FR90210445",
      email: "priya@atelier14.demo",
    },
    period: { month: 9, year: 2026, label: "September 2026", from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" },
    currency: "USD",
    rate: 40,
    onlyApproved: true,
    lines,
    entries: snapshotLines,
    totals,
    excluded: { pendingMinutes: 0, rejectedMinutes: 0, unsubmittedMinutes: 0 },
    alreadyInvoiced: [],
    issuedAt: "2026-09-20T12:00:00.000Z",
    certification: CERT,
    ...over,
  };
}

describe("renderContractorInvoicePdf", () => {
  it("makes the contractor the issuer and the organization the bill-to", async () => {
    const text = await pdfText(await renderContractorInvoicePdf(contractorData()));
    expect(text).toContain("CONTRACTOR INVOICE");
    expect(text).toContain("PTD-CTR-2026-09-0001");
    expect(text).toContain("FROM");
    expect(text).toContain("Indigo Studio Ltd");
    expect(text).toContain("Priya Indigo");
    expect(text).toContain("TAX ID  FR90210445");
    expect(text).toContain("BILL TO");
    expect(text).toContain("Atelier 14");
  });

  it("states the rate, the hours and the amount due", async () => {
    const text = await pdfText(await renderContractorInvoicePdf(contractorData()));
    expect(text).toContain("I.  TERMS");
    expect(text).toContain("$40.00/h");
    expect(text).toContain("6.00"); // 360 minutes
    expect(text).toContain("III.  TOTAL DUE");
    expect(text).toContain("$240.00");
  });

  it("gives every day a dated line with its source", async () => {
    const text = await pdfText(await renderContractorInvoicePdf(contractorData()));
    expect(text).toContain("II.  RECORDED WORK");
    expect(text).toContain("Tue 15 Sep");
    expect(text).toContain("Wed 16 Sep");
    expect(text).toContain("MOB-1 Onboarding copy");
    expect(text).toContain("HUMAN");
    expect(text).toContain("AGENT");
  });

  it("says whether unapproved hours were left out", async () => {
    expect(await pdfText(await renderContractorInvoicePdf(contractorData()))).toContain("Only entries approved by a manager are billed");
    expect(await pdfText(await renderContractorInvoicePdf(contractorData({ onlyApproved: false })))).toContain("Every recorded entry in the period is billed");
  });

  it("states hours rather than money when the membership has no rate", async () => {
    const { lines, totals } = foldContractorLines(snapshotLines, null);
    const text = await pdfText(await renderContractorInvoicePdf(contractorData({ rate: null, lines, totals })));
    expect(text).toContain("no rate recorded");
    expect(text).toContain("6.00 h");
  });

  it("prices in the member's own currency", async () => {
    const text = await pdfText(await renderContractorInvoicePdf(contractorData({ currency: "SEK" })));
    expect(text).toContain("40.00 SEK/h");
    expect(text).toContain("240.00 SEK");
  });

  it("renders a month with nothing in it without failing", async () => {
    const { lines, totals } = foldContractorLines([], 40);
    const pdf = await renderContractorInvoicePdf(contractorData({ lines, totals, entries: [] }));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pdfText(pdf)).toContain("No billable sessions in this period.");
  });
});

describe("the certification block", () => {
  it("prints the reference, both forms of the hash, the key and the verification URL", async () => {
    const text = await pdfText(await renderContractorInvoicePdf(contractorData()));
    expect(text).toContain("CERTIFIED BY PTD");
    expect(text).toContain("REFERENCE");
    expect(text).toContain("PTD-CTR-2026-09-0001");
    // Short enough to read aloud, and the full digest for a machine.
    expect(text).toContain("752A 0434 BBB6");
    expect(text).toContain(CERT.contentHash);
    expect(text).toContain("ed25519 · key #1");
    expect(text).toContain(CERT.verifyUrl);
    expect(text).toContain("scan to verify");
  });

  it("draws the URL as a QR code as well as text", async () => {
    const withQr = await renderContractorInvoicePdf(contractorData());
    const withoutQr = await renderContractorInvoicePdf(contractorData({ certification: undefined }));
    // The QR is hundreds of vector rectangles; the certified document is visibly larger.
    expect(withQr.length).toBeGreaterThan(withoutQr.length + 2000);
  });

  it("says so on the face of a voided invoice", async () => {
    const text = await pdfText(await renderContractorInvoicePdf(contractorData({ certification: { ...CERT, voided: true } })));
    expect(text).toContain("VOIDED");
    expect(text).toContain("this invoice has been withdrawn");
  });

  it("appears on a customer invoice too", async () => {
    const text = await pdfText(await renderInvoicePdf(data({ certification: CERT })));
    expect(text).toContain("CERTIFIED BY PTD");
    expect(text).toContain(CERT.verifyUrl);
  });

  it("is absent from an uncertified document rather than printing empty headings", async () => {
    const text = await pdfText(await renderInvoicePdf(data()));
    expect(text).not.toContain("CERTIFIED BY PTD");
  });
});

describe("customerDataFromSnapshot", () => {
  it("re-draws an issued invoice from its own frozen record", async () => {
    const snapshot = {
      version: 1 as const,
      kind: "customer" as const,
      org: { id: 1, name: "Atelier 14" },
      customer: { id: 1, name: "Maison Corbeau", billingAddress: null, billingEmail: null },
      period: { month: 9, year: 2026, label: "September 2026", from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" },
      currency: "EUR",
      rate: 120,
      lines: snapshotLines.map((l) => ({ ...l, rate: 150, amountCents: Math.round((l.minutes / 60) * 150 * 100) })),
      totals: { minutes: 360, amountCents: 90000, humanMinutes: 200, agentMinutes: 160, tokens: 48_200, costUsd: 0.61 },
      issuedAt: "2026-09-20T12:00:00.000Z",
      reference: "PTD-2026-09-0003",
    };
    const redrawn = customerDataFromSnapshot(snapshot, { invoiceId: 3, status: "issued", certification: CERT });
    expect(redrawn.reference).toBe("PTD-2026-09-0003");
    expect(redrawn.customer.name).toBe("Maison Corbeau");
    expect(redrawn.currency).toBe("EUR");
    expect(redrawn.totals.minutes).toBe(360);
    // A stream rate overrode the customer's, and the snapshot remembers which.
    expect(redrawn.lines[0].rate).toBe(150);
    const text = await pdfText(await renderInvoicePdf(redrawn));
    expect(text).toContain("PTD-2026-09-0003");
    expect(text).toContain("AMOUNT");
    // WinAnsi puts the euro sign at 0x80, which is what the extractor reads back.
    expect(text).toContain("\u0080900.00");
  });
});
