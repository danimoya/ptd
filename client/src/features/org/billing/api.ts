import { callAction } from "@/lib/api";

/* ─────────────────────────────────────────────────────────────────────────
 * The billing tab's whole view of the server.
 *
 * Every figure the tab prints comes from `billing.status` — prices, seat
 * allowances, the plan list itself — so the client never carries a second copy
 * of the price list that can drift from Stripe. The only numbers written down
 * here are the shapes those figures arrive in.
 * ───────────────────────────────────────────────────────────────────────── */

export type BillingPlan = "self_hosted" | "free" | "team" | "business";
export type PaidPlan = "team" | "business";
export type Interval = "month" | "year";

/** Pricing v1 wrote `hosted` for every paying organization; that tier is Team. */
export type StoredPlan = BillingPlan | "hosted";

export type Feature =
  | "surfaces"
  | "integrations"
  | "oauth_connectors"
  | "webhooks"
  | "importers"
  | "certified_invoices"
  | "security_policy"
  | "audit_export"
  | "stripe_tax"
  | "priority_support"
  | "ai"
  | "ai_priority";

export interface PlanLimits {
  /** Human members allowed, or null for "as many as you pay for". */
  humanSeats: number | null;
  /** Humans + agents allowed — the hard cap. */
  totalMembers: number | null;
  /** Human seats the flat price already covers. */
  includedHumanSeats: number | null;
  /** Whether humans past `includedHumanSeats` are billed rather than refused. */
  billableSeats: boolean;
  /** Legacy field: the free tier's single ceiling. */
  members?: number | null;
}

/** One card in the price list, exactly as the server describes it. */
export interface PlanDescription {
  plan: BillingPlan;
  label: string;
  /** null on the plans that are not sold. */
  prices: Record<Interval, number> | null;
  limits: PlanLimits;
  features: Feature[];
  /** Dollars per extra human seat — Business only. */
  seatPrices: Record<Interval, number> | null;
  /** Dollars per certified invoice, when they are metered rather than included. */
  certInvoiceUsd: number | null;
}

/** Which of the four line items a subscription carries. */
export interface BillingItems {
  base?: string | null;
  seat?: string | null;
  cert?: string | null;
  ai?: string | null;
}

export interface BillingSubscription {
  id?: string;
  status: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDue?: boolean;
  items?: BillingItems;
  seatQuantity?: number | null;
}

export interface BillingUsage {
  humans: number;
  agents: number;
  total?: number;
  members: number;
  /** Human seats past what Business includes — billed, not refused. */
  seatOverage?: number;
  seatCostUsd?: number;
}

export interface BillingAddons {
  /** ISO start of the window the figures cover. */
  since: string;
  certifiedInvoices: number;
  /** Dollars — zero on the plans that include them. */
  certifiedInvoicesUsd: number;
  aiCents: number;
  /** The raw provider cost behind those cents, before the markup. */
  aiCostUsd: number;
  aiCalls: number;
}

/** `{ hosted: false }` is the whole answer on a self-hosted deployment. */
export interface BillingStatus {
  hosted: boolean;
  plan?: StoredPlan;
  planLabel?: string;
  interval?: Interval | null;
  features?: Feature[];
  prices?: Record<PaidPlan, Record<Interval, number>>;
  seatPrices?: Record<Interval, number>;
  certInvoiceUsd?: number;
  aiMarkup?: number;
  priceUsd?: number;
  plans?: PlanDescription[];
  limits?: PlanLimits;
  usage?: BillingUsage;
  addons?: BillingAddons;
  subscription?: BillingSubscription | null;
  portalAvailable?: boolean;
  /** Stripe key plus all four plan prices present. */
  configured?: boolean;
  memberCap?: number | null;
  /** The code a founding member types at Checkout, while one is on offer. */
  foundingCode?: string | null;
  /** Stripe could not be read; the stored state is shown anyway. */
  warning?: string;
}

export interface BillingRedirect {
  hosted: boolean;
  url?: string;
  sessionId?: string;
  plan?: PaidPlan;
  interval?: Interval;
  seatQuantity?: number;
  priceUsd?: number;
}

export interface BillingChange {
  hosted: boolean;
  plan?: BillingPlan;
  interval?: Interval;
  seatQuantity?: number;
  priceUsd?: number;
  subscription?: BillingSubscription | null;
}

export interface BillingSync {
  hosted: boolean;
  synced?: boolean;
  plan?: StoredPlan | null;
  interval?: Interval | null;
  changed?: boolean;
  subscription?: BillingSubscription | null;
}

export interface PlanChoice {
  plan: PaidPlan;
  interval: Interval;
}

export const BILLING_STATUS_KEY = ["/api/actions/billing.status"] as const;

export const getBillingStatus = () => callAction<BillingStatus>("billing.status", {});
export const startCheckout = (choice: PlanChoice) => callAction<BillingRedirect>("billing.checkout", { ...choice });
export const changePlan = (choice: PlanChoice) => callAction<BillingChange>("billing.change_plan", { ...choice });
export const openPortal = () => callAction<BillingRedirect>("billing.portal", {});
export const syncBilling = (sessionId?: string) => callAction<BillingSync>("billing.sync", sessionId ? { sessionId } : {});

/* ────────────────────────────────────────────────────────────────── helpers */

/** Read a stored plan, including the `hosted` value pricing v1 wrote. */
export function normalisePlan(value: StoredPlan | null | undefined): BillingPlan {
  if (value === "hosted") return "team";
  if (value === "self_hosted" || value === "free" || value === "team" || value === "business") return value;
  return "free";
}

export function isPaidPlan(value: unknown): value is PaidPlan {
  return value === "team" || value === "business";
}

/** Whole dollars stay whole; cents are printed as cents. */
export function money(n: number): string {
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;
}

/** Money that is the result of arithmetic, always to the cent. */
export function moneyExact(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Metered cents, printed as money. A single cent is still a figure. */
export function centsToMoney(cents: number): string {
  return moneyExact(Math.max(0, cents) / 100);
}

/** What an annual price works out to per month — the two-months-free arithmetic. */
export function perMonthOnAnnual(prices: Record<Interval, number>): number {
  return Math.round((prices.year / 12) * 100) / 100;
}

/** Dollars saved by paying yearly. */
export function annualSaving(prices: Record<Interval, number>): number {
  return prices.month * 12 - prices.year;
}

export function intervalWord(interval: Interval): string {
  return interval === "year" ? "a year" : "a month";
}

export function perInterval(interval: Interval): string {
  return interval === "year" ? "/ org / year" : "/ org / month";
}

/** Human label for a Stripe subscription status. */
export function statusLabel(status: string | null | undefined): string {
  switch (status) {
    case "active": return "active";
    case "trialing": return "trial";
    case "past_due": return "payment overdue";
    case "canceled": return "cancelled";
    case "unpaid": return "unpaid";
    case "incomplete": return "awaiting payment";
    case "incomplete_expired": return "expired";
    case "paused": return "paused";
    default: return status ?? "—";
  }
}
