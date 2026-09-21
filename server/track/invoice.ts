/**
 * The invoice, as a PDF — customer-facing and contractor-facing.
 *
 * Ported from the original tracker's response-coupled `/api/generate-invoice` handler:
 * the editorial ledger layout survives — masthead, ruled table, vermilion
 * section labels, a monospace duration column and an italic colophon — but the
 * renderer no longer knows what an HTTP response is. Both `renderInvoicePdf` and
 * `renderContractorInvoicePdf` take data and resolve to a Buffer, so the same
 * functions serve the download route, a future email attachment and a test that
 * only wants to know the bytes start with `%PDF`.
 *
 * Three things are new since the port, and they are why this file exists rather
 * than the old handler being moved:
 *
 *  - A line's **source** (human, agent or both) is a column, and the agent's API
 *    spend is carried to its own section as a pass-through cost. PTD bills for
 *    hours a human *or* a machine put in, and an invoice that hides which is
 *    which is the wrong document.
 *  - **Rates exist now.** A customer may carry an hourly rate and a stream may
 *    override it; a billable member carries their own. Where a rate is known the
 *    document multiplies; where none is recorded it states hours and says so.
 *  - Every document ends in a **certification block**: reference, content hash,
 *    signing key and a verification URL, printed as text and as a QR code, so the
 *    person holding the paper can check it against the issuing deployment.
 *
 * The two layouts differ in who is the issuer. On a customer invoice the
 * organization renders to its client. On a contractor invoice the external member
 * is the issuer and the organization is the bill-to — the money flows the other
 * way, so the masthead does too.
 */

import PDFDocument from "pdfkit";
import { format } from "date-fns";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { customers } from "../../db/schema";
import { ActionError } from "../actions/registry";
import { minutesFrom, num, usd } from "./aggregate";
import { billableEntries, snapshotLine } from "../invoices/entries";
import { amountCentsFor, shortHash, type Certification, type InvoiceSnapshot, type SnapshotLine } from "../invoices/snapshot";
import { encodeQr } from "../invoices/qr";
import type { ContractorInvoiceData } from "../invoices/contractor";

/* ── Palette and metrics, lifted from the client's parchment theme ────── */

const INK = "#1A1510";
const INK_MUTED = "#7A6F5D";
const VERMILION = "#B8451A";
const HAIRLINE = "#1A151033";

const MARGIN = 56;
const LEFT = MARGIN;
/** A4 is 595.28pt wide; the rule stops on the right margin, not past it. */
const RIGHT = 539;
/** A4 is 841.89pt tall; nothing is drawn below the bottom margin. */
const CONTENT_BOTTOM = 786;
const ROW_HEIGHT = 15;

interface Column {
  x: number;
  width: number;
  align?: "left" | "right";
}

const COLS: Record<string, Column> = {
  num: { x: LEFT, width: 20 },
  line: { x: 78, width: 190 },
  source: { x: 272, width: 40 },
  sessions: { x: 314, width: 32, align: "right" },
  human: { x: 350, width: 58, align: "right" },
  agent: { x: 412, width: 58, align: "right" },
  total: { x: 474, width: 65, align: "right" },
};

/** The same table with a money column; used only when a rate is recorded. */
const COLS_PRICED: Record<string, Column> = {
  num: { x: LEFT, width: 18 },
  line: { x: 76, width: 156 },
  source: { x: 236, width: 34 },
  sessions: { x: 272, width: 24, align: "right" },
  human: { x: 300, width: 44, align: "right" },
  agent: { x: 348, width: 44, align: "right" },
  total: { x: 396, width: 44, align: "right" },
  amount: { x: 444, width: 95, align: "right" },
};

/** The contractor table: a date column instead of a human/agent pair. */
const COLS_CONTRACTOR: Record<string, Column> = {
  num: { x: LEFT, width: 18 },
  date: { x: 76, width: 64 },
  line: { x: 144, width: 174 },
  source: { x: 322, width: 34 },
  sessions: { x: 358, width: 24, align: "right" },
  total: { x: 386, width: 52, align: "right" },
  amount: { x: 442, width: 97, align: "right" },
};

/* ── Data ────────────────────────────────────────────────────────────── */

export type LineSource = "human" | "agent" | "mixed";

/** The minimum a row needs for the fold — satisfied by report rows and by invoice rows alike. */
export interface BillableRow {
  streamId: number | null;
  streamName: string | null;
  taskId: number | null;
  taskTitle: string | null;
  isBreak: boolean;
  entrySource: string | null;
  tokensUsed: number | null;
  apiCostUsd: number | null;
  checkIn: Date | string;
  checkOut: Date | string | null;
}

export interface InvoiceLine {
  streamId: number | null;
  streamName: string;
  taskId: number | null;
  taskTitle: string | null;
  sessions: number;
  humanMinutes: number;
  agentMinutes: number;
  minutes: number;
  tokens: number;
  costUsd: number;
  source: LineSource;
  /** The hourly rate that applied to this line: the stream's, else the customer's. */
  rate: number | null;
  amountCents: number | null;
}

export interface InvoiceTotals {
  sessions: number;
  humanSessions: number;
  agentSessions: number;
  humanMinutes: number;
  agentMinutes: number;
  minutes: number;
  hours: number;
  tokens: number;
  costUsd: number;
  /** Null when no rate is recorded anywhere — then the document states hours only. */
  amountCents: number | null;
}

