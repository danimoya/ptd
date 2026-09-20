/**
 * Organization security policy — today exactly one switch: `requireTotp`.
 *
 * The schema is fixed, and `organizations` has no settings column, so the policy
 * lives in `org_integrations` under the kind `security`: one row per
 * organization, a JSON body, the same table every other per-org setting already
 * uses. Nothing else reads that kind, and the integrations UI lists its own
 * kinds explicitly, so the row is invisible to it.
 *
 * Cached for a few seconds because `resolveOrg` consults it on every org-scoped
 * request; a policy change invalidates the entry immediately, so the cache is
 * only ever a shortcut for the unchanged case.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { orgIntegrations } from "../../db/schema";

export const SECURITY_KIND = "security";
const TTL_MS = 5_000;

export interface OrgSecurity {
  /** Members must have TOTP enabled before any org-scoped call is allowed. */
  requireTotp: boolean;
  updatedAt: string | null;
  updatedBy: number | null;
}

export const DEFAULT_SECURITY: OrgSecurity = { requireTotp: false, updatedAt: null, updatedBy: null };

const cache = new Map<number, { at: number; value: OrgSecurity }>();

export function invalidateOrgSecurity(orgId?: number) {
  if (orgId === undefined) cache.clear();
  else cache.delete(orgId);
}

function shape(config: Record<string, unknown> | null | undefined): OrgSecurity {
  return {
    requireTotp: config?.requireTotp === true,
    updatedAt: typeof config?.updatedAt === "string" ? config.updatedAt : null,
    updatedBy: typeof config?.updatedBy === "number" ? config.updatedBy : null,
  };
}

export async function getOrgSecurity(orgId: number): Promise<OrgSecurity> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const [row] = await db
    .select({ config: orgIntegrations.config })
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, SECURITY_KIND)))
    .limit(1);
  const value = shape(row?.config as Record<string, unknown> | undefined);
  cache.set(orgId, { at: Date.now(), value });
  return value;
}

export async function setOrgSecurity(orgId: number, patch: { requireTotp?: boolean }, actorUserId: number): Promise<OrgSecurity> {
  const current = await getOrgSecurity(orgId);
  const next: OrgSecurity = {
    requireTotp: patch.requireTotp ?? current.requireTotp,
    updatedAt: new Date().toISOString(),
    updatedBy: actorUserId,
  };
  const [existing] = await db
    .select({ id: orgIntegrations.id })
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, SECURITY_KIND)))
    .limit(1);
  if (existing) {
    await db.update(orgIntegrations).set({ config: { ...next } }).where(eq(orgIntegrations.id, existing.id));
  } else {
    await db.insert(orgIntegrations).values({ orgId, kind: SECURITY_KIND, config: { ...next }, createdBy: actorUserId });
  }
  invalidateOrgSecurity(orgId);
  return next;
}
