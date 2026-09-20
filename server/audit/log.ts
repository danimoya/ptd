/**
 * The audit log: who did what, to what, from where.
 *
 * Deliberately not the same thing as `task_events`. That table is the history of
 * a task and is part of the product; this one is the history of *the account and
 * the organization* — sign-ins, role changes, credentials minted and revoked,
 * integrations connected, the plan changed, the data exported, the organization
 * deleted. An administrator reading it should be able to answer "who let this
 * happen, and when" without reading application logs.
 *
 * Writing a row never fails a request. An audit write that could 500 the
 * operation it describes would make the log a liability, so `audit()` swallows
 * its own errors and reports them to the server log instead.
 */
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Request } from "express";
import { db } from "../../db";
import { auditEvents, memberships, users } from "../../db/schema";
import type { ActionContext } from "../actions/registry";
import type { AuthenticatedRequest, OrgRequest } from "../types";
import { currentRequestFacts, factsOf } from "./context";

/** The kinds PTD writes itself. Action names are recorded verbatim alongside these. */
export const AUTH_KINDS = [
  "auth.login",
  "auth.login_failed",
  "auth.register",
  "auth.logout",
  "auth.password_reset_requested",
  "auth.password_reset",
  "auth.mfa_required",
  "auth.mfa_success",
  "auth.mfa_failed",
  "auth.recovery_code_used",
  "totp.enabled",
  "totp.disabled",
  "totp.recovery_regenerated",
  "oidc.login",
  "oidc.linked",
  "oidc.signup",
  "oidc.unlinked",
  "org.created",
  "org.deleted",
  "org.exported",
  "org.security_changed",
  "member.role_changed",
  "member.removed",
  "invite.code_regenerated",
  "invite.created",
  "token.minted",
  "token.revoked",
  "token.rotated",
  "agent.registered",
] as const;

export type AuditKind = (typeof AUTH_KINDS)[number] | string;

export interface AuditActor {
  /**
   * Omit it and the actor's oldest membership is used; pass `null` to mean "no
   * organization" on purpose. That distinction matters twice: a sign-in has no
   * org context at all but belongs in the org's log, and `org.deleted` must not
   * name an organization whose row is about to disappear under a foreign key.
   */
  orgId?: number | null;
  userId?: number | null;
  label?: string | null;
  ip?: string | null;
}

export type AuditSource = Request | ActionContext | AuditActor;

const SECRET_KEYS = /(password|secret|token|code|hash|credential|key|totp)/i;

/**
 * Meta is written verbatim into a JSONB column that an admin can read, so
 * anything that looks like a credential is replaced with a marker rather than
 * stored. A log that leaks the thing it is logging about is worse than no log.
 */
export function sanitiseMeta(meta: unknown, depth = 0): Record<string, unknown> | null {
  if (meta === null || meta === undefined) return null;
  if (typeof meta !== "object" || Array.isArray(meta)) return { value: clamp(meta, depth) };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.test(key) && typeof value !== "boolean" && typeof value !== "number" ? "[redacted]" : clamp(value, depth);
  }
  return out;
}

function clamp(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 2) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clamp(v, depth + 1));
  if (typeof value === "object") return sanitiseMeta(value, depth + 1);
  return String(value);
}

function isRequest(source: AuditSource): source is Request {
  return typeof (source as Request).header === "function";
}

function isActionContext(source: AuditSource): source is ActionContext {
  return typeof (source as ActionContext).via === "string" && typeof (source as ActionContext).userId === "number";
}

/**
 * Which organization an account-level event belongs to: the oldest membership,
 * the same one `resolveOrg` falls back to when no org is named. A person who
 * belongs to several organizations has their sign-ins recorded against that one
 * rather than copied into all of them.
 */
export async function primaryOrgId(userId: number): Promise<number | null> {
  const [row] = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(memberships.createdAt)
    .limit(1);
  return row?.orgId ?? null;
}

function actorFrom(source: AuditSource): AuditActor {
  if (isRequest(source)) {
    const r = source as Partial<OrgRequest> & Partial<AuthenticatedRequest>;
    const user = r.user?.[0];
    return {
      orgId: r.org?.id,
      userId: user?.id ?? null,
      label: user ? `${user.displayName} <${user.email}>` : null,
      ip: factsOf(source).ip,
    };
  }
  if (isActionContext(source)) {
    return {
      orgId: source.orgId,
      userId: source.userId,
      label: `${source.displayName} <${source.email}>`,
      ip: currentRequestFacts()?.ip ?? null,
    };
  }
  return { ...source, ip: source.ip ?? currentRequestFacts()?.ip ?? null };
}