export interface InvoiceCustomer {
  id: number;
  name: string;
  billingAddress: string | null;
  billingEmail: string | null;
  hourlyRate?: number | null;
  currency?: string;
}

export interface InvoicePeriod {
  month: number;
  year: number;
  label: string;
  from: string;
  to: string;
}

export interface InvoiceData {
  orgName: string;
  /** Null on a preview that has not been committed to the invoices table yet. */
  invoiceId: number | null;
  reference: string;
  status: string;
  customer: InvoiceCustomer;
  period: InvoicePeriod;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  issuedAt: string;
  currency?: string;
  /** One line per ledger entry, the grain that gets hashed and signed. */
  entries?: SnapshotLine[];
  certification?: Certification;
  /** Entries a previous invoice already froze; generating is refused while non-empty. */
  alreadyInvoiced?: { entryId: number; invoiceId: number }[];
}

/* ── Folding ledger rows into billable lines ─────────────────────────── */

interface LineAcc {
  streamId: number | null;
  streamName: string;
  taskId: number | null;
  taskTitle: string | null;
  sessions: number;
  humanSeconds: number;
  agentSeconds: number;
  humanSessions: number;
  agentSessions: number;
  tokens: number;
  cost: number;
  rate: number | null;
}

const lineKey = (row: BillableRow) => `${row.streamId ?? "-"}:${row.taskId ?? "-"}`;

const secondsOf = (row: BillableRow): number => {
  if (!row.checkOut) return 0;
  return Math.max(0, (new Date(row.checkOut).getTime() - new Date(row.checkIn).getTime()) / 1000);
};

/**
 * One line per stream × task, which is the grain a customer can actually read:
 * "Security audit — Rotate leaked credentials" rather than forty timestamps.
 * Breaks never bill, and a still-running session has no duration to bill.
 *
 * `rateFor` names the hourly rate of a row; the stream's rate overrides the
 * customer's, and a row with neither bills as hours with no money attached.
 */
export function foldInvoiceLines<R extends BillableRow>(
  rows: R[],
  rateFor?: (row: R) => number | null
): { lines: InvoiceLine[]; totals: InvoiceTotals } {
  const acc = new Map<string, LineAcc>();
  for (const row of rows) {
    if (row.isBreak) continue;
    const seconds = secondsOf(row);
    if (seconds <= 0) continue;
    const key = lineKey(row);
    const cur =
      acc.get(key) ??
      ({
        streamId: row.streamId,
        streamName: row.streamName ?? "Unassigned",
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        sessions: 0,
        humanSeconds: 0,
        agentSeconds: 0,
        humanSessions: 0,
        agentSessions: 0,
        tokens: 0,
        cost: 0,
        rate: rateFor ? rateFor(row) : null,
      } satisfies LineAcc);
    cur.sessions += 1;
    if (row.entrySource === "agent") {
      cur.agentSeconds += seconds;
      cur.agentSessions += 1;
      cur.tokens += num(row.tokensUsed);
      cur.cost += num(row.apiCostUsd);
    } else {
      cur.humanSeconds += seconds;
      cur.humanSessions += 1;
    }
    acc.set(key, cur);
  }

  const lines: InvoiceLine[] = Array.from(acc.values())
    .map((a) => {
      const humanMinutes = minutesFrom(a.humanSeconds);
      const agentMinutes = minutesFrom(a.agentSeconds);
      const minutes = humanMinutes + agentMinutes;
      return {
        streamId: a.streamId,
        streamName: a.streamName,
        taskId: a.taskId,
        taskTitle: a.taskTitle,
        sessions: a.sessions,
        humanMinutes,
        agentMinutes,
        minutes,
        tokens: Math.round(a.tokens),
        costUsd: usd(a.cost),
        source: (a.agentSessions === 0 ? "human" : a.humanSessions === 0 ? "agent" : "mixed") as LineSource,
        rate: a.rate,
        amountCents: amountCentsFor(minutes, a.rate),
      };
    })
    .sort(
      (a, b) =>
        b.minutes - a.minutes ||
        a.streamName.localeCompare(b.streamName) ||
        (a.taskTitle ?? "").localeCompare(b.taskTitle ?? "")
    );

  const totals = Array.from(acc.values()).reduce<InvoiceTotals>(
    (t, a) => ({
      sessions: t.sessions + a.sessions,
      humanSessions: t.humanSessions + a.humanSessions,
      agentSessions: t.agentSessions + a.agentSessions,
      humanMinutes: t.humanMinutes + minutesFrom(a.humanSeconds),
      agentMinutes: t.agentMinutes + minutesFrom(a.agentSeconds),
      minutes: 0,
      hours: 0,
      tokens: t.tokens + Math.round(a.tokens),
      costUsd: t.costUsd + a.cost,
      amountCents: null,
    }),
    { sessions: 0, humanSessions: 0, agentSessions: 0, humanMinutes: 0, agentMinutes: 0, minutes: 0, hours: 0, tokens: 0, costUsd: 0, amountCents: null }
  );
  totals.minutes = totals.humanMinutes + totals.agentMinutes;
  totals.hours = Math.round((totals.minutes / 60) * 100) / 100;
  totals.costUsd = usd(totals.costUsd);
  // Money is stated only when at least one line had a rate; the priced lines are
  // then summed, so a half-priced month adds up to what it actually owes.
  const priced = lines.filter((l) => l.amountCents !== null);
  totals.amountCents = priced.length ? priced.reduce((t, l) => t + (l.amountCents ?? 0), 0) : null;

  return { lines, totals };
}

