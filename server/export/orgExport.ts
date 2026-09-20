/**
 * Everything one organization has, as a ZIP a person can open.
 *
 * Shape follows what the data *is*, not what our tables are: CSV for the rows a
 * spreadsheet should open (members, streams, apps, tasks, events, time, audit),
 * JSON where the row has nested structure worth keeping (the organization itself,
 * invoices with their signed snapshot). A `README.txt` names every file, because
 * an export nobody can interpret is not portability.
 *
 * Handed over through a one-time token rather than an action result: a ZIP is
 * binary and can be megabytes, and the action surface answers JSON. The token
 * lives in memory for five minutes, is single-use, and carries the org and the
 * user it was minted for — so the download is still authorised, just not by a
 * header the browser cannot attach to a plain link.
 */
import { randomBytes } from "crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  apps,
  auditEvents,
  invoices,
  memberships,
  organizations,
  streams,
  taskEvents,
  tasks,
  timeEntries,
  users,
} from "../../db/schema";
import { getOrgSecurity } from "../auth/security";
import { toCsv } from "./csv";
import { zipStore, type ZipEntry } from "./zip";

export const EXPORT_TOKEN_TTL_MS = 5 * 60 * 1000;

interface ExportGrant {
  orgId: number;
  userId: number;
  expiresAt: number;
  filename: string;
}

const grants = new Map<string, ExportGrant>();

function sweep() {
  const now = Date.now();
  for (const [token, grant] of grants) if (grant.expiresAt <= now) grants.delete(token);
}

export function mintExportToken(orgId: number, userId: number, filename: string): { token: string; expiresAt: Date } {
  sweep();
  const token = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + EXPORT_TOKEN_TTL_MS;
  grants.set(token, { orgId, userId, expiresAt, filename });
  return { token, expiresAt: new Date(expiresAt) };
}

/** Single use: the grant is deleted the moment it is read, success or failure. */
export function redeemExportToken(token: string): ExportGrant | null {
  sweep();
  const grant = grants.get(token);
  if (!grant) return null;
  grants.delete(token);
  if (grant.expiresAt <= Date.now()) return null;
  return grant;
}

export function exportFilename(slug: string, at = new Date()): string {
  const stamp = at.toISOString().slice(0, 10);
  return `ptd-${slug.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "organization"}-${stamp}.zip`;
}

export interface ExportSummary {
  members: number;
  apps: number;
  streams: number;
  tasks: number;
  taskEvents: number;
  timeEntries: number;
  invoices: number;
  auditEvents: number;
}

export interface OrgExport {
  zip: Buffer;
  filename: string;
  summary: ExportSummary;
}

const MEMBER_COLUMNS = ["userId", "email", "displayName", "isAgent", "role", "billable", "hourlyRate", "currency", "requireApproval", "joinedAt"];
const APP_COLUMNS = ["id", "key", "name", "urls", "repo", "stack", "archived", "createdAt"];
const STREAM_COLUMNS = ["id", "name", "color", "customerId", "archived", "position", "hourlyRate", "agentBudgetUsd", "budgetMode", "createdAt"];
const TASK_COLUMNS = [
  "id", "title", "description", "status", "streamId", "appId", "assignedTo", "startDate", "dueDate",
  "estimatedDuration", "dependencies", "externalKey", "urgency", "impact", "effort", "priorityScore",
  "prioritySource", "tags", "completed", "createdBy", "createdAt", "updatedAt",
];
const TASK_EVENT_COLUMNS = ["id", "taskId", "actorUserId", "actorLabel", "kind", "changes", "note", "via", "createdAt"];
const TIME_COLUMNS = [
  "id", "userId", "customerId", "streamId", "taskId", "checkIn", "checkOut", "isBreak", "notes",
  "entrySource", "agentLabel", "tokensUsed", "apiCostUsd", "approvalStatus", "approvedBy", "approvedAt",
  "verifiedTokens", "verifiedCostUsd", "verifiedSource", "createdAt",
];
const AUDIT_COLUMNS = ["id", "createdAt", "kind", "target", "actorUserId", "actorLabel", "ip", "meta"];

