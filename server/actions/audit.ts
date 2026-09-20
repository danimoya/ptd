/**
 * The audit log, readable.
 *
 * Also the one place that connects the registry's `audited` flag to the audit
 * table: importing this module installs the post-run hook, so a definition marked
 * `audited: true` anywhere in the codebase writes a row without its handler
 * knowing anything about it.
 */
import { z } from "zod";
import { ActionError, defineAction, setActionAuditHook } from "./registry";
import { allAuditEvents, audit, auditKinds, listAuditEvents, AUDIT_PAGE_LIMIT } from "../audit/log";
import { toCsv } from "../export/csv";
import { assertFeature } from "../billing/gate";

/**
 * What the row's `target` should say. Actions name their subject with whichever
 * of these fields they happen to have; the first one present wins, and an action
 * with none of them simply has no target (its name and args are still recorded).
 */
const TARGET_KEYS = [
  "email", "userId", "memberUserId", "invitationId", "tokenId", "identityId",
  "streamId", "taskId", "appId", "customerId", "invoiceId", "id",
  "repo", "channel", "url", "name", "confirmName",
] as const;

export function deriveTarget(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") continue;
    return key === "email" || key === "name" || key === "confirmName" ? String(value) : `${key}:${value}`;
  }
  return null;
}

setActionAuditHook(({ def, args, ctx }) => {
  // `audit` sanitises the meta it is given, so an action whose arguments carry a
  // secret (a webhook secret, a bot token) records "[redacted]" rather than it.
  audit(ctx, def.name, deriveTarget(args), { args, via: ctx.via, surface: def.surface });
});

const rangeShape = {
  from: z.string().datetime().optional().describe("ISO 8601 lower bound, inclusive."),
  to: z.string().datetime().optional().describe("ISO 8601 upper bound, inclusive."),
  kind: z
    .string()
    .min(1)
    .max(48)
    .optional()
    .describe('One kind, e.g. "member.role_changed". A trailing dot is a prefix: "token." matches every token event.'),
};

function bounds(args: { from?: string; to?: string }): { from?: Date; to?: Date } {
  const from = args.from ? new Date(args.from) : undefined;
  const to = args.to ? new Date(args.to) : undefined;
  if (from && Number.isNaN(from.getTime())) throw new ActionError("invalid", "from is not a date");
  if (to && Number.isNaN(to.getTime())) throw new ActionError("invalid", "to is not a date");
  if (from && to && from > to) throw new ActionError("invalid", "from is after to");
  return { from, to };
}

defineAction({
  name: "audit.list",
  title: "Read the audit log",
  description:
    "Who did what in this organization, newest first: sign-ins and failed sign-ins, 2FA turned on or off, providers linked, roles changed, members removed, " +
    "tokens minted and revoked, agents registered, integrations connected and disconnected, billing opened, the security policy changed, data exported. " +
    `Filterable by date range and kind, paged up to ${AUDIT_PAGE_LIMIT} rows. Returns the kinds this organization has actually produced, for building a filter.`,
  input: z.object({
    ...rangeShape,
    limit: z.number().int().min(1).max(AUDIT_PAGE_LIMIT).optional().describe(`Rows to return (default 50, max ${AUDIT_PAGE_LIMIT}).`),
    offset: z.number().int().min(0).optional(),
  }),
  requiredRole: "admin",
  surface: "org",
  handler: async (args, ctx) => {
    const { from, to } = bounds(args);
    const page = await listAuditEvents({ orgId: ctx.orgId, from, to, kind: args.kind, limit: args.limit, offset: args.offset });
    return {
      total: page.total,
      limit: args.limit ?? 50,
      offset: args.offset ?? 0,
      kinds: await auditKinds(ctx.orgId),
      events: page.rows.map((row) => ({
        id: row.id,
        at: row.createdAt,
        kind: row.kind,
        target: row.target,
        actor: row.actorLabel ?? row.actorEmail ?? (row.actorUserId ? `user:${row.actorUserId}` : "—"),
        actorUserId: row.actorUserId,
        ip: row.ip,
        meta: row.meta,
      })),
    };
  },
});

export const AUDIT_CSV_COLUMNS = ["id", "at", "kind", "target", "actor", "actorUserId", "ip", "meta"];

defineAction({
  name: "audit.export",
  title: "Export the audit log as CSV",
  description:
    "Every audit row in the range as one CSV document (RFC 4180, UTF-8), oldest first, so it can be filed, diffed or handed to an auditor. " +
    "No paging: the whole range comes back in `csv`. Narrow it with from/to on a busy organization.",
  input: z.object(rangeShape),
  requiredRole: "admin",
  surface: "org",
  audited: true,
  handler: async (args, ctx) => {
    // Hosted: taking the audit log out as a document is part of Business. Reading it
    // in the app (`audit.list`) stays open to every plan — a log you cannot read is
    // not a log — and so does `org.export`, because your data is yours on any plan.
    await assertFeature(ctx.orgId, "audit_export", "Exporting the audit log as CSV");
    const { from, to } = bounds(args);
    const rows = await allAuditEvents({ orgId: ctx.orgId, from, to, kind: args.kind });
    const csv = toCsv(
      AUDIT_CSV_COLUMNS,
      rows.map((row) => ({
        id: row.id,
        at: row.createdAt.toISOString(),
        kind: row.kind,
        target: row.target,
        actor: row.actorLabel ?? row.actorEmail ?? "",
        actorUserId: row.actorUserId,
        ip: row.ip,
        meta: row.meta ? JSON.stringify(row.meta) : "",
      })),
    );
    return {
      filename: `ptd-audit-${ctx.orgId}-${new Date().toISOString().slice(0, 10)}.csv`,
      rows: rows.length,
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      csv,
    };
  },
});