/** "PTD-2026-09-0007" — stable, sortable, and readable over the phone. */
export function invoiceReference(year: number, month: number, invoiceId: number | null): string {
  const tail = invoiceId === null ? "DRAFT" : String(invoiceId).padStart(4, "0");
  return `PTD-${year}-${String(month).padStart(2, "0")}-${tail}`;
}

export const monthLabel = (month: number, year: number): string => `${format(new Date(year, month - 1, 1), "MMMM")} ${year}`;

/** The calendar month, in local time, as the ledger reads every other window. */
export function monthWindow(month: number, year: number): { from: Date; to: Date } {
  const from = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const to = new Date(year, month, 0, 23, 59, 59, 999);
  return { from, to };
}

/* ── Formatting ──────────────────────────────────────────────────────── */

/** "2:30" — the monospace duration column, hours and minutes, never a decimal. */
export function hm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

export const hoursOf = (minutes: number): string => (minutes / 60).toFixed(2);

export const thousands = (n: number): string => n.toLocaleString("en-US");

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" };

/** "$1,240.00" where a symbol exists, "1,240.00 SEK" where one does not. */
export function money(n: number, currency = "USD"): string {
  const amount = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const code = currency.toUpperCase();
  const symbol = SYMBOLS[code];
  return symbol ? `${symbol}${amount}` : `${amount} ${code}`;
}

export const moneyFromCents = (cents: number | null, currency = "USD"): string => (cents === null ? "–" : money(cents / 100, currency));

/** "$45.00/h", or "no rate recorded" where a membership or customer has none. */
export const rateLabel = (rate: number | null, currency = "USD"): string => (rate === null ? "no rate recorded" : `${money(rate, currency)}/h`);

/* ── Rendering ───────────────────────────────────────────────────────── */

type Doc = PDFKit.PDFDocument;

const rule = (doc: Doc, weight = 0.6, color = INK) => {
  doc.lineWidth(weight).strokeColor(color).moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke();
};

const label = (doc: Doc, text: string, color = VERMILION) => {
  doc.font("Helvetica-Bold").fontSize(8).fillColor(color).text(text, LEFT, doc.y, { characterSpacing: 1.5 });
};

function cell(doc: Doc, col: Column, text: string, y: number) {
  doc.text(text, col.x, y, { width: col.width, align: col.align ?? "left", lineBreak: false });
}

/**
 * Trim to the column width under the current font, so a long task title is
 * elided rather than wrapped — a wrapped cell would overprint the next row,
 * since the table is ruled on a fixed row height.
 */
function fit(doc: Doc, text: string, width: number): string {
  if (doc.widthOfString(text) <= width) return text;
  let s = text;
  while (s.length > 1 && doc.widthOfString(`${s}…`) > width) s = s.slice(0, -1);
  return `${s.replace(/[\s·]+$/, "")}…`;
}

/** Start a fresh page when `needed` points would run past the bottom margin. */
function ensureRoom(doc: Doc, needed: number): boolean {
  if (doc.y + needed <= CONTENT_BOTTOM) return false;
  doc.addPage();
  doc.y = MARGIN;
  return true;
}

function headRow(doc: Doc, cols: Record<string, Column>, labels: Record<string, string>) {
  const y = doc.y;
  doc.font("Helvetica-Bold").fontSize(7).fillColor(INK_MUTED);
  for (const [key, text] of Object.entries(labels)) if (cols[key]) cell(doc, cols[key], text, y);
  doc.y = y + 12;
  rule(doc, 0.3, HAIRLINE);
  doc.y += 5;
}

/**
 * The verification QR.
 *
 * Drawn as vector rectangles rather than an embedded bitmap: a module grid is a
 * few hundred rects, it stays crisp at any zoom or print resolution, and it keeps
 * the PDF free of an image codec. Each rect is fattened by a sixth of a point so
 * neighbouring modules meet instead of showing a hairline seam.
 */
function drawQr(doc: Doc, text: string, x: number, y: number, box: number) {
  const code = encodeQr(text, { ecc: "M" });
  const quiet = 2;
  const step = box / (code.size + quiet * 2);
  doc.save();
  doc.rect(x, y, box, box).fill("#FFFFFF");
  doc.fillColor(INK);
  for (let row = 0; row < code.size; row += 1) {
    for (let col = 0; col < code.size; col += 1) {
      if (code.modules[row][col]) doc.rect(x + (col + quiet) * step, y + (row + quiet) * step, step + 0.16, step + 0.16);
    }
  }
  doc.fill();
  doc.restore();
}

/**
 * "Certified by PTD" — the block that makes the document checkable.
 *
 * It states four things and nothing else: which invoice this is, the hash of the
 * frozen record behind it, which published key signed that hash, and where to
 * check all three. The hash is printed twice — a short group anyone can read out
 * loud, and the full digest for a machine.
 *
 * The prose says what the link does and does not show, because a document that
 * travels needs to be honest about that: opening it proves the invoice is
 * genuine, and the particulars come only after a code emailed to a named
 * recipient (server/invoices/access.ts).
 */
