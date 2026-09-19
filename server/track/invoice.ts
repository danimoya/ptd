/**
 * The monthly invoice, as a PDF.
 *
 * Ported from TimeTracker's response-coupled `/api/generate-invoice` handler:
 * the editorial ledger layout survives — masthead, ruled table, vermilion
 * section labels, a monospace duration column and an italic colophon — but the
 * renderer no longer knows what an HTTP response is. `renderInvoicePdf` takes
 * data and resolves to a Buffer, so the same function serves the download
 * route, a future email attachment and a test that only wants to know the bytes
 * start with `%PDF`.
 *
 * Two things are new, and they are the reason this file exists at all rather
 * than the old handler being moved: a line's **source** (human, agent or both)
 * is a column, and the agent's API spend is carried through to its own section
 * as a pass-through cost. PTD bills for hours that a human *or* a machine put
 * in, and an invoice that hides which is which is the wrong document.
 *
 * There are no hourly rates in the schema yet, so nothing here multiplies hours
 * by money. The document states hours, and states agent API cost separately as
 * what it is: a cost incurred, passed through at face value.
 */

import PDFDocument from "pdfkit";
import { format } from "date-fns";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../../db";
import { customers, timeEntries } from "../../db/schema";
import { ActionError } from "../actions/registry";
import { minutesFrom, num, usd } from "./aggregate";
import { customerOf, fetchReportRows, isAgentRow, rowSeconds, type ReportRow } from "./reports";

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

/* ── Data ────────────────────────────────────────────────────────────── */

export type LineSource = "human" | "agent" | "mixed";

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
}

export interface InvoiceCustomer {
  id: number;
  name: string;
  billingAddress: string | null;
  billingEmail: string | null;
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
}

const lineKey = (row: ReportRow) => `${row.streamId ?? "-"}:${row.taskId ?? "-"}`;

/**
 * One line per stream × task, which is the grain a customer can actually read:
 * "Security audit — Rotate leaked credentials" rather than forty timestamps.
 * Breaks never bill, and a still-running session has no duration to bill.
 */
export function foldInvoiceLines(rows: ReportRow[]): { lines: InvoiceLine[]; totals: InvoiceTotals } {
  const acc = new Map<string, LineAcc>();
  for (const row of rows) {
    if (row.isBreak) continue;
    const seconds = rowSeconds(row);
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
      } satisfies LineAcc);
    cur.sessions += 1;
    if (isAgentRow(row)) {
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
      return {
        streamId: a.streamId,
        streamName: a.streamName,
        taskId: a.taskId,
        taskTitle: a.taskTitle,
        sessions: a.sessions,
        humanMinutes,
        agentMinutes,
        minutes: humanMinutes + agentMinutes,
        tokens: Math.round(a.tokens),
        costUsd: usd(a.cost),
        source: (a.agentSessions === 0 ? "human" : a.humanSessions === 0 ? "agent" : "mixed") as LineSource,
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
    }),
    { sessions: 0, humanSessions: 0, agentSessions: 0, humanMinutes: 0, agentMinutes: 0, minutes: 0, hours: 0, tokens: 0, costUsd: 0 }
  );
  totals.minutes = totals.humanMinutes + totals.agentMinutes;
  totals.hours = Math.round((totals.minutes / 60) * 100) / 100;
  totals.costUsd = usd(totals.costUsd);

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

export const money = (n: number): string => `$${n.toFixed(2)}`;

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
  while (s.length > 1 && doc.widthOfString(`${s}\u2026`) > width) s = s.slice(0, -1);
  return `${s.replace(/[\s\u00b7]+$/, "")}\u2026`;
}

/** Start a fresh page when `needed` points would run past the bottom margin. */
function ensureRoom(doc: Doc, needed: number): boolean {
  if (doc.y + needed <= CONTENT_BOTTOM) return false;
  doc.addPage();
  doc.y = MARGIN;
  return true;
}

function tableHead(doc: Doc) {
  const y = doc.y;
  doc.font("Helvetica-Bold").fontSize(7).fillColor(INK_MUTED);
  cell(doc, COLS.num, "#", y);
  cell(doc, COLS.line, "STREAM  ·  TASK", y);
  cell(doc, COLS.source, "SOURCE", y);
  cell(doc, COLS.sessions, "SESS", y);
  cell(doc, COLS.human, "HUMAN", y);
  cell(doc, COLS.agent, "AGENT", y);
  cell(doc, COLS.total, "TOTAL", y);
  doc.y = y + 12;
  rule(doc, 0.3, HAIRLINE);
  doc.y += 5;
}

/**
 * Render the invoice. Resolves with the complete PDF as a Buffer; rejects if
 * PDFKit fails mid-stream, so a caller never sends a half-written document.
 */
