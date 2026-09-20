import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { orgIntegrations } from "../../../db/schema";
import { decryptSecret, encryptSecret } from "../../crypto";
import { TEAMS_KIND } from "../shared/providers";

/**
 * One `org_integrations` row per organization with kind = "teams".
 *
 * The webhook secret is the whole credential — it both authenticates a delivery and
 * identifies the organization — so it is sealed with AES-256-GCM (server/crypto.ts) and
 * never returned to a client, exactly like the Slack bot token.
 */

export { TEAMS_KIND } from "../shared/providers";

export interface TeamsConfig {
  /** Sealed with server/crypto.ts. Never returned to a client. */
  secret: string;
  teamName: string | null;
  connectedBy?: number | null;
  connectedAt?: string;
  lastEventAt?: string | null;
  lastError?: string | null;
}

export interface TeamsRow {
  id: number;
  orgId: number;
  enabled: boolean;
  createdBy: number | null;
  createdAt: Date;
  config: TeamsConfig;
}

export function isTeamsConfig(value: unknown): value is TeamsConfig {
  const c = value as Partial<TeamsConfig> | null;
  return !!c && typeof c.secret === "string" && c.secret.length > 0;
}

function asRow(row: typeof orgIntegrations.$inferSelect): TeamsRow | null {
  const raw = row.config as unknown;
  if (!isTeamsConfig(raw)) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    config: {
      secret: raw.secret,
      teamName: typeof raw.teamName === "string" ? raw.teamName : null,
      connectedBy: typeof raw.connectedBy === "number" ? raw.connectedBy : null,
      connectedAt: typeof raw.connectedAt === "string" ? raw.connectedAt : undefined,
      lastEventAt: typeof raw.lastEventAt === "string" ? raw.lastEventAt : null,
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    },
  };
}

export async function getTeamsForOrg(orgId: number): Promise<TeamsRow | null> {
  const [row] = await db
    .select()
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, TEAMS_KIND)))
    .orderBy(orgIntegrations.createdAt)
    .limit(1);
  return row ? asRow(row) : null;
}

/**
 * Every connected Teams webhook.
 *
 * The route needs all of them at once: a delivery carries no organization, so the only
 * way to place it is to try each org's secret against the HMAC. The set is one row per
 * organization, and the comparison is constant-time per candidate.
 */
export async function allTeamsRows(): Promise<TeamsRow[]> {
  const rows = await db.select().from(orgIntegrations).where(eq(orgIntegrations.kind, TEAMS_KIND));
  return rows.map(asRow).filter((r): r is TeamsRow => r !== null && r.enabled);
}

export async function saveTeamsConnection(
  orgId: number,
  userId: number,
  input: { secret: string; teamName?: string | null },
): Promise<TeamsRow> {
  const existing = await getTeamsForOrg(orgId);
  const config: TeamsConfig = {
    secret: encryptSecret(input.secret),
    teamName: input.teamName ?? existing?.config.teamName ?? null,
    connectedBy: userId,
    connectedAt: new Date().toISOString(),
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
    .values({ orgId, kind: TEAMS_KIND, config: config as unknown as Record<string, unknown>, enabled: true, createdBy: userId })
    .returning();
  return asRow(row)!;
}

export async function patchTeamsConfig(orgId: number, patch: Partial<TeamsConfig>): Promise<TeamsRow | null> {
  const existing = await getTeamsForOrg(orgId);
  if (!existing) return null;
  const config = { ...existing.config, ...patch } as TeamsConfig;
  const [row] = await db
    .update(orgIntegrations)
    .set({ config: config as unknown as Record<string, unknown> })
    .where(eq(orgIntegrations.id, existing.id))
    .returning();
  return asRow(row);
}

export async function removeTeamsForOrg(orgId: number): Promise<number> {
  const rows = await db
    .delete(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, TEAMS_KIND)))
    .returning({ id: orgIntegrations.id });
  return rows.length;
}

/** Unseal a stored secret, tolerating a hand-written plaintext value. */
export function secretOf(config: TeamsConfig): string {
  if (!config.secret) return "";
  try {
    return decryptSecret(config.secret);
  } catch {
    return config.secret;
  }
}
