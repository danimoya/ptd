import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { orgIntegrations } from "../../../db/schema";
import { TELEGRAM_KIND } from "../shared/providers";

/**
 * One `org_integrations` row per organization with kind = "telegram".
 *
 * There is no secret in it: the bot token is a deployment-wide env var and the webhook
 * path secret is derived from it, so what this row carries is the fact that *this*
 * organization turned Telegram on, plus the bot's @username for the UI. That matters
 * because the bot is shared — the row is how an organization opts in to minting link
 * codes and receiving DMs, rather than inheriting them from another tenant's setup.
 */

export { TELEGRAM_KIND } from "../shared/providers";

export interface TelegramConfig {
  botUsername: string | null;
  botId: number | null;
  webhookUrl?: string | null;
  webhookSetAt?: string | null;
  registeredBy?: number | null;
  lastError?: string | null;
}

export interface TelegramRow {
  id: number;
  orgId: number;
  enabled: boolean;
  createdBy: number | null;
  createdAt: Date;
  config: TelegramConfig;
}

export function isTelegramConfig(value: unknown): value is TelegramConfig {
  return typeof value === "object" && value !== null && "botUsername" in (value as Record<string, unknown>);
}

function asRow(row: typeof orgIntegrations.$inferSelect): TelegramRow | null {
  const raw = row.config as unknown;
  if (!isTelegramConfig(raw)) return null;
  const c = raw as Partial<TelegramConfig>;
  return {
    id: row.id,
    orgId: row.orgId,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    config: {
      botUsername: typeof c.botUsername === "string" ? c.botUsername : null,
      botId: typeof c.botId === "number" ? c.botId : null,
      webhookUrl: typeof c.webhookUrl === "string" ? c.webhookUrl : null,
      webhookSetAt: typeof c.webhookSetAt === "string" ? c.webhookSetAt : null,
      registeredBy: typeof c.registeredBy === "number" ? c.registeredBy : null,
      lastError: typeof c.lastError === "string" ? c.lastError : null,
    },
  };
}

export async function getTelegramForOrg(orgId: number): Promise<TelegramRow | null> {
  const [row] = await db
    .select()
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, TELEGRAM_KIND)))
    .orderBy(orgIntegrations.createdAt)
    .limit(1);
  return row ? asRow(row) : null;
}

export async function saveTelegramRegistration(orgId: number, userId: number, config: TelegramConfig): Promise<TelegramRow> {
  const existing = await getTelegramForOrg(orgId);
  const merged: TelegramConfig = { ...existing?.config, ...config, registeredBy: userId };
  if (existing) {
    const [row] = await db
      .update(orgIntegrations)
      .set({ config: merged as unknown as Record<string, unknown>, enabled: true })
      .where(eq(orgIntegrations.id, existing.id))
      .returning();
    return asRow(row)!;
  }
  const [row] = await db
    .insert(orgIntegrations)
    .values({ orgId, kind: TELEGRAM_KIND, config: merged as unknown as Record<string, unknown>, enabled: true, createdBy: userId })
    .returning();
  return asRow(row)!;
}

export async function patchTelegramConfig(orgId: number, patch: Partial<TelegramConfig>): Promise<TelegramRow | null> {
  const existing = await getTelegramForOrg(orgId);
  if (!existing) return null;
  const config = { ...existing.config, ...patch } as TelegramConfig;
  const [row] = await db
    .update(orgIntegrations)
    .set({ config: config as unknown as Record<string, unknown> })
    .where(eq(orgIntegrations.id, existing.id))
    .returning();
  return asRow(row);
}

export async function removeTelegramForOrg(orgId: number): Promise<number> {
  const rows = await db
    .delete(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, TELEGRAM_KIND)))
    .returning({ id: orgIntegrations.id });
  return rows.length;
}
