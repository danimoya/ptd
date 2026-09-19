import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { orgIntegrations } from "../../../db/schema";
import { decryptSecret, encryptSecret } from "../../crypto";

/**
 * Where a Slack install lives: one `org_integrations` row per organization with
 * kind = "slack". The bot token is sealed with AES-256-GCM (server/crypto.ts) and
 * never leaves the server; everything else in the config is safe to show an admin.
 */

export const SLACK_KIND = "slack";

export interface SlackConfig {
  teamId: string;
  teamName: string | null;
  botUserId: string | null;
  /** Sealed with server/crypto.ts. Never returned to a client. */
  botToken: string;
  /** Per-install signing secret; normally unset — the app-level env var is the source. */
  signingSecret?: string;
  /** Channel notifications go to (C… / G…). Null until an admin picks one. */
  channelId?: string | null;
  appId?: string | null;
  scope?: string | null;
  authedUserId?: string | null;
  installedBy?: number | null;
  installedAt?: string;
}

export interface SlackRow {
  id: number;
  orgId: number;
  enabled: boolean;
  createdBy: number | null;
  createdAt: Date;
  config: SlackConfig;
}

export function isSlackConfig(value: unknown): value is SlackConfig {
  const c = value as Partial<SlackConfig> | null;
  return !!c && typeof c.teamId === "string" && c.teamId.length > 0 && typeof c.botToken === "string";
}

function asRow(row: typeof orgIntegrations.$inferSelect): SlackRow | null {
  const config = row.config as unknown;
  if (!isSlackConfig(config)) return null;
  return { id: row.id, orgId: row.orgId, enabled: row.enabled, createdBy: row.createdBy, createdAt: row.createdAt, config };
}

export async function getSlackForOrg(orgId: number): Promise<SlackRow | null> {
  const [row] = await db
    .select()
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, SLACK_KIND)))
    .orderBy(orgIntegrations.createdAt)
    .limit(1);
  return row ? asRow(row) : null;
}

/**
 * Which organization a workspace belongs to. The team id lives inside a jsonb
 * column and HeliosDB-Nano does not carry Postgres's jsonb operators, so the
 * (tiny — one row per org) set of slack rows is filtered in JS rather than SQL.
 */
export async function getSlackForTeam(teamId: string): Promise<SlackRow | null> {
  const rows = await db.select().from(orgIntegrations).where(eq(orgIntegrations.kind, SLACK_KIND));
  for (const row of rows) {
    const parsed = asRow(row);
    if (parsed && parsed.config.teamId === teamId) return parsed;
  }
  return null;
}

export interface SlackInstall {
  teamId: string;
  teamName: string | null;
  botUserId: string | null;
  /** Plaintext — sealed here, before it touches the database. */
  botToken: string;
  appId?: string | null;
  scope?: string | null;
  authedUserId?: string | null;
}

/** One install per org: a second "Add to Slack" replaces the tokens and keeps the chosen channel. */
export async function saveSlackInstall(orgId: number, userId: number, install: SlackInstall): Promise<SlackRow> {
  const existing = await getSlackForOrg(orgId);
  const config: SlackConfig = {
    teamId: install.teamId,
    teamName: install.teamName,
    botUserId: install.botUserId,
    botToken: encryptSecret(install.botToken),
    appId: install.appId ?? null,
    scope: install.scope ?? null,
    authedUserId: install.authedUserId ?? null,
    channelId: existing?.config.teamId === install.teamId ? existing?.config.channelId ?? null : null,
    signingSecret: existing?.config.signingSecret,
    installedBy: userId,
    installedAt: new Date().toISOString(),
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
    .values({ orgId, kind: SLACK_KIND, config: config as unknown as Record<string, unknown>, enabled: true, createdBy: userId })
    .returning();
  return asRow(row)!;
}

/** Merge a few fields into the stored config (channel id, per-install signing secret). */
export async function patchSlackConfig(orgId: number, patch: Partial<SlackConfig>): Promise<SlackRow | null> {
  const existing = await getSlackForOrg(orgId);
  if (!existing) return null;
  const config = { ...existing.config, ...patch } as SlackConfig;
  const [row] = await db
    .update(orgIntegrations)
    .set({ config: config as unknown as Record<string, unknown> })
    .where(eq(orgIntegrations.id, existing.id))
    .returning();
  return asRow(row);
}

export async function removeSlackForOrg(orgId: number): Promise<number> {
  const rows = await db
    .delete(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, SLACK_KIND)))
    .returning({ id: orgIntegrations.id });
  return rows.length;
}

/** Unseal the bot token, tolerating a hand-written plaintext value (same posture as webhooks). */
export function botTokenOf(config: SlackConfig): string {
  if (!config.botToken) return "";
  try {
    return decryptSecret(config.botToken);
  } catch {
    return config.botToken;
  }
}
