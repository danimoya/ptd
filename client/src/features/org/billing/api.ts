import { callAction } from "@/lib/api";

export type BillingPlan = "self_hosted" | "free" | "hosted";

export interface BillingSubscription {
  id?: string;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDue?: boolean;
}

/** `{ hosted: false }` is the whole answer on a self-hosted deployment. */
export interface BillingStatus {
  hosted: boolean;
  plan?: BillingPlan;
  priceUsd?: number;
  interval?: string;
  limits?: { members: number | null };
  usage?: { members: number; agents: number; humans?: number };
  subscription?: BillingSubscription | null;
  portalAvailable?: boolean;
  configured?: boolean;
  warning?: string;
}

export interface BillingRedirect {
  hosted: boolean;
  url?: string;
}

export interface BillingSync {
  hosted: boolean;
  synced?: boolean;
  plan?: BillingPlan | null;
  changed?: boolean;
  subscription?: BillingSubscription | null;
}

export const BILLING_STATUS_KEY = ["/api/actions/billing.status"] as const;

export const getBillingStatus = () => callAction<BillingStatus>("billing.status", {});
export const startCheckout = () => callAction<BillingRedirect>("billing.checkout", {});
export const openPortal = () => callAction<BillingRedirect>("billing.portal", {});
export const syncBilling = (sessionId?: string) => callAction<BillingSync>("billing.sync", sessionId ? { sessionId } : {});

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
