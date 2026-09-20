import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { orgIntegrations } from "../../../db/schema";
import { decryptSecret, encryptSecret } from "../../crypto";
import { GITHUB_KIND } from "../shared/providers";
import type { InstallationAccount } from "./api";

/**
 * Where a GitHub App installation lives: one `org_integrations` row per organization
 * with kind = "github", holding the installation id, who it was installed on, and the
 * stream ↔ repository mappings.
 *
 * There is no long-lived secret to keep here — access tokens are minted per hour from
 * the App's private key and never stored — so the only sealed field is the optional
 * per-install webhook secret an admin may set when a repository posts with a different
 * secret from the deployment-wide one.
 */

export { GITHUB_KIND } from "../shared/providers";

export type SyncDirection = "both" | "in" | "out";

export interface GithubMapping {
  streamId: number;
  /** `owner/name`, lower-cased. */
  repo: string;
  direction: SyncDirection;
  /** The admin who mapped it: inbound writes run as this member, with their role. */
  mappedBy: number | null;
  mappedAt: string;
  lastSyncAt?: string | null;
  lastError?: string | null;
  /** Issues seen by the last `github.sync_now`. */
  lastImported?: number | null;
}

export interface GithubConfig {
  installationId: number;
  account: InstallationAccount | null;
  mappings: GithubMapping[];
  /** Sealed with server/crypto.ts. Only set when it differs from GITHUB_WEBHOOK_SECRET. */
  webhookSecret?: string;
  installedBy?: number | null;
  installedAt?: string;
  lastEventAt?: string | null;
  lastError?: string | null;
}

export interface GithubRow {
  id: number;
  orgId: number;
  enabled: boolean;
  createdBy: number | null;
  createdAt: Date;
  config: GithubConfig;
}

function readMapping(value: unknown): GithubMapping | null {
  const m = value as Partial<GithubMapping> | null;
  if (!m || typeof m.streamId !== "number" || typeof m.repo !== "string" || m.repo.length === 0) return null;
  const direction: SyncDirection = m.direction === "in" || m.direction === "out" ? m.direction : "both";
  return {
    streamId: m.streamId,
    repo: m.repo.toLowerCase(),
    direction,
    mappedBy: typeof m.mappedBy === "number" ? m.mappedBy : null,
    mappedAt: typeof m.mappedAt === "string" ? m.mappedAt : new Date(0).toISOString(),
    lastSyncAt: typeof m.lastSyncAt === "string" ? m.lastSyncAt : null,
    lastError: typeof m.lastError === "string" ? m.lastError : null,
    lastImported: typeof m.lastImported === "number" ? m.lastImported : null,
  };
}

export function isGithubConfig(value: unknown): value is GithubConfig {
  const c = value as Partial<GithubConfig> | null;
  return !!c && typeof c.installationId === "number" && c.installationId > 0;
}

function asRow(row: typeof orgIntegrations.$inferSelect): GithubRow | null {
  const raw = row.config as unknown;
  if (!isGithubConfig(raw)) return null;
  const config: GithubConfig = {
    installationId: raw.installationId,
    account: (raw.account as InstallationAccount | null) ?? null,
    mappings: Array.isArray(raw.mappings) ? raw.mappings.map(readMapping).filter((m): m is GithubMapping => m !== null) : [],
    webhookSecret: typeof raw.webhookSecret === "string" ? raw.webhookSecret : undefined,
    installedBy: typeof raw.installedBy === "number" ? raw.installedBy : null,
    installedAt: typeof raw.installedAt === "string" ? raw.installedAt : undefined,
    lastEventAt: typeof raw.lastEventAt === "string" ? raw.lastEventAt : null,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
  };
  return { id: row.id, orgId: row.orgId, enabled: row.enabled, createdBy: row.createdBy, createdAt: row.createdAt, config };
}

export async function getGithubForOrg(orgId: number): Promise<GithubRow | null> {
  const [row] = await db
    .select()
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, GITHUB_KIND)))
    .orderBy(orgIntegrations.createdAt)
    .limit(1);
  return row ? asRow(row) : null;
}

async function allGithubRows(): Promise<GithubRow[]> {
  const rows = await db.select().from(orgIntegrations).where(eq(orgIntegrations.kind, GITHUB_KIND));
  return rows.map(asRow).filter((r): r is GithubRow => r !== null);
}

/**
 * Which organization a repository belongs to.
 *
 * The installation id and the repo list live inside a jsonb column and HeliosDB-Nano
 * does not carry Postgres's jsonb operators, so the (tiny — one row per org) set of
 * github rows is filtered in JS rather than SQL, exactly as the Slack adapter does for
 * its team id.
 */