/** Build the archive. One pass per table, ordered by id so two exports diff cleanly. */
export async function buildOrgExport(orgId: number, actor: { email: string; displayName: string }): Promise<OrgExport> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new Error(`Organization ${orgId} not found`);

  const memberRows = await db
    .select({
      userId: memberships.userId,
      email: users.email,
      displayName: users.displayName,
      isAgent: users.isAgent,
      role: memberships.role,
      billable: memberships.billable,
      hourlyRate: memberships.hourlyRate,
      currency: memberships.currency,
      requireApproval: memberships.requireApproval,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(memberships.createdAt));

  const appRows = await db.select().from(apps).where(eq(apps.orgId, orgId)).orderBy(asc(apps.id));
  const streamRows = await db.select().from(streams).where(eq(streams.orgId, orgId)).orderBy(asc(streams.id));
  const taskRows = await db.select().from(tasks).where(eq(tasks.orgId, orgId)).orderBy(asc(tasks.id));
  const eventRows = await db.select().from(taskEvents).where(eq(taskEvents.orgId, orgId)).orderBy(asc(taskEvents.id));
  const timeRows = await db.select().from(timeEntries).where(eq(timeEntries.orgId, orgId)).orderBy(asc(timeEntries.id));
  const invoiceRows = await db.select().from(invoices).where(eq(invoices.orgId, orgId)).orderBy(asc(invoices.id));
  const auditRows = await db.select().from(auditEvents).where(eq(auditEvents.orgId, orgId)).orderBy(asc(auditEvents.id));
  const security = await getOrgSecurity(orgId);

  const summary: ExportSummary = {
    members: memberRows.length,
    apps: appRows.length,
    streams: streamRows.length,
    tasks: taskRows.length,
    taskEvents: eventRows.length,
    timeEntries: timeRows.length,
    invoices: invoiceRows.length,
    auditEvents: auditRows.length,
  };

  const organization = {
    exportedAt: new Date().toISOString(),
    exportedBy: { email: actor.email, displayName: actor.displayName },
    generator: "PTD org.export v1",
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      createdAt: org.createdAt,
      // Stripe identifiers are deliberately absent: they are our billing
      // bookkeeping, not the organization's data, and they are not useful to
      // whoever reads this archive.
      security: { requireTotp: security.requireTotp, updatedAt: security.updatedAt },
    },
    counts: summary,
  };

  const readme = [
    `PTD export — ${org.name} (${org.slug})`,
    `Taken ${organization.exportedAt} by ${actor.displayName} <${actor.email}>.`,
    "",
    "organization.json  the organization, its plan, its security policy and row counts",
    "members.csv        every seat: humans and agents, their role and billing terms",
    "apps.csv           products, services and codebases",
    "streams.csv        swim-lanes / projects",
    "tasks.csv          every task, with its priority inputs and dependencies (JSON arrays)",
    "task_events.csv    the history of every task: who changed what, when, through which surface",
    "time_entries.csv   every check-in and check-out, human and agent, with cost where recorded",
    "invoices.json      invoices with their signed snapshot, verbatim",
    "audit_events.csv   the account and organization audit log",
    "",
    "CSV is RFC 4180: UTF-8, CRLF line endings, embedded quotes doubled. JSON columns",
    "(dependencies, tags, changes, meta) are stored as JSON text inside their cell.",
    "",
    "Timestamps are ISO 8601 in UTC.",
  ].join("\n");

  const entries: ZipEntry[] = [
    { name: "README.txt", data: readme },
    { name: "organization.json", data: JSON.stringify(organization, null, 2) },
    { name: "members.csv", data: toCsv(MEMBER_COLUMNS, memberRows as unknown as Record<string, unknown>[]) },
    { name: "apps.csv", data: toCsv(APP_COLUMNS, appRows as unknown as Record<string, unknown>[]) },
    { name: "streams.csv", data: toCsv(STREAM_COLUMNS, streamRows as unknown as Record<string, unknown>[]) },
    { name: "tasks.csv", data: toCsv(TASK_COLUMNS, taskRows as unknown as Record<string, unknown>[]) },
    { name: "task_events.csv", data: toCsv(TASK_EVENT_COLUMNS, eventRows as unknown as Record<string, unknown>[]) },
    { name: "time_entries.csv", data: toCsv(TIME_COLUMNS, timeRows as unknown as Record<string, unknown>[]) },
    { name: "invoices.json", data: JSON.stringify(invoiceRows, null, 2) },
    { name: "audit_events.csv", data: toCsv(AUDIT_COLUMNS, auditRows as unknown as Record<string, unknown>[]) },
  ];

  return { zip: zipStore(entries), filename: exportFilename(org.slug), summary };
}

/**
 * Delete an organization. Every table that hangs off it is declared ON DELETE
 * CASCADE, so one statement is the whole operation — but the seats are not: a
 * user who belongs to other organizations must survive, and an agent seat that
 * existed only for this one has nothing left to belong to, so it goes with it.
 */
export async function deleteOrganization(orgId: number): Promise<{ deletedOrg: boolean; deletedAgents: number }> {
  const agentIds = (
    await db
      .select({ id: users.id })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.orgId, orgId))
  ).map((r) => r.id);

  const agentsOnlyHere: number[] = [];
  for (const id of agentIds) {
    const rows = await db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, id));
    const [user] = await db.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, id)).limit(1);
    if (user?.isAgent && rows.length === 1 && rows[0].orgId === orgId) agentsOnlyHere.push(id);
  }

  await db.delete(organizations).where(eq(organizations.id, orgId));
  if (agentsOnlyHere.length > 0) await db.delete(users).where(inArray(users.id, agentsOnlyHere));
  return { deletedOrg: true, deletedAgents: agentsOnlyHere.length };
}
