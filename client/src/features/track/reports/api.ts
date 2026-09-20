/**
 * The reporting surface's read vocabulary.
 *
 * Like the rest of Track, every call goes through the action registry, so the
 * numbers this page draws are the same numbers an agent gets over MCP. The one
 * exception is the invoice PDF: bytes, not JSON, so it comes off a plain
 * authenticated GET and is handed to the browser as a blob URL.
 */

import { api, callAction, getAuthHeader } from "@/lib/api";
import type { BySource, EntrySource } from "../api";

export type GroupBy = "day" | "week" | "month";

export interface HumanBucket {
  minutes: number;
}

export interface AgentBucket {
  minutes: number;
  tokens: number;
  costUsd: number;
}

export interface StreamSplit {
  streamId: number | null;
  streamName: string | null;
  streamColor: string | null;
  sessions: number;
  minutes: number;
  human: HumanBucket;
  agent: AgentBucket;
}

export interface Bucket {
  key: string;
  label: string;
  from: string;
  to: string;
  minutes: number;
  breakMinutes: number;
  sessions: number;
  human: HumanBucket;
  agent: AgentBucket;
  byStream: StreamSplit[];
}

export interface RangeReport {
  from: string;
  to: string;
  groupBy: GroupBy;
  includeBreaks: boolean;
  minutes: number;
  breakMinutes: number;
  sessions: number;
  activeDays: number;
  human: HumanBucket;
  agent: AgentBucket;
  buckets: Bucket[];
  byStream: StreamSplit[];
  truncated: boolean;
}

export const METRIC_NAMES = [
  "minutes",
  "humanMinutes",
  "agentMinutes",
  "agentTokens",
  "agentCostUsd",
  "sessions",
  "activeDays",
  "breakMinutes",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];
export type Metrics = Record<MetricName, number>;

export interface Trend {
  direction: "up" | "down" | "flat";
  arrow: "↑" | "↓" | "→";
  delta: number;
  pct: number;
  better: boolean;
}

export interface Comparison {
  current: RangeReport;
  previous: RangeReport;
  delta: Metrics;
  deltaPct: Metrics;
  trend: Record<MetricName, Trend>;
}

export interface SearchHit {
  id: number;
  userId: number;
  userName: string | null;
  streamId: number | null;
  streamName: string | null;
  streamColor: string | null;
  taskId: number | null;
  taskTitle: string | null;
  customerId: number | null;
  customerName: string | null;
  checkIn: string;
  checkOut: string | null;
  isBreak: boolean;
  notes: string | null;
  entrySource: EntrySource;
  agentLabel: string | null;
  tokensUsed: number | null;
  apiCostUsd: number | null;
  minutes: number;
}

export interface SearchResult {
  query: string;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  totalMinutes: number;
  results: SearchHit[];
}

export interface Cell {
  minutes: number;
  sessions: number;
  humanSessions: number;
  agentSessions: number;
  human: HumanBucket;
  agent: AgentBucket;
}

export interface HourCell extends Cell {
  hour: number;
  label: string;
}

export interface WeekdayCell extends Cell {
  weekday: number;
  name: string;
  activeDays: number;
}

export interface BreakStats {
  count: number;
  minutes: number;
  avgMinutes: number;
  perActiveDay: number;
  longestMinutes: number;
}

export interface FocusBlock {
  minutes: number;
  startedAt: string;
  endedAt: string;
  sessions: number;
  entryIds: number[];
  userId: number;
  userName: string | null;
  streamId: number | null;
  streamName: string | null;
  taskTitle: string | null;
  entrySource: "human" | "agent" | "mixed";
}

export interface AgentStream {
  streamId: number | null;
  streamName: string | null;
  minutes: number;
  totalMinutes: number;
  costUsd: number;
  tokens: number;
  sharePct: number;
}

export interface Patterns {
  from: string;
  to: string;
  minutes: number;
  breakMinutes: number;
  sessions: number;
  humanSessions: number;
  agentSessions: number;
  activeDays: number;
  avgSessionMinutes: number;
  human: HumanBucket;
  agent: AgentBucket;
  byHour: HourCell[];
  byWeekday: WeekdayCell[];
  heat: number[][];
  heatAgent: number[][];
  heatMax: number;
  breaks: BreakStats;
  longestFocus: FocusBlock | null;
  peakHour: number | null;
  peakWeekday: number | null;
  byStream: StreamSplit[];
  agentStreams: AgentStream[];
  customersTouched: number;
  truncated: boolean;
}

export interface Summary {
  from: string;
  to: string;
  sentences: string[];
  facts: {
    minutes: number;
    breakMinutes: number;
    sessions: number;
    activeDays: number;
    avgSessionMinutes: number;
    human: HumanBucket;
    agent: AgentBucket;
    agentSessions: number;
    humanSessions: number;
    peakHour: number | null;
    peakWeekday: number | null;
    longestFocusMinutes: number;
    breaks: BreakStats;
    agentStreams: AgentStream[];
  };
}