function certification(doc: Doc, cert: Certification, numeral: string, sessions: number) {
  ensureRoom(doc, 170);
  label(doc, `${numeral}  CERTIFIED BY PTD`);
  doc.moveDown(0.4);
  rule(doc, 0.4);
  doc.moveDown(0.5);

  const top = doc.y;
  const qrBox = 96;
  const qrX = RIGHT - qrBox;
  const textWidth = qrX - LEFT - 18;

  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor(INK_MUTED)
    .text(
      `Plan Track Done recorded ${sessions} ${sessions === 1 ? "session" : "sessions"} as the work happened and froze them into a signed record when this invoice was issued. Anyone holding this document can confirm at the link below that it is authentic and that the underlying entries have not been altered since; the link shows no names, figures or line items. The details are released only to a named recipient, after a code emailed to their own address.`,
      LEFT,
      top,
      { width: textWidth }
    );

  let y = doc.y + 6;
  const field = (heading: string, value: string, opts: { mono?: boolean; size?: number; accent?: boolean } = {}) => {
    doc.font("Helvetica-Bold").fontSize(6.5).fillColor(INK_MUTED).text(heading, LEFT, y, { characterSpacing: 1.2, width: textWidth });
    doc
      .font(opts.mono ? "Courier" : "Helvetica")
      .fontSize(opts.size ?? 9)
      .fillColor(opts.accent ? VERMILION : INK)
      .text(value, LEFT, y + 8, { width: textWidth });
    y = doc.y + 3;
  };

  field("REFERENCE", cert.reference, { mono: true });
  field("CONTENT HASH", `${shortHash(cert.contentHash)}   ·   sha-256`, { mono: true, accent: true });
  doc.font("Courier").fontSize(6).fillColor(INK_MUTED).text(cert.contentHash, LEFT, y, { width: textWidth });
  y = doc.y + 3;
  field("SIGNATURE", `${cert.algorithm} · key #${cert.keyId}`, { mono: true, size: 8 });
  field("VERIFY AT", cert.verifyUrl, { mono: true, size: 7.5 });
  if (cert.voided) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(VERMILION).text("VOIDED — this invoice has been withdrawn", LEFT, y, { width: textWidth, characterSpacing: 1 });
    y = doc.y + 3;
  }

  drawQr(doc, cert.verifyUrl, qrX, top, qrBox);
  doc.font("Helvetica").fontSize(6.5).fillColor(INK_MUTED).text("scan to verify", qrX, top + qrBox + 3, { width: qrBox, align: "center", characterSpacing: 0.8 });

  doc.y = Math.max(y, top + qrBox + 16);
}

function colophon(doc: Doc, orgName: string) {
  doc.moveDown(1.2);
  ensureRoom(doc, 40);
  rule(doc, 0.3, HAIRLINE);
  doc.moveDown(0.3);
  doc
    .font("Helvetica-Oblique")
    .fontSize(9)
    .fillColor(INK_MUTED)
    .text(
      `Issued by ${orgName} through Plan Track Done · a daily chronicle of hours spent, by hand and by machine.`,
      LEFT,
      doc.y,
      { align: "center", width: RIGHT - LEFT }
    );
}

function toBuffer(compose: (doc: Doc) => void, info: PDFKit.DocumentInfo): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: MARGIN, info });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      compose(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Render the customer invoice. Resolves with the complete PDF as a Buffer;
 * rejects if PDFKit fails mid-stream, so a caller never sends a half document.
 */
export function renderInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return toBuffer((doc) => composeCustomer(doc, data), {
    Title: `Invoice ${data.reference} — ${data.customer.name}`,
    Author: data.orgName,
    Subject: `Recorded work, ${data.period.label}`,
  });
}

/** Render the contractor invoice: the external member is the issuer. */
export function renderContractorInvoicePdf(data: ContractorInvoiceData): Promise<Buffer> {
  return toBuffer((doc) => composeContractor(doc, data), {
    Title: `Invoice ${data.reference} — ${data.contractor.billingName ?? data.contractor.name}`,
    Author: data.contractor.billingName ?? data.contractor.name,
    Subject: `Contracted work for ${data.orgName}, ${data.period.label}`,
  });
}