/**
 * Write one audit row. Fire-and-forget by design — callers do not await it and it
 * cannot throw, so an unreachable database breaks nothing but the log itself.
 */
export function audit(source: AuditSource, kind: AuditKind, target?: string | number | null, meta?: unknown): Promise<void> {
  const actor = actorFrom(source);
  const name = String(kind).slice(0, 48);
  return (async () => {
    const orgId =
      actor.orgId === undefined && typeof actor.userId === "number" ? await primaryOrgId(actor.userId) : (actor.orgId ?? null);
    await db.insert(auditEvents).values({
      orgId,
      actorUserId: actor.userId ?? null,
      actorLabel: actor.label ?? null,
      kind: name,
      target: target === null || target === undefined ? null : String(target).slice(0, 120),
      meta: sanitiseMeta(meta),
      ip: actor.ip ? actor.ip.slice(0, 64) : null,
    });
  })().catch((err) => {
    console.error(`[audit] could not record ${name}:`, err instanceof Error ? err.message : err);
  });
}

/* ── Reading ─────────────────────────────────────────────────────────── */

export interface AuditRow {
  id: number;
  kind: string;
  target: string | null;
  actorUserId: number | null;
  actorLabel: string | null;
  actorEmail: string | null;
  ip: string | null;
  meta: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AuditQuery {
  orgId: number;
  from?: Date;
  to?: Date;
  kind?: string;
  limit?: number;
  offset?: number;
}

export const AUDIT_PAGE_LIMIT = 200;

export async function listAuditEvents(query: AuditQuery): Promise<{ rows: AuditRow[]; total: number }> {
  const filters = [eq(auditEvents.orgId, query.orgId)];
  if (query.from) filters.push(gte(auditEvents.createdAt, query.from));
  if (query.to) filters.push(lte(auditEvents.createdAt, query.to));
  // A trailing dot means "everything under this prefix": kind=token. matches
  // token.minted and token.revoked without the caller listing them.
  if (query.kind) {
    filters.push(query.kind.endsWith(".") ? sql`${auditEvents.kind} LIKE ${`${query.kind}%`}` : eq(auditEvents.kind, query.kind));
  }
  const where = and(...filters);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(auditEvents).where(where);
  const rows = await db
    .select({
      id: auditEvents.id,
      kind: auditEvents.kind,
      target: auditEvents.target,
      actorUserId: auditEvents.actorUserId,
      actorLabel: auditEvents.actorLabel,
      actorEmail: users.email,
      ip: auditEvents.ip,
      meta: auditEvents.meta,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .leftJoin(users, eq(auditEvents.actorUserId, users.id))
    .where(where)
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(Math.min(query.limit ?? 50, AUDIT_PAGE_LIMIT))
    .offset(query.offset ?? 0);
  return { rows: rows as AuditRow[], total: Number(count) };
}

/** Every row in the range, oldest first — what `audit.export` streams as CSV. */
export async function allAuditEvents(query: Omit<AuditQuery, "limit" | "offset">): Promise<AuditRow[]> {
  const filters = [eq(auditEvents.orgId, query.orgId)];
  if (query.from) filters.push(gte(auditEvents.createdAt, query.from));
  if (query.to) filters.push(lte(auditEvents.createdAt, query.to));
  if (query.kind) filters.push(eq(auditEvents.kind, query.kind));
  const rows = await db
    .select({
      id: auditEvents.id,
      kind: auditEvents.kind,
      target: auditEvents.target,
      actorUserId: auditEvents.actorUserId,
      actorLabel: auditEvents.actorLabel,
      actorEmail: users.email,
      ip: auditEvents.ip,
      meta: auditEvents.meta,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .leftJoin(users, eq(auditEvents.actorUserId, users.id))
    .where(and(...filters))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
  return rows as AuditRow[];
}

/** Which kinds this organization has actually produced — the filter's options. */
export async function auditKinds(orgId: number): Promise<{ kind: string; count: number }[]> {
  const rows = await db
    .select({ kind: auditEvents.kind, count: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(eq(auditEvents.orgId, orgId))
    .groupBy(auditEvents.kind)
    .orderBy(auditEvents.kind);
  return rows.map((r) => ({ kind: r.kind, count: Number(r.count) }));
}