export interface CustomerGoal {
  customerId: number;
  name: string;
  weeklyGoalHours: number | null;
  goalMinutes: number;
  minutes: number;
  human: HumanBucket;
  agent: AgentBucket;
  sessions: number;
  pct: number;
  remainingMinutes: number;
  met: boolean;
  streams: { streamId: number; name: string; minutes: number }[];
}

export interface CustomerGoals {
  from: string;
  to: string;
  customers: CustomerGoal[];
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
  source: "human" | "agent" | "mixed";
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

export interface InvoicePreview {
  orgName: string;
  invoiceId: number | null;
  reference: string;
  status: string;
  customer: { id: number; name: string; billingAddress: string | null; billingEmail: string | null };
  period: { month: number; year: number; label: string; from: string; to: string };
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  issuedAt: string;
}

export interface GeneratedInvoice {
  invoiceId: number;
  pdfUrl: string;
  reference: string;
  status: string;
  customer: InvoicePreview["customer"];
  period: InvoicePreview["period"];
  totals: InvoiceTotals;
  lineCount: number;
}

export interface InvoiceRow {
  id: number;
  customerId: number | null;
  customerName: string | null;
  userId: number | null;
  issuedBy: string | null;
  month: number;
  year: number;
  status: string;
  totalMinutes: number;
  amountCents: number | null;
  currency: string;
  reference: string | null;
  contentHash: string | null;
  verifyToken: string | null;
  verifyUrl: string | null;
  voidedAt: string | null;
  voided: boolean;
  pdfUrl: string;
  periodLabel: string;
  createdAt: string;
}

/* ── Contractor billing and certified invoices ───────────────────────── */

export interface MemberBilling {
  userId: number;
  displayName: string;
  email: string;
  isAgent: boolean;
  role: string;
  billable: boolean;
  hourlyRate: number | null;
  currency: string;
  billingName: string | null;
  billingAddress: string | null;
  taxId: string | null;
  requireApproval: boolean;
}

export interface ContractorLine {
  date: string;
  dateLabel: string;
  streamId: number | null;
  streamName: string | null;
  taskId: number | null;
  taskKey: string | null;
  taskTitle: string | null;
  sessions: number;
  minutes: number;
  source: "human" | "agent" | "mixed";
  tokens: number;
  costUsd: number;
  amountCents: number | null;
  approval: string;
}

export interface ContractorTotals {
  sessions: number;
  minutes: number;
  hours: number;
  humanMinutes: number;
  agentMinutes: number;
  tokens: number;
  costUsd: number;
  amountCents: number | null;
}

export interface ContractorPreview {
  kind: "contractor";
  orgName: string;
  invoiceId: number | null;
  reference: string;
  status: string;
  contractor: { userId: number; name: string; billingName: string | null; billingAddress: string | null; taxId: string | null; email: string };
  period: { month: number; year: number; label: string; from: string; to: string };
  currency: string;
  rate: number | null;
  onlyApproved: boolean;
  lines: ContractorLine[];
  entries: { entryId: number; minutes: number; approvalStatus: string }[];
  totals: ContractorTotals;
  excluded: { pendingMinutes: number; rejectedMinutes: number; unsubmittedMinutes: number };
  alreadyInvoiced: { entryId: number; invoiceId: number }[];
  issuedAt: string;
}

export interface GeneratedContractorInvoice {
  invoiceId: number;
  kind: "contractor";
  reference: string;
  verifyUrl: string;
  verifyToken: string;
  pdfUrl: string;
  contentHash: string;
  signingKeyId: number;
  status: string;
  contractor: ContractorPreview["contractor"];
  period: ContractorPreview["period"];
  currency: string;
  rate: number | null;
  totals: ContractorTotals;
  lineCount: number;
  entryCount: number;
  lockedEntryIds: number[];
  onlyApproved: boolean;
}

export interface ContractorInvoiceRow {
  id: number;
  memberUserId: number | null;
  memberName: string | null;
  reference: string | null;
  month: number;
  year: number;
  periodLabel: string;
  status: string;
  currency: string;
  rate: number | null;
  totalMinutes: number;
  amountCents: number | null;
  contentHash: string | null;
  signingKeyId: number | null;
  verifyToken: string | null;
  verifyUrl: string | null;
  pdfUrl: string;
  issuedAt: string | null;
  voidedAt: string | null;
  voided: boolean;
}

export interface ContractorsOverview {
  period: { month: number; year: number; label: string };
  contractors: {
    userId: number;
    displayName: string;
    billingName: string | null;
    hourlyRate: number | null;
    currency: string;
    requireApproval: boolean;
    minutes: { approved: number; pending: number; rejected: number; none: number; billable: number };
    amountCents: number | null;
    invoice: { invoiceId: number; reference: string | null; voided: boolean } | null;
  }[];
}

export const getMemberBilling = (userId: number) => callAction<MemberBilling>("member.billing", { userId });

export const previewContractorInvoice = (args: { userId: number; month: number; year: number; onlyApproved?: boolean }) =>
  callAction<ContractorPreview>("invoice.contractor_preview", args as unknown as Record<string, unknown>);

export const generateContractorInvoice = (args: { userId: number; month: number; year: number; onlyApproved?: boolean }) =>
  callAction<GeneratedContractorInvoice>("invoice.contractor_generate", args as unknown as Record<string, unknown>);

export const listContractorInvoices = (args: { userId?: number } = {}) =>
  callAction<ContractorInvoiceRow[]>("invoice.contractor_list", args as Record<string, unknown>);

export const getContractors = (args: { month?: number; year?: number } = {}) =>
  callAction<ContractorsOverview>("billing.contractors", args as Record<string, unknown>);

export const voidInvoice = (args: { invoiceId: number; reason: string }) =>
  callAction<{ invoiceId: number; reference: string | null; voidedAt: string; unlockedEntries: number[]; reason: string }>("invoice.void", args as unknown as Record<string, unknown>);

/** "$45/h", or "1,200 SEK/h" where the code has no symbol. */
const SYMBOLS: Record<string, string> = { USD: "$", EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5" };

export function formatMoney(cents: number | null, currency = "USD"): string {
  if (cents === null) return "\u2013";
  const amount = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${amount}` : `${amount} ${currency.toUpperCase()}`;
}

export function formatRate(rate: number | null, currency = "USD"): string {
  if (rate === null) return "no rate";
  const amount = rate.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const symbol = SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${amount}/h` : `${amount} ${currency.toUpperCase()}/h`;
}

/* ── Query keys ──────────────────────────────────────────────────────── */

export const reportKeys = {
  all: ["track", "reports"] as const,
  range: (args: unknown) => ["track", "reports", "range", args] as const,
  compare: (args: unknown) => ["track", "reports", "compare", args] as const,
  search: (args: unknown) => ["track", "reports", "search", args] as const,
  patterns: (args: unknown) => ["track", "reports", "patterns", args] as const,
  summary: (args: unknown) => ["track", "reports", "summary", args] as const,
  goals: ["track", "reports", "goals"] as const,
  invoices: ["track", "reports", "invoices"] as const,
  invoicePreview: (args: unknown) => ["track", "reports", "invoice-preview", args] as const,
  contractorInvoices: ["track", "contractors", "invoices"] as const,
  contractors: (args: unknown) => ["track", "contractors", "overview", args] as const,
  contractorPreview: (args: unknown) => ["track", "contractors", "preview", args] as const,
};

/* ── Reads ───────────────────────────────────────────────────────────── */

export interface RangeArgs {
  from: string;
  to: string;
  groupBy: GroupBy;
  streamIds?: number[];
  includeBreaks?: boolean;
  userId?: number | "all";
}

export const getRange = (args: RangeArgs) => callAction<RangeReport>("report.range", args as unknown as Record<string, unknown>);

export const getComparison = (args: {
  current: { from: string; to: string };
  previous: { from: string; to: string };
  groupBy?: GroupBy;
  userId?: number | "all";
}) => callAction<Comparison>("report.compare", args as unknown as Record<string, unknown>);

export const searchLedger = (args: {
  query: string;
  from?: string;
  to?: string;
  streamId?: number;
  minMinutes?: number;
  limit?: number;
  offset?: number;
  userId?: number | "all";
}) => callAction<SearchResult>("report.search", args as unknown as Record<string, unknown>);

export const getPatterns = (args: { from?: string; to?: string; userId?: number | "all" }) =>
  callAction<Patterns>("insights.patterns", args as unknown as Record<string, unknown>);

export const getSummary = (args: { from?: string; to?: string; userId?: number | "all" }) =>
  callAction<Summary>("insights.summary", args as unknown as Record<string, unknown>);

export const getCustomerGoals = () => callAction<CustomerGoals>("customer.goals");

export const previewInvoice = (args: { customerId: number; month: number; year: number }) =>
  callAction<InvoicePreview>("invoice.preview", args);

export const generateInvoice = (args: { customerId: number; month: number; year: number }) =>
  callAction<GeneratedInvoice>("invoice.generate", args);

export const listInvoices = () => callAction<InvoiceRow[]>("invoice.list");

/**
 * Fetch an invoice PDF as an object URL. The route needs the bearer token, so
 * the link cannot simply be an `<a href>` — the bytes are pulled with the same
 * auth headers every other call uses and wrapped in a blob URL the browser can
 * open or save. Callers must revoke the URL when they are done with it.
 */
export async function fetchInvoicePdfUrl(pdfUrl: string): Promise<string> {
  const res = await fetch(pdfUrl, { headers: getAuthHeader() });
  if (!res.ok) throw new Error(`Could not fetch the invoice (${res.status})`);
  // A single-page app answers an unknown path with its own HTML and a 200, so
  // `res.ok` alone is not proof of a PDF: an unrouted endpoint would otherwise
  // hand the reader the application itself, renamed .pdf.
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/pdf")) {
    throw new Error("That URL did not return a PDF — the invoice route may not be mounted on this server.");
  }
  return URL.createObjectURL(await res.blob());
}

/** Streams to filter by, reusing the timer's picker feed. */
export const getStreamsForFilter = () =>
  api<{ streams: { id: number; name: string; color: string | null }[]; customers: { id: number; name: string; weeklyGoalHours: number | null }[] }>(
    "/track/pickers"
  );

export type { BySource };