function composeCustomer(doc: Doc, data: InvoiceData) {
  const { customer, period, totals } = data;
  const currency = data.currency ?? customer.currency ?? "USD";
  const priced = totals.amountCents !== null;
  const cols = priced ? COLS_PRICED : COLS;

  /* Masthead */
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(VERMILION)
    .text(`VOL. I  ·  INVOICE  ·  ${data.reference}`, LEFT, doc.y, { characterSpacing: 2 });
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(28).fillColor(INK).text(`${data.orgName}.`, LEFT, doc.y);
  doc.moveDown(0.2);
  rule(doc);
  doc.moveDown(0.8);

  /* Meta block — two columns, addressee on the left, period on the right */
  const metaTop = doc.y;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(INK_MUTED).text("RENDERED TO", LEFT, metaTop, { characterSpacing: 1.5 });
  doc.font("Helvetica").fontSize(13).fillColor(INK).text(customer.name, LEFT, metaTop + 14, { width: 240 });
  if (customer.billingAddress) {
    doc.font("Helvetica").fontSize(10).fillColor(INK_MUTED).text(customer.billingAddress, LEFT, metaTop + 34, { width: 240 });
  }
  if (customer.billingEmail) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(INK_MUTED).text(customer.billingEmail, LEFT, doc.y + 2, { width: 240 });
  }
  const leftBottom = doc.y;

  doc.font("Helvetica-Bold").fontSize(8).fillColor(INK_MUTED).text("PERIOD", 360, metaTop, { characterSpacing: 1.5 });
  doc.font("Helvetica").fontSize(13).fillColor(INK).text(period.label, 360, metaTop + 14);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(INK_MUTED).text("ISSUED", 360, metaTop + 44, { characterSpacing: 1.5 });
  doc.font("Helvetica").fontSize(11).fillColor(INK).text(format(new Date(data.issuedAt), "d MMMM yyyy"), 360, metaTop + 58);

  doc.y = Math.max(leftBottom, metaTop + 84);
  doc.moveDown(1.2);

  /* I — the human / agent split, two lines, the point of the document */
  label(doc, "I.  HUMAN  /  AGENT");
  doc.moveDown(0.4);
  rule(doc, 0.4);
  doc.moveDown(0.5);

  const summaryLine = (heading: string, minutes: number, sessions: number, extra: string | null, color: string) => {
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(color).text(heading, LEFT, y, { width: 90, characterSpacing: 1.2 });
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(INK_MUTED)
      .text(`${sessions} ${sessions === 1 ? "session" : "sessions"}${extra ? `  ·  ${extra}` : ""}`, 150, y, { width: 250 });
    doc.font("Courier").fontSize(12).fillColor(INK).text(`${hm(minutes)}`, 410, y - 1, { width: 60, align: "right" });
    doc.font("Courier").fontSize(9).fillColor(INK_MUTED).text(`${hoursOf(minutes)} h`, 474, y + 1, { width: 65, align: "right" });
    doc.y = y + 18;
  };

  summaryLine("HUMAN", totals.humanMinutes, totals.humanSessions, null, INK);
  summaryLine("AGENT", totals.agentMinutes, totals.agentSessions, `${thousands(totals.tokens)} tokens  ·  ${money(totals.costUsd)}`, VERMILION);

  doc.moveDown(0.6);

  /* II — the ruled table, one line per stream × task */
  label(doc, "II.  RECORDED WORK");
  doc.moveDown(0.4);
  rule(doc, 0.4);
  doc.moveDown(0.4);
  const labels = { num: "#", line: "STREAM  ·  TASK", source: "SOURCE", sessions: "SESS", human: "HUMAN", agent: "AGENT", total: "TOTAL", amount: "AMOUNT" };
  headRow(doc, cols, labels);

  let idx = 0;
  for (const line of data.lines) {
    idx += 1;
    if (ensureRoom(doc, ROW_HEIGHT + 4)) headRow(doc, cols, labels);
    const y = doc.y;
    const title = line.taskTitle ? `${line.streamName} · ${line.taskTitle}` : line.streamName;
    doc.font("Courier").fontSize(9).fillColor(INK_MUTED);
    cell(doc, cols.num, String(idx).padStart(2, "0"), y);
    doc.font("Helvetica").fontSize(9).fillColor(INK);
    cell(doc, cols.line, fit(doc, title, cols.line.width), y);
    doc.font("Helvetica-Bold").fontSize(7).fillColor(line.source === "human" ? INK_MUTED : VERMILION);
    cell(doc, cols.source, line.source.toUpperCase(), y + 1);
    doc.font("Courier").fontSize(9).fillColor(INK);
    cell(doc, cols.sessions, String(line.sessions), y);
    cell(doc, cols.human, line.humanMinutes > 0 ? hm(line.humanMinutes) : "–", y);
    doc.fillColor(line.agentMinutes > 0 ? VERMILION : INK);
    cell(doc, cols.agent, line.agentMinutes > 0 ? hm(line.agentMinutes) : "–", y);
    doc.fillColor(INK);
    cell(doc, cols.total, hm(line.minutes), y);
    if (priced) cell(doc, cols.amount, moneyFromCents(line.amountCents, currency), y);
    doc.y = y + ROW_HEIGHT;
  }

  if (data.lines.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(11).fillColor(INK_MUTED).text("No recorded work sessions in this period.", LEFT, doc.y + 4);
    doc.moveDown(0.6);
  }

  doc.moveDown(0.2);
  ensureRoom(doc, 96);
  rule(doc);
  doc.moveDown(0.5);

  /* III — the tally */
  label(doc, "III.  TOTAL RENDERED");
  doc.moveDown(0.5);
  const totalY = doc.y;
  const stat = (heading: string, value: string, x: number, width: number, opts: { mono?: boolean; accent?: boolean; size?: number } = {}) => {
    doc.font("Helvetica").fontSize(9).fillColor(INK_MUTED).text(heading, x, totalY, { width, characterSpacing: 0.6 });
    doc
      .font(opts.mono ? "Courier" : "Helvetica")
      .fontSize(opts.size ?? 14)
      .fillColor(opts.accent ? VERMILION : INK)
      .text(value, x, totalY + 12, { width });
  };
  stat("Sessions", String(totals.sessions), LEFT, 80);
  stat("Human", hm(totals.humanMinutes), 140, 80, { mono: true });
  stat("Agent", hm(totals.agentMinutes), 226, 80, { mono: true, accent: true });
  stat("Hours", hoursOf(totals.minutes), 312, 80, { mono: true });
  doc.font("Helvetica").fontSize(9).fillColor(INK_MUTED).text(priced ? "Amount" : "Minutes", 400, totalY, { width: 139, align: "right" });
  doc
    .font("Courier")
    .fontSize(priced ? 19 : 22)
    .fillColor(VERMILION)
    .text(priced ? moneyFromCents(totals.amountCents, currency) : thousands(totals.minutes), 400, totalY + 10, { width: 139, align: "right" });

  doc.y = totalY + 46;
  doc.moveDown(1);

  /* IV — the agent's API spend, carried through at face value */
  ensureRoom(doc, 150);
  label(doc, "IV.  AGENT API COST");
  doc.moveDown(0.4);
  rule(doc, 0.4);
  doc.moveDown(0.5);
  const passY = doc.y;
  doc.font("Helvetica").fontSize(10).fillColor(INK).text("Agent API cost (pass-through)", LEFT, passY, { width: 300 });
  doc
    .font("Helvetica-Oblique")
    .fontSize(8)
    .fillColor(INK_MUTED)
    .text(
      `${thousands(totals.tokens)} tokens over ${totals.agentSessions} agent ${totals.agentSessions === 1 ? "session" : "sessions"}; billed at cost, no markup.`,
      LEFT,
      passY + 14,
      { width: 320 }
    );
  doc.font("Courier").fontSize(16).fillColor(VERMILION).text(money(totals.costUsd), 380, passY - 2, { width: 159, align: "right" });
  doc.y = passY + 34;
  doc.moveDown(0.4);
  doc
    .font("Helvetica-Oblique")
    .fontSize(9)
    .fillColor(INK_MUTED)
    .text(
      priced
        ? `Hours are priced at the rate recorded for each stream, falling back to the customer's rate; API cost is stated separately and passed through at face value.`
        : "No hourly rate is recorded for this customer or its streams, so this document states hours rendered and API cost incurred; monetary terms are settled outside it.",
      LEFT,
      doc.y,
      { width: RIGHT - LEFT }
    );

  if (data.certification) certification(doc, data.certification, "V.", totals.sessions);
  colophon(doc, data.orgName);
}

