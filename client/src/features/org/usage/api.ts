import { callAction } from "@/lib/api";

/** Provider reconciliation, as the Org → Agents tab sees it. The key is never returned. */

export type UsageProvider = "anthropic" | "openai";

export interface ProviderView {
  provider: UsageProvider;
  connected: boolean;
  /** Last four characters of the stored key. The key itself never leaves the server. */
  keyHint: string | null;
  baseUrl: string | null;
  connectedAt: string | null;
  connectedBy: number | null;
  enabled: boolean;
}

export type ReconciliationStatus = "match" | "under_reported" | "over_reported" | "unavailable";

export interface ReconciliationRow {
  id: number;
  provider: UsageProvider;
  periodStart: string;
  periodEnd: string;
  reportedTokens: number;
  providerTokens: number;
  reportedCostUsd: number;
  providerCostUsd: number;
  status: ReconciliationStatus;
  detail: {
    deltaTokens?: number;
    deltaPct?: number;
    coveragePct?: number;
    verifiedTokens?: number;
    allowanceTokens?: number;
    providerCostAvailable?: boolean;
    providerError?: string;
    note?: string;
  } | null;
  createdAt: string;
}

export const PROVIDER_LABEL: Record<UsageProvider, string> = { anthropic: "Anthropic", openai: "OpenAI" };

/** What an admin key looks like, and where to get one — shown next to the field. */
export const PROVIDER_HINT: Record<UsageProvider, string> = {
  anthropic: "An Admin API key (sk-ant-admin…) from Console → Settings → Admin keys. Reads /v1/organizations/usage_report/messages and /v1/organizations/cost_report.",
  openai: "An organization admin key with the usage scope. Reads /v1/organization/usage/completions and /v1/organization/costs.",
};

export const STATUS_LABEL: Record<ReconciliationStatus, string> = {
  match: "match",
  under_reported: "under-reported",
  over_reported: "over-reported",
  unavailable: "unavailable",
};

export const STATUS_CHIP: Record<ReconciliationStatus, string> = {
  match: "border-sage/60 text-sage",
  under_reported: "border-vermilion/70 text-vermilion",
  over_reported: "border-[#9a6a12]/60 text-[#9a6a12] dark:border-[#d6a243]/60 dark:text-[#d6a243]",
  unavailable: "border-rule text-ink-muted",
};

export const listProviders = () => callAction<ProviderView[]>("usage.providers", {});

export const connectProvider = (input: { provider: UsageProvider; adminApiKey: string; baseUrl?: string }) =>
  callAction<ProviderView>("usage.connect_provider", input);

export const disconnectProvider = (provider: UsageProvider) =>
  callAction<{ provider: UsageProvider; disconnected: boolean }>("usage.disconnect_provider", { provider });

export const reconcile = (input: { provider: UsageProvider; from: string; to: string }) =>
  callAction<ReconciliationRow>("usage.reconcile", input);

export const listReconciliations = (limit = 20) => callAction<ReconciliationRow[]>("usage.reconciliations", { limit });

/** The last complete calendar month, which is the period a finance question is usually about. */
export function lastMonth(now = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: iso(start), to: iso(end) };
}
