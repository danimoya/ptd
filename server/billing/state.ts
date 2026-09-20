/**
 * Where the subscription's *shape* lives.
 *
 * `db/schema.ts` is frozen and gives billing three columns on `organizations`:
 * `plan`, `stripe_customer_id`, `stripe_subscription_id`. That is enough to answer
 * "what may this organization do", but not enough to change a subscription: to
 * move Team→Business, or to set the seat quantity, we need the *item* ids Stripe
 * minted, the interval being billed and the period we are inside.
 *
 * So the rest goes in `org_integrations` under kind `billing` — one row per
 * organization, config only, no secrets. It is a cache of Stripe, rebuilt by every
 * webhook and by `billing.sync`; losing it costs one round-trip, never money.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { orgIntegrations } from "../../db/schema";
import { isInterval, type Interval } from "./plans";

/** `varchar(20)` in the schema. */
export const BILLING_KIND = "billing";

/** The subscription item ids, by what each one bills for. */
export interface BillingItems {
  /** The plan's flat price. */
  base?: string | null;
  /** Human seats beyond what Business includes. */
  seat?: string | null;
  /** The certified-invoice meter. */
  cert?: string | null;
  /** The AI-usage meter. */
  ai?: string | null;
}

export interface BillingState {
  interval: Interval | null;
  items: BillingItems;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  status: string | null;
  cancelAtPeriodEnd: boolean;
  /** The seat quantity we last set, so an unchanged sync makes no Stripe call. */
  seatQuantity: number | null;
  updatedAt: string | null;
}

export const EMPTY_BILLING_STATE: BillingState = {
  interval: null,
  items: {},
  currentPeriodStart: null,
  currentPeriodEnd: null,
  status: null,
  cancelAtPeriodEnd: false,
  seatQuantity: null,
  updatedAt: null,
};

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Tolerant on the way in: a hand-edited or half-written config must not throw. */
export function asBillingState(raw: unknown): BillingState {
  const c = (raw ?? {}) as Record<string, unknown>;
  const items = (c.items ?? {}) as Record<string, unknown>;
  const quantity = Number(c.seatQuantity);
  return {
    interval: isInterval(c.interval) ? c.interval : null,
    items: {
      base: str(items.base),
      seat: str(items.seat),
      cert: str(items.cert),
      ai: str(items.ai),
    },
    currentPeriodStart: str(c.currentPeriodStart),
    currentPeriodEnd: str(c.currentPeriodEnd),
    status: str(c.status),
    cancelAtPeriodEnd: c.cancelAtPeriodEnd === true,
    seatQuantity: Number.isFinite(quantity) && quantity >= 0 ? Math.floor(quantity) : null,
    updatedAt: str(c.updatedAt),
  };
}

/** Drop the nulls, so the stored JSON says only what is actually known. */
function toConfig(state: BillingState): Record<string, unknown> {
  const items: Record<string, string> = {};
  for (const [key, value] of Object.entries(state.items)) if (value) items[key] = value;
  const config: Record<string, unknown> = { items, cancelAtPeriodEnd: state.cancelAtPeriodEnd, updatedAt: state.updatedAt ?? new Date().toISOString() };
  if (state.interval) config.interval = state.interval;
  if (state.currentPeriodStart) config.currentPeriodStart = state.currentPeriodStart;
  if (state.currentPeriodEnd) config.currentPeriodEnd = state.currentPeriodEnd;
  if (state.status) config.status = state.status;
  if (state.seatQuantity !== null) config.seatQuantity = state.seatQuantity;
  return config;
}

async function existingRow(orgId: number): Promise<{ id: number; config: unknown } | null> {
  const [row] = await db
    .select({ id: orgIntegrations.id, config: orgIntegrations.config })
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, BILLING_KIND)))
    .limit(1);
  return row ?? null;
}

/** What we last knew about this organization's subscription. Never throws. */
export async function readBillingState(orgId: number): Promise<BillingState> {
  const row = await existingRow(orgId);
  return row ? asBillingState(row.config) : { ...EMPTY_BILLING_STATE, items: {} };
}

/**
 * Merge a patch into the stored state. `items` merges key by key, so a webhook
 * that only learned the base item does not erase the meter items a previous one
 * recorded.
 */
export async function writeBillingState(
  orgId: number,
  patch: Partial<BillingState>,
  userId: number | null = null,
): Promise<BillingState> {
  const row = await existingRow(orgId);
  const current = row ? asBillingState(row.config) : { ...EMPTY_BILLING_STATE, items: {} };
  const next: BillingState = {
    ...current,
    ...patch,
    items: { ...current.items, ...(patch.items ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  const config = toConfig(next);
  if (row) {
    // A replayed webhook must write nothing at all, so the timestamp alone is not
    // a change: compare everything else first.
    const before = toConfig(current);
    const same = JSON.stringify({ ...before, updatedAt: null }) === JSON.stringify({ ...config, updatedAt: null });
    if (same) return current;
    await db.update(orgIntegrations).set({ config, enabled: true }).where(eq(orgIntegrations.id, row.id));
  } else {
    await db.insert(orgIntegrations).values({ orgId, kind: BILLING_KIND, config, enabled: true, createdBy: userId });
  }
  return next;
}

/** After a cancellation: the organization is back on `free` and owns no items. */
export async function clearBillingState(orgId: number): Promise<void> {
  const row = await existingRow(orgId);
  if (!row) return;
  await db.delete(orgIntegrations).where(eq(orgIntegrations.id, row.id));
}