function composeContractor(doc: Doc, data: ContractorInvoiceData) {
  const { contractor, period, totals, currency } = data;
  const issuer = contractor.billingName ?? contractor.name;
  const priced = totals.amountCents !== null;

  /* Masthead — the contractor is the issuer here, so their name is the title */
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(VERMILION)
    .text(`VOL. I  ·  CONTRACTOR INVOICE  ·  ${data.reference}`, LEFT, doc.y, { characterSpacing: 2 });
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(26).fillColor(INK).text(`${issuer}.`, LEFT, doc.y, { width: RIGHT - LEFT });
  doc.moveDown(0.2);
  rule(doc);
  doc.moveDown(0.8);

  const metaTop = doc.y;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(INK_MUTED).text("FROM", LEFT, metaTop, { characterSpacing: 1.5 });
  doc.font("Helvetica").fontSize(12).fillColor(INK).text(issuer, LEFT, metaTop + 14, { width: 250 });
  if (contractor.billingName && contractor.billingName !== contractor.name) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(INK_MUTED).text(contractor.name, LEFT, doc.y + 1, { width: 250 });
  }
  if (contractor.billingAddress) {
    doc.font("Helvetica").fontSize(9.5).fillColor(INK_MUTED).text(contractor.billingAddress, LEFT, doc.y + 2, { width: 250 });
  }
  if (contractor.taxId) {
    doc.font("Courier").fontSize(8.5).fillColor(INK_MUTED).text(`TAX ID  ${contractor.taxId}`, LEFT, doc.y + 2, { width: 250 });
  }
  const leftBottom = doc.y;

  doc.font("Helvetica-Bold").fontSize(8).fillColor(INK_MUTED).text("BILL TO", 340, metaTop, { characterSpacing: 1.5 });
  doc.font("Helvetica").fontSize(12).fillColor(INK).text(data.orgName, 340, metaTop + 14, { width: 199 });
  doc.font("Helvetica-Bold").fontSize(8).fillColor(INK_MUTED).text("PERIOD", 340, metaTop + 40, { characterSpacing: 1.5 });
  doc.font("Helvetica").fontSize(12).fillColor(INK).text(period.label, 340, metaTop + 52);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(INK_MUTED).text("ISSUED", 340, metaTop + 76, { characterSpacing: 1.5 });
  doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(format(new Date(data.issuedAt), "d MMMM yyyy"), 340, metaTop + 88);

  doc.y = Math.max(leftBottom, metaTop + 106);
  doc.moveDown(1);

  /* I — the terms: rate, hours, amount */
  label(doc, "I.  TERMS");
  doc.moveDown(0.4);
  rule(doc, 0.4);
  doc.moveDown(0.5);
  const termsY = doc.y;
  const term = (heading: string, value: string, x: number, width: number, opts: { mono?: boolean; accent?: boolean; size?: number } = {}) => {
    doc.font("Helvetica").fontSize(8.5).fillColor(INK_MUTED).text(heading, x, termsY, { width, characterSpacing: 0.6 });
    doc
      .font(opts.mono ? "Courier" : "Helvetica")
      .fontSize(opts.size ?? 14)
      .fillColor(opts.accent ? VERMILION : INK)
      .text(value, x, termsY + 12, { width });
  };
  term("Rate", rateLabel(data.rate, currency), LEFT, 150, { mono: true, size: 12 });
  term("Hours", hoursOf(totals.minutes), 216, 80, { mono: true });
  term("Sessions", String(totals.sessions), 302, 70);
  doc.font("Helvetica").fontSize(8.5).fillColor(INK_MUTED).text("Amount due", 380, termsY, { width: 159, align: "right" });
  doc
    .font("Courier")
    .fontSize(20)
    .fillColor(VERMILION)
    .text(priced ? moneyFromCents(totals.amountCents, currency) : `${hoursOf(totals.minutes)} h`, 380, termsY + 10, { width: 159, align: "right" });
  doc.y = termsY + 44;
  doc.moveDown(0.3);
  doc
    .font("Helvetica-Oblique")
    .fontSize(8.5)
    .fillColor(INK_MUTED)
    .text(
      data.onlyApproved
        ? "Only entries approved by a manager are billed on this invoice."
        : "Every recorded entry in the period is billed; approval is not required for this member.",
      LEFT,
      doc.y,
      { width: RIGHT - LEFT }
    );
  doc.moveDown(0.8);

  /* II — one line per day × stream × task */
  label(doc, "II.  RECORDED WORK");
  doc.moveDown(0.4);
  rule(doc, 0.4);
  doc.moveDown(0.4);
  const labels = { num: "#", date: "DATE", line: "STREAM  ·  TASK", source: "SOURCE", sessions: "SESS", total: "HOURS", amount: "AMOUNT" };
  headRow(doc, COLS_CONTRACTOR, labels);

  let idx = 0;
  for (const line of data.lines) {
    idx += 1;
    if (ensureRoom(doc, ROW_HEIGHT + 4)) headRow(doc, COLS_CONTRACTOR, labels);
    const y = doc.y;
    const title = line.taskTitle
      ? `${line.taskKey ? `${line.taskKey} ` : ""}${line.taskTitle}`
      : line.streamName ?? "Unassigned";
    doc.font("Courier").fontSize(9).fillColor(INK_MUTED);
    cell(doc, COLS_CONTRACTOR.num, String(idx).padStart(2, "0"), y);
    cell(doc, COLS_CONTRACTOR.date, line.dateLabel, y);
    doc.font("Helvetica").fontSize(9).fillColor(INK);
    cell(doc, COLS_CONTRACTOR.line, fit(doc, title, COLS_CONTRACTOR.line.width), y);
    doc.font("Helvetica-Bold").fontSize(7).fillColor(line.source === "human" ? INK_MUTED : VERMILION);
    cell(doc, COLS_CONTRACTOR.source, line.source.toUpperCase(), y + 1);
    doc.font("Courier").fontSize(9).fillColor(INK);
    cell(doc, COLS_CONTRACTOR.sessions, String(line.sessions), y);
    cell(doc, COLS_CONTRACTOR.total, hm(line.minutes), y);
    cell(doc, COLS_CONTRACTOR.amount, priced ? moneyFromCents(line.amountCents, currency) : "–", y);
    doc.y = y + ROW_HEIGHT;
  }

  if (data.lines.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(11).fillColor(INK_MUTED).text("No billable sessions in this period.", LEFT, doc.y + 4);
    doc.moveDown(0.6);
  }

  doc.moveDown(0.2);
  ensureRoom(doc, 80);
  rule(doc);
  doc.moveDown(0.5);

  /* III — the tally, with the human/agent split kept visible */
  label(doc, "III.  TOTAL DUE");
  doc.moveDown(0.5);
  const totalY = doc.y;
  doc.font("Helvetica").fontSize(9).fillColor(INK_MUTED).text("Human", LEFT, totalY, { width: 80 });
  doc.font("Courier").fontSize(13).fillColor(INK).text(hm(totals.humanMinutes), LEFT, totalY + 12, { width: 80 });
  doc.font("Helvetica").fontSize(9).fillColor(INK_MUTED).text("Agent", 140, totalY, { width: 80 });
  doc.font("Courier").fontSize(13).fillColor(VERMILION).text(hm(totals.agentMinutes), 140, totalY + 12, { width: 80 });
  doc.font("Helvetica").fontSize(9).fillColor(INK_MUTED).text("Total hours", 226, totalY, { width: 90 });
  doc.font("Courier").fontSize(13).fillColor(INK).text(hoursOf(totals.minutes), 226, totalY + 12, { width: 90 });
  doc.font("Helvetica").fontSize(9).fillColor(INK_MUTED).text(priced ? `${rateLabel(data.rate, currency)} × ${hoursOf(totals.minutes)} h` : "no rate recorded", 330, totalY, { width: 209, align: "right" });
  doc
    .font("Courier")
    .fontSize(22)
    .fillColor(VERMILION)
    .text(priced ? moneyFromCents(totals.amountCents, currency) : `${hoursOf(totals.minutes)} h`, 330, totalY + 10, { width: 209, align: "right" });
  doc.y = totalY + 46;

  if (totals.tokens > 0 || totals.costUsd > 0) {
    doc.moveDown(0.8);
    ensureRoom(doc, 70);
    label(doc, "IV.  AGENT API COST");
    doc.moveDown(0.4);
    rule(doc, 0.4);
    doc.moveDown(0.5);
    const passY = doc.y;
    doc.font("Helvetica").fontSize(9.5).fillColor(INK).text("Model tokens consumed while this work was done", LEFT, passY, { width: 320 });
    doc
      .font("Helvetica-Oblique")
      .fontSize(8)
      .fillColor(INK_MUTED)
      .text(`${thousands(totals.tokens)} tokens; stated for the record, not added to the amount due.`, LEFT, passY + 13, { width: 320 });
    doc.font("Courier").fontSize(14).fillColor(VERMILION).text(money(totals.costUsd), 380, passY - 1, { width: 159, align: "right" });
    doc.y = passY + 32;
  }

  doc.moveDown(0.8);
  if (data.certification) certification(doc, data.certification, totals.tokens > 0 || totals.costUsd > 0 ? "V." : "IV.", totals.sessions);
  colophon(doc, data.orgName);
}

