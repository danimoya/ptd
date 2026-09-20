/**
 * Reconciliation: the agents' arithmetic against the provider's invoice.
 *
 * `usage.summary` compares self-reported figures with per-session attestations.
 * That still only proves the sessions PTD knows about. Reconciliation closes the
 * other half of the gap: it asks the provider what the whole organization
 * actually burned over a period and compares that with the sum of what the
 * agents booked into the ledger.
 *
 * The verdict is deliberately coarse — `match`, `under_reported`,
 * `over_reported`, `unavailable` — because the numbers are not commensurable to
 * the token: a provider bill includes keys PTD never sees (a developer's laptop,
 * another product), and PTD's ledger includes agents on providers this
 * reconciliation did not query. So the status is a signal to go and look, and
 * `detail` carries everything needed to do that looking: the two totals, the
 * gap, the tolerance that was applied, the per-agent breakdown and the coverage
 * of independent attestations. `over_reported` in particular is usually PTD
 * being over-complete rather than an agent inflating a number, and the detail's
 * `note` says so.
 */

import { db } from "../../db";
import { usageReconciliations } from "../../db/schema";
import { foldUsage, readUsageRows, type UsageSummary } from "./summary";
import { fetchProviderUsage, type ProviderDeps, type ProviderUsage, type UsageProvider } from "./providers";
import { openKey, readProviderConfig } from "./store";

export const RECONCILIATION_STATUSES = ["match", "under_reported", "over_reported", "unavailable"] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** Default slack before a gap is called a discrepancy: 5% of the provider's figure, or 10k tokens. */
export const DEFAULT_TOLERANCE_PCT = 5;
export const DEFAULT_TOLERANCE_TOKENS = 10_000;

export interface Comparison {
  status: ReconciliationStatus;
  providerTokens: number;
  reportedTokens: number;
  verifiedTokens: number;
  deltaTokens: number;
  deltaPct: number;
  allowanceTokens: number;
}

export interface ClassifyInput {
  available: boolean;
  providerTokens: number;
  reportedTokens: number;
  verifiedTokens: number;
  tolerancePct?: number;
  toleranceTokens?: number;
}

/**
 * The verdict. Pure — this is the function the unit tests pin, because it is the
 * only place the word "under_reported" is decided.
 *
 * `delta = provider − reported`: positive means the provider billed for tokens
 * the ledger does not account for (under-reporting), negative means the ledger
 * claims more than the provider billed (over-reporting).
 */
export function classify(input: ClassifyInput): Comparison {
  const tolerancePct = input.tolerancePct ?? DEFAULT_TOLERANCE_PCT;
  const toleranceTokens = input.toleranceTokens ?? DEFAULT_TOLERANCE_TOKENS;
  const providerTokens = Math.max(0, Math.round(input.providerTokens));
  const reportedTokens = Math.max(0, Math.round(input.reportedTokens));
  const verifiedTokens = Math.max(0, Math.round(input.verifiedTokens));
  const delta = providerTokens - reportedTokens;
  const allowance = Math.max(toleranceTokens, (providerTokens * tolerancePct) / 100);

  let status: ReconciliationStatus;
  if (!input.available) status = "unavailable";
  else if (Math.abs(delta) <= allowance) status = "match";
  else if (delta > 0) status = "under_reported";
  else status = "over_reported";

  return {
    status,
    providerTokens,
    reportedTokens,
    verifiedTokens,
    deltaTokens: delta,
    deltaPct: providerTokens === 0 ? 0 : Math.round((delta / providerTokens) * 1000) / 10,
    allowanceTokens: Math.round(allowance),
  };
}

const NOTES: Record<ReconciliationStatus, string> = {
  match:
    "The provider's token total and the ledger's agree inside tolerance. Nothing to chase.",
  under_reported:
    "The provider billed for more tokens than the ledger accounts for. Either an agent is under-reporting, or work ran on this key outside PTD (a developer's own session, another product, a job that never opened a time entry). Check coverage below before accusing anyone.",
  over_reported:
    "The ledger claims more tokens than the provider billed for this window. Usually PTD being over-complete — agents on a second provider, a second key, or entries whose checkIn falls inside the window while the spend landed outside it — rather than a seat inflating its numbers.",
  unavailable:
    "The provider could not be read, so no comparison was possible. The error is in `detail.providerError`.",
};

export interface ReconcileDetail extends Record<string, unknown> {
  tolerancePct: number;
  toleranceTokens: number;
  allowanceTokens: number;
  deltaTokens: number;
  deltaPct: number;
  verifiedTokens: number;
  verifiedCostUsd: number;
  coveragePct: number;
  entries: number;
  verifiedEntries: number;
  providerCostAvailable: boolean;
  providerBuckets: number;
  providerByModel: Record<string, number>;
  providerEndpoints: string[];
  providerError?: string;
  byAgent: { userId: number; name: string; reportedTokens: number; verifiedTokens: number; reportedCostUsd: number; verifiedCostUsd: number; coveragePct: number }[];
  note: string;
}