export function renderInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: MARGIN,
      info: {
        Title: `Invoice ${data.reference} — ${data.customer.name}`,
        Author: data.orgName,
        Subject: `Recorded work, ${data.period.label}`,
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      compose(doc, data);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function compose(doc: Doc, data: InvoiceData) {
  const { customer, period, totals } = data;

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

  const summaryLine = (
    heading: string,
    minutes: number,
    sessions: number,
    extra: string | null,
    color: string
  ) => {
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
  summaryLine(
    "AGENT",
    totals.agentMinutes,
    totals.agentSessions,
    `${thousands(totals.tokens)} tokens  ·  ${money(totals.costUsd)}`,
    VERMILION
  );

  doc.moveDown(0.6);

  /* II — the ruled table, one line per stream × task */
  label(doc, "II.  RECORDED WORK");
  doc.moveDown(0.4);
  rule(doc, 0.4);
  doc.moveDown(0.4);
  tableHead(doc);

  let idx = 0;
  for (const line of data.lines) {
    idx += 1;
    if (ensureRoom(doc, ROW_HEIGHT + 4)) tableHead(doc);
    const y = doc.y;
    const title = line.taskTitle ? `${line.streamName} · ${line.taskTitle}` : line.streamName;
    doc.font("Courier").fontSize(9).fillColor(INK_MUTED);
    cell(doc, COLS.num, String(idx).padStart(2, "0"), y);
    doc.font("Helvetica").fontSize(9).fillColor(INK);
    cell(doc, COLS.line, fit(doc, title, COLS.line.width), y);
    doc
      .font("Helvetica-Bold")
      .fontSize(7)
      .fillColor(line.source === "human" ? INK_MUTED : VERMILION);
    cell(doc, COLS.source, line.source.toUpperCase(), y + 1);
    doc.font("Courier").fontSize(9).fillColor(INK);
    cell(doc, COLS.sessions, String(line.sessions), y);
    cell(doc, COLS.human, line.humanMinutes > 0 ? hm(line.humanMinutes) : "–", y);
    doc.fillColor(line.agentMinutes > 0 ? VERMILION : INK);
    cell(doc, COLS.agent, line.agentMinutes > 0 ? hm(line.agentMinutes) : "–", y);
    doc.fillColor(INK);
    cell(doc, COLS.total, hm(line.minutes), y);
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
  stat("Minutes", thousands(totals.minutes), 150, 90, { mono: true });
  stat("Human", hm(totals.humanMinutes), 250, 80, { mono: true });
  stat("Agent", hm(totals.agentMinutes), 336, 80, { mono: true, accent: true });
  doc.font("Helvetica").fontSize(9).fillColor(INK_MUTED).text("Hours", 430, totalY, { width: 109, align: "right" });
  doc.font("Courier").fontSize(22).fillColor(VERMILION).text(hoursOf(totals.minutes), 430, totalY + 10, { width: 109, align: "right" });

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
    .text(`${thousands(totals.tokens)} tokens over ${totals.agentSessions} agent ${totals.agentSessions === 1 ? "session" : "sessions"}; billed at cost, no markup.`, LEFT, passY + 14, { width: 320 });
  doc.font("Courier").fontSize(16).fillColor(VERMILION).text(money(totals.costUsd), 380, passY - 2, { width: 159, align: "right" });
  doc.y = passY + 34;
  doc.moveDown(0.4);
  doc
    .font("Helvetica-Oblique")
    .fontSize(9)
    .fillColor(INK_MUTED)
    .text("No hourly rate is recorded in this ledger, so this document states hours rendered and API cost incurred; monetary terms are settled outside it.", LEFT, doc.y, { width: RIGHT - LEFT });

  /* Colophon */
  doc.moveDown(1.6);
  ensureRoom(doc, 40);
  rule(doc, 0.3, HAIRLINE);
  doc.moveDown(0.3);
  doc
    .font("Helvetica-Oblique")
    .fontSize(9)
    .fillColor(INK_MUTED)
    .text(
      `Issued by ${data.orgName} through Plan Track Done · a daily chronicle of hours spent, by hand and by machine.`,
      LEFT,
      doc.y,
      { align: "center", width: RIGHT - LEFT }
    );
}

/* ── Assembling one invoice from the ledger ──────────────────────────── */

/**
 * Read a customer's month out of the ledger and shape it for both the preview
 * action and the PDF route, so the document a customer receives can never say
 * something different from the preview a manager approved.
 *
 * Billing follows the stream: a session bills to the customer of the stream it
 * sits in, falling back to the session's own denormalised customerId when it was
 * logged without a stream (see `customerOf`).
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
}): Promise<InvoiceData> {
  const [customer] = await db
    .select({ id: customers.id, name: customers.name, billingAddress: customers.billingAddress, billingEmail: customers.billingEmail })
    .from(customers)
    .where(and(eq(customers.id, args.customerId), eq(customers.orgId, args.orgId)))
    .limit(1);
  if (!customer) throw new ActionError("not_found", `Customer ${args.customerId} is not in this organization`);

  const { from, to } = monthWindow(args.month, args.year);
  const rows = await fetchReportRows([eq(timeEntries.orgId, args.orgId), gte(timeEntries.checkIn, from), lte(timeEntries.checkIn, to)]);
  const mine = rows.filter((r) => customerOf(r) === args.customerId);
  const { lines, totals } = foldInvoiceLines(mine);

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
  };
}