/* ── Assembling one invoice from the ledger ──────────────────────────── */

/**
 * Read a customer's month out of the ledger and shape it for both the preview
 * action and the PDF route, so the document a customer receives can never say
 * something different from the preview a manager approved.
 *
 * Billing follows the stream: a session bills to the customer of the stream it
 * sits in, falling back to the session's own denormalised customerId when it was
 * logged without a stream. The rate follows the stream too — a stream's own
 * `hourly_rate` overrides the customer's.
 */
export async function buildInvoiceData(args: {
  orgId: number;
  orgName: string;
  customerId: number;
  month: number;
  year: number;
  invoiceId?: number | null;
  status?: string;
  issuedAt?: Date;
  certification?: Certification;
}): Promise<InvoiceData> {
  const [customer] = await db
    .select({
      id: customers.id,
      name: customers.name,
      billingAddress: customers.billingAddress,
      billingEmail: customers.billingEmail,
      hourlyRate: customers.hourlyRate,
      currency: customers.currency,
    })
    .from(customers)
    .where(and(eq(customers.id, args.customerId), eq(customers.orgId, args.orgId)))
    .limit(1);
  if (!customer) throw new ActionError("not_found", `Customer ${args.customerId} is not in this organization`);

  const { from, to } = monthWindow(args.month, args.year);
  const rows = await billableEntries({ orgId: args.orgId, from, to });
  const mine = rows.filter((r) => (r.streamId !== null ? r.streamCustomerId : r.customerId) === args.customerId);
  const rateOf = (row: { streamHourlyRate: number | null }): number | null => row.streamHourlyRate ?? customer.hourlyRate ?? null;
  const { lines, totals } = foldInvoiceLines(mine, rateOf);
  const currency = customer.currency ?? "USD";

  const entries = mine.map((row) => {
    const line = snapshotLine(row);
    const rate = rateOf(row);
    return { ...line, rate, amountCents: amountCentsFor(line.minutes, rate) };
  });

  return {
    orgName: args.orgName,
    invoiceId: args.invoiceId ?? null,
    reference: invoiceReference(args.year, args.month, args.invoiceId ?? null),
    status: args.status ?? "preview",
    customer,
    period: { month: args.month, year: args.year, label: monthLabel(args.month, args.year), from: from.toISOString(), to: to.toISOString() },
    lines,
    totals,
    issuedAt: (args.issuedAt ?? new Date()).toISOString(),
    currency,
    entries,
    alreadyInvoiced: mine.filter((r) => Boolean(r.lockedInvoiceId)).map((r) => ({ entryId: r.id, invoiceId: r.lockedInvoiceId as number })),
    ...(args.certification ? { certification: args.certification } : {}),
  };
}