export interface ReconcileResult {
  id: number | null;
  provider: UsageProvider;
  periodStart: string;
  periodEnd: string;
  status: ReconciliationStatus;
  reportedTokens: number;
  providerTokens: number;
  reportedCostUsd: number;
  providerCostUsd: number;
  detail: ReconcileDetail;
  createdAt: string;
}

/** Build the row (and the detail blob) from the two sides. Pure. */
export function buildReconciliation(
  provider: UsageProvider,
  window: { from: Date; to: Date },
  summary: UsageSummary,
  providerUsage: ProviderUsage,
  tolerance: { pct?: number; tokens?: number } = {},
): Omit<ReconcileResult, "id" | "createdAt"> {
  const comparison = classify({
    available: providerUsage.available,
    providerTokens: providerUsage.tokens,
    reportedTokens: summary.totals.reported.tokens,
    verifiedTokens: summary.totals.verified.tokens,
    tolerancePct: tolerance.pct,
    toleranceTokens: tolerance.tokens,
  });

  const detail: ReconcileDetail = {
    tolerancePct: tolerance.pct ?? DEFAULT_TOLERANCE_PCT,
    toleranceTokens: tolerance.tokens ?? DEFAULT_TOLERANCE_TOKENS,
    allowanceTokens: comparison.allowanceTokens,
    deltaTokens: comparison.deltaTokens,
    deltaPct: comparison.deltaPct,
    verifiedTokens: summary.totals.verified.tokens,
    verifiedCostUsd: summary.totals.verified.costUsd,
    coveragePct: summary.totals.coveragePct,
    entries: summary.totals.entries,
    verifiedEntries: summary.totals.verifiedEntries,
    providerCostAvailable: providerUsage.costAvailable,
    providerBuckets: providerUsage.buckets,
    providerByModel: providerUsage.byModel,
    providerEndpoints: providerUsage.endpoints,
    ...(providerUsage.error ? { providerError: providerUsage.error } : {}),
    byAgent: summary.byAgent.map((a) => ({
      userId: a.userId,
      name: a.name,
      reportedTokens: a.reported.tokens,
      verifiedTokens: a.verified.tokens,
      reportedCostUsd: a.reported.costUsd,
      verifiedCostUsd: a.verified.costUsd,
      coveragePct: a.coveragePct,
    })),
    note: NOTES[comparison.status],
  };

  return {
    provider,
    periodStart: window.from.toISOString(),
    periodEnd: window.to.toISOString(),
    status: comparison.status,
    reportedTokens: comparison.reportedTokens,
    providerTokens: comparison.providerTokens,
    reportedCostUsd: summary.totals.reported.costUsd,
    providerCostUsd: providerUsage.costAvailable ? providerUsage.costUsd : 0,
    detail,
  };
}

export class ProviderNotConnected extends Error {
  constructor(public provider: UsageProvider) {
    super(`No ${provider} admin key is connected for this organization — run usage.connect_provider first.`);
  }
}

/** Fetch, compare, store, return. The action is a thin wrapper over this. */
export async function reconcile(
  orgId: number,
  provider: UsageProvider,
  window: { from: Date; to: Date },
  deps: ProviderDeps = {},
): Promise<ReconcileResult> {
  const config = await readProviderConfig(orgId, provider);
  if (!config) throw new ProviderNotConnected(provider);

  const [rows, providerUsage] = await Promise.all([
    readUsageRows(orgId, window.from, window.to),
    fetchProviderUsage(provider, openKey(config), window, { ...deps, baseUrl: deps.baseUrl ?? config.baseUrl }),
  ]);
  const summary = foldUsage(rows, window);
  const built = buildReconciliation(provider, window, summary, providerUsage);

  const [stored] = await db
    .insert(usageReconciliations)
    .values({
      orgId,
      provider,
      periodStart: window.from,
      periodEnd: window.to,
      reportedTokens: Math.round(built.reportedTokens),
      providerTokens: Math.round(built.providerTokens),
      reportedCostUsd: built.reportedCostUsd,
      providerCostUsd: built.providerCostUsd,
      status: built.status,
      detail: built.detail,
    })
    .returning({ id: usageReconciliations.id, createdAt: usageReconciliations.createdAt });

  return {
    ...built,
    id: stored?.id ?? null,
    createdAt: (stored?.createdAt ?? new Date()).toISOString(),
  };
}