export async function findMappingForRepo(repo: string, installationId?: number): Promise<{ row: GithubRow; mapping: GithubMapping } | null> {
  const wanted = repo.toLowerCase();
  for (const row of await allGithubRows()) {
    if (!row.enabled) continue;
    if (installationId !== undefined && row.config.installationId !== installationId) continue;
    const mapping = row.config.mappings.find((m) => m.repo === wanted);
    if (mapping) return { row, mapping };
  }
  return null;
}

export async function getGithubForInstallation(installationId: number): Promise<GithubRow | null> {
  for (const row of await allGithubRows()) {
    if (row.config.installationId === installationId) return row;
  }
  return null;
}

/** Every org row, for the webhook path that has only an installation id to go on. */
export async function githubRowsForInstallation(installationId: number): Promise<GithubRow[]> {
  return (await allGithubRows()).filter((row) => row.config.installationId === installationId);
}

export interface GithubInstall {
  installationId: number;
  account: InstallationAccount | null;
}

/** One install per org: re-installing replaces the installation id and keeps the mappings. */
export async function saveGithubInstall(orgId: number, userId: number, install: GithubInstall): Promise<GithubRow> {
  const existing = await getGithubForOrg(orgId);
  const config: GithubConfig = {
    installationId: install.installationId,
    account: install.account,
    mappings: existing?.config.mappings ?? [],
    webhookSecret: existing?.config.webhookSecret,
    installedBy: userId,
    installedAt: new Date().toISOString(),
    lastEventAt: existing?.config.lastEventAt ?? null,
    lastError: null,
  };
  if (existing) {
    const [row] = await db
      .update(orgIntegrations)
      .set({ config: config as unknown as Record<string, unknown>, enabled: true })
      .where(eq(orgIntegrations.id, existing.id))
      .returning();
    return asRow(row)!;
  }
  const [row] = await db
    .insert(orgIntegrations)
    .values({ orgId, kind: GITHUB_KIND, config: config as unknown as Record<string, unknown>, enabled: true, createdBy: userId })
    .returning();
  return asRow(row)!;
}

/** Merge a few fields into the stored config (last event, last error, webhook secret). */
export async function patchGithubConfig(orgId: number, patch: Partial<GithubConfig>): Promise<GithubRow | null> {
  const existing = await getGithubForOrg(orgId);
  if (!existing) return null;
  const config = { ...existing.config, ...patch } as GithubConfig;
  const [row] = await db
    .update(orgIntegrations)
    .set({ config: config as unknown as Record<string, unknown> })
    .where(eq(orgIntegrations.id, existing.id))
    .returning();
  return asRow(row);
}

/** Add or replace the mapping for one stream. A stream maps to at most one repository. */
export async function putMapping(orgId: number, mapping: GithubMapping): Promise<GithubRow | null> {
  const existing = await getGithubForOrg(orgId);
  if (!existing) return null;
  const kept = existing.config.mappings.filter((m) => m.streamId !== mapping.streamId);
  return patchGithubConfig(orgId, { mappings: [...kept, { ...mapping, repo: mapping.repo.toLowerCase() }] });
}

export async function removeMapping(orgId: number, streamId: number): Promise<{ row: GithubRow | null; removed: number }> {
  const existing = await getGithubForOrg(orgId);
  if (!existing) return { row: null, removed: 0 };
  const kept = existing.config.mappings.filter((m) => m.streamId !== streamId);
  const removed = existing.config.mappings.length - kept.length;
  if (removed === 0) return { row: existing, removed: 0 };
  return { row: await patchGithubConfig(orgId, { mappings: kept }), removed };
}

/** Record the outcome of a sync or a delivery against one mapping. */
export async function patchMapping(orgId: number, streamId: number, patch: Partial<GithubMapping>): Promise<GithubRow | null> {
  const existing = await getGithubForOrg(orgId);
  if (!existing) return null;
  const mappings = existing.config.mappings.map((m) => (m.streamId === streamId ? { ...m, ...patch } : m));
  return patchGithubConfig(orgId, { mappings });
}

export async function removeGithubForOrg(orgId: number): Promise<number> {
  const rows = await db
    .delete(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, GITHUB_KIND)))
    .returning({ id: orgIntegrations.id });
  return rows.length;
}

/** Unseal a per-install webhook secret, tolerating a hand-written plaintext value. */
export function webhookSecretOf(config: GithubConfig): string | undefined {
  if (!config.webhookSecret) return undefined;
  try {
    return decryptSecret(config.webhookSecret);
  } catch {
    return config.webhookSecret;
  }
}

export function sealWebhookSecret(plain: string): string {
  return encryptSecret(plain);
}