/**
 * Re-draw an already-issued customer invoice from its own snapshot rather than
 * from the ledger.
 *
 * Once an invoice is certified, the PDF has to keep saying what was signed — the
 * hash printed on it is the hash of *this* record. The live rows are locked
 * anyway, so the two agree; rendering from the snapshot means they cannot stop
 * agreeing even if a row is later unlocked by a void.
 */
export function customerDataFromSnapshot(snapshot: InvoiceSnapshot, args: { invoiceId: number; status: string; certification?: Certification }): InvoiceData {
  const rows = snapshot.lines.map((line) => ({ ...line, isBreak: false }));
  const { lines, totals } = foldInvoiceLines(rows, (row) => row.rate ?? snapshot.rate ?? null);
  return {
    orgName: snapshot.org.name,
    invoiceId: args.invoiceId,
    reference: snapshot.reference,
    status: args.status,
    customer: {
      id: snapshot.customer?.id ?? 0,
      name: snapshot.customer?.name ?? "(customer removed)",
      billingAddress: snapshot.customer?.billingAddress ?? null,
      billingEmail: snapshot.customer?.billingEmail ?? null,
      hourlyRate: snapshot.rate,
      currency: snapshot.currency,
    },
    period: snapshot.period,
    lines,
    totals,
    issuedAt: snapshot.issuedAt,
    currency: snapshot.currency,
    entries: snapshot.lines,
    ...(args.certification ? { certification: args.certification } : {}),
  };
}
