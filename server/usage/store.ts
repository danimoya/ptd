/**
 * Where a provider admin key lives.
 *
 * `org_integrations` with kind `usage_anthropic` / `usage_openai`, one row per
 * organization per provider, the key sealed with AES-256-GCM by
 * `server/crypto.ts`. Nothing ever returns the key — `keyHint` (last four
 * characters) is what the UI shows so an admin can tell two keys apart without
 * the server handing one back.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { orgIntegrations, usageReconciliations } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../crypto";
import { USAGE_PROVIDERS, type UsageProvider } from "./providers";

/** varchar(20) in the schema — `usage_anthropic` is the longest at 15. */
export function kindFor(provider: UsageProvider): string {
  return `usage_${provider}`;
}

export function isUsageProvider(value: unknown): value is UsageProvider {
  return typeof value === "string" && (USAGE_PROVIDERS as readonly string[]).includes(value);
}

export interface ProviderConfig {
  /** AES-256-GCM sealed admin key. Never leaves the server. */
  apiKeySealed: string;
  /** Last four characters of the key, for the UI. */
  keyHint: string;
  /** Point the fetcher at a stub or a proxy instead of the provider's real host. */
  baseUrl?: string;
  connectedAt: string;
  connectedBy: number | null;
}

export interface ProviderView {
  provider: UsageProvider;
  connected: boolean;
  keyHint: string | null;
  baseUrl: string | null;
  connectedAt: string | null;
  connectedBy: number | null;
  enabled: boolean;
}

function hintOf(key: string): string {
  const tail = key.trim().slice(-4);
  return tail.length === 4 ? `…${tail}` : "…";
}

function asConfig(raw: unknown): ProviderConfig | null {
  const c = raw as Partial<ProviderConfig> | null;
  if (!c || typeof c.apiKeySealed !== "string" || c.apiKeySealed === "") return null;
  return {
    apiKeySealed: c.apiKeySealed,
    keyHint: typeof c.keyHint === "string" ? c.keyHint : "…",
    ...(typeof c.baseUrl === "string" && c.baseUrl !== "" ? { baseUrl: c.baseUrl } : {}),
    connectedAt: typeof c.connectedAt === "string" ? c.connectedAt : "",
    connectedBy: typeof c.connectedBy === "number" ? c.connectedBy : null,
  };
}

/** Seal a key into a fresh row, replacing whatever was there for that provider. */
export async function connectProvider(
  orgId: number,
  provider: UsageProvider,
  adminApiKey: string,
  userId: number,
  baseUrl?: string,
): Promise<ProviderView> {
  const kind = kindFor(provider);
  const config: ProviderConfig = {
    apiKeySealed: encryptSecret(adminApiKey.trim()),
    keyHint: hintOf(adminApiKey),
    ...(baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, "") } : {}),
    connectedAt: new Date().toISOString(),
    connectedBy: userId,
  };
  const [existing] = await db
    .select({ id: orgIntegrations.id })
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, kind)))
    .limit(1);
  if (existing) {
    await db
      .update(orgIntegrations)
      .set({ config: config as unknown as Record<string, unknown>, enabled: true, createdBy: userId })
      .where(eq(orgIntegrations.id, existing.id));
  } else {
    await db
      .insert(orgIntegrations)
      .values({ orgId, kind, config: config as unknown as Record<string, unknown>, enabled: true, createdBy: userId });
  }
  return { provider, connected: true, keyHint: config.keyHint, baseUrl: config.baseUrl ?? null, connectedAt: config.connectedAt, connectedBy: userId, enabled: true };
}

export async function disconnectProvider(orgId: number, provider: UsageProvider): Promise<{ provider: UsageProvider; disconnected: boolean }> {
  const rows = await db
    .delete(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, kindFor(provider))))
    .returning({ id: orgIntegrations.id });
  return { provider, disconnected: rows.length > 0 };
}

export async function readProviderConfig(orgId: number, provider: UsageProvider): Promise<ProviderConfig | null> {
  const [row] = await db
    .select({ config: orgIntegrations.config, enabled: orgIntegrations.enabled })
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, kindFor(provider))))
    .limit(1);
  if (!row || row.enabled === false) return null;
  return asConfig(row.config);
}

/** The plaintext key, for one fetch. Callers must not log or return it. */
export function openKey(config: ProviderConfig): string {
  try {
    return decryptSecret(config.apiKeySealed);
  } catch {
    // Tolerate a hand-written plaintext value the way server/webhooks.ts does,
    // so a config seeded by an operator's script still works.
    return config.apiKeySealed;
  }
}

/** Both providers, connected or not — what the Org → Agents card renders. */
export async function listProviders(orgId: number): Promise<ProviderView[]> {
  const rows = await db
    .select({ kind: orgIntegrations.kind, config: orgIntegrations.config, enabled: orgIntegrations.enabled, createdBy: orgIntegrations.createdBy })
    .from(orgIntegrations)
    .where(eq(orgIntegrations.orgId, orgId));
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return USAGE_PROVIDERS.map((provider) => {
    const row = byKind.get(kindFor(provider));
    const config = row ? asConfig(row.config) : null;
    if (!row || !config) {
      return { provider, connected: false, keyHint: null, baseUrl: null, connectedAt: null, connectedBy: null, enabled: false };
    }
    return {
      provider,
      connected: true,
      keyHint: config.keyHint,
      baseUrl: config.baseUrl ?? null,
      connectedAt: config.connectedAt || null,
      connectedBy: config.connectedBy,
      enabled: row.enabled,
    };
  });
}

export type ReconciliationRow = typeof usageReconciliations.$inferSelect;

/** Reconciliation history, newest first. */
export async function listReconciliations(orgId: number, provider?: UsageProvider, limit = 20): Promise<ReconciliationRow[]> {
  const filters = [eq(usageReconciliations.orgId, orgId)];
  if (provider) filters.push(eq(usageReconciliations.provider, provider));
  return db
    .select()
    .from(usageReconciliations)
    .where(and(...filters))
    .orderBy(desc(usageReconciliations.createdAt), desc(usageReconciliations.id))
    .limit(limit);
}
