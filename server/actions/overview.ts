// overview actions — registered by importing this module (see ./index.ts).
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { ActionError, defineAction } from "./registry";
import { nextTask, queryTasks, taskQueryInput } from "../overview/query";
import { appStats, getApp, listApps, systemicStreams } from "../overview/apps";
import { orgStats } from "../overview/stats";
import { createWebhook, deleteWebhook, listWebhooks, testWebhook } from "../overview/integrations";
import { blockedStreamIds, streamBudgets } from "../usage/budget";
import { nextTaskExcludingStreams } from "../usage/nextTask";

/* ------------------------------------------------------------------ member+ */

const httpUrl = z
  .string()
  .max(500)
  .refine((u) => { try { const p = new URL(u).protocol; return p === "http:" || p === "https:"; } catch { return false; } }, "must be an http(s) URL");

defineAction({
  name: "app.list",
  title: "List apps",
  description: "Every app (product / service / codebase) the organization tracks, each with its open-task count, critical count, highest open priority and the streams touching it.",
  input: z.object({
    includeArchived: z.boolean().optional().describe("Include archived apps (default false)."),
  }),
  requiredRole: "member",
  surface: "overview",
  handler: async (args, ctx) => listApps(ctx.orgId, args.includeArchived ?? false),
});

defineAction({
  name: "app.get",
  title: "Get app",
  description: "One app with its URLs, repo, stack, streams and computed task counters.",
  input: z.object({ appId: z.number().int().positive().describe("App id, from app.list.") }),
  requiredRole: "member",
  surface: "overview",
  handler: async (args, ctx) => getApp(ctx.orgId, args.appId),
});

defineAction({
  name: "next_task",
  title: "Next task",
  description:
    "The single highest-priority task still worth starting (status backlog or triaged), plus `why` — the urgency/impact/effort arithmetic behind its score. " +
    "By default it only offers work nobody has claimed or work already assigned to you, which makes it safe to poll in an autonomous loop. " +
    "When the caller is an **agent** credential, streams whose `budgetMode` is `enforce` and whose month-to-date agent spend has reached their `agentBudgetUsd` are skipped, " +
    "and the skipped lanes come back in `skippedStreams` so the agent can say why it went elsewhere. A human caller is never budget-limited.",
  input: z.object({
    streamId: z.union([z.number().int().positive(), z.literal("none"), z.null()]).optional()
      .describe('Restrict to one stream, or null / "none" for work filed against no stream.'),
    appId: z.union([z.number().int().positive(), z.literal("none"), z.null()]).optional()
      .describe('Restrict to one app, or null / "none" for work filed against no app.'),
    assignee: z.union([z.literal("me"), z.literal("any"), z.literal("none"), z.null(), z.number().int().positive()]).optional()
      .describe('Override the default filter: "me", null / "none" (unassigned only), "any" (ignore assignment), or a user id.'),
  }),
  requiredRole: "member",
  surface: "overview",
  handler: async (args, ctx) => {
    // Enforcement is an agent-only rule, and the extra read only happens for an
    // agent credential: a human polling next_task pays nothing for a feature that
    // could never apply to them.
    if (ctx.authType !== "agent") return nextTask(args, ctx.orgId, ctx.userId);
    const blocked = await blockedStreamIds(ctx.orgId);
    if (blocked.length === 0) return nextTask(args, ctx.orgId, ctx.userId);
    const result = await nextTaskExcludingStreams(args, ctx.orgId, ctx.userId, blocked);
    const budgets = await streamBudgets(ctx.orgId);
    return {
      ...result,
      skippedStreams: budgets
        .filter((b) => blocked.includes(b.streamId))
        .map((b) => ({ streamId: b.streamId, name: b.name, budgetUsd: b.budgetUsd, spentUsd: b.spentUsd, mode: b.mode })),
    };
  },
});

defineAction({
  name: "tasks.query",
  title: "Query tasks",
  description:
    "Filter, sort and page the backlog server-side. Returns { items, total } so a caller can page without re-counting. " +
    "Completed and wontfix tasks are hidden unless includeCompleted is true or an explicit status list asks for them. " +
    'For streamId, appId and assignedTo, omitting the key means "no filter" while null (or the string "none") means ' +
    '"filed against nothing" — the same convention the Plan surface\'s task.list uses.',
  input: taskQueryInput,
  requiredRole: "member",
  surface: "overview",
  handler: async (args, ctx) => queryTasks(args, ctx.orgId, ctx.userId),
});

defineAction({
  name: "stream.systemic",
  title: "Systemic streams",
  description: "Streams whose work crosses several apps at once — the cross-cutting concerns worth fixing at the platform level rather than app by app.",
  input: z.object({
    minApps: z.number().int().min(1).max(50).optional().describe("Minimum number of apps a stream must touch (default 2)."),
  }),
  requiredRole: "member",
  surface: "overview",
  handler: async (args, ctx) => systemicStreams(ctx.orgId, args.minApps ?? 2),
});

/* ----------------------------------------------------------------- manager+ */

defineAction({
  name: "stats",
  title: "Organization stats",
  description:
    "KPI roll-up for the whole organization: task counts by status, counts by priority band (critical 75-100, high 50-74, medium 25-49, low 0-24), " +
    "overdue work, app and stream inventory, human vs agent seats, agent minutes/tokens/dollars (all-time and last 7 days), and the 20 most recent task events made by agents.",
  input: z.object({}),
  requiredRole: "manager",
  surface: "overview",
  handler: async (_args, ctx) => orgStats(ctx.orgId),
});

const KEY = /^[a-z0-9][a-z0-9._-]*$/;

defineAction({
  name: "app.create",
  title: "Create app",
  description: "Register an app the organization owns. `key` is the short slug used in tables and filters and must be unique within the organization.",
  input: z.object({
    key: z.string().min(1).max(64).describe("Short lowercase slug, e.g. `web` or `core-api`."),
    name: z.string().min(1).max(255).describe("Human-readable name."),
    urls: z.array(httpUrl).max(20).optional().describe("Live http(s) URLs for the app."),
    repo: z.string().max(255).optional().describe("Repository reference, e.g. `github:acme/web`."),
    stack: z.array(z.string().max(80)).max(30).optional().describe("Technologies, e.g. [\"Rust\",\"Postgres\"]."),
  }),
  requiredRole: "manager",
  surface: "overview",
  handler: async (args, ctx) => {
    const key = args.key.trim().toLowerCase();
    if (!KEY.test(key)) throw new ActionError("invalid", "key must be lowercase alphanumeric with . _ or -");
    const [clash] = await db.select({ id: apps.id }).from(apps).where(and(eq(apps.orgId, ctx.orgId), eq(apps.key, key))).limit(1);
    if (clash) throw new ActionError("conflict", `An app with key "${key}" already exists`);
    const [row] = await db
      .insert(apps)
      .values({ orgId: ctx.orgId, key, name: args.name.trim(), urls: args.urls ?? [], repo: args.repo?.trim() || null, stack: args.stack ?? [] })
      .returning();
    return getApp(ctx.orgId, row.id);
  },
});

defineAction({
  name: "app.update",
  title: "Update app",
  description: "Change an app's name, URLs, repo, stack or archived flag. Omitted fields are left alone. The key is immutable — it is what external references point at.",
  input: z.object({
    appId: z.number().int().positive().describe("App id, from app.list."),
    name: z.string().min(1).max(255).optional(),
    urls: z.array(httpUrl).max(20).optional(),
    repo: z.string().max(255).nullable().optional(),
    stack: z.array(z.string().max(80)).max(30).optional(),
    archived: z.boolean().optional().describe("Archive hides the app from app.list and the KPI count without deleting its history."),
  }),
  requiredRole: "manager",
  surface: "overview",
  handler: async (args, ctx) => {
    const { appId, ...rest } = args;
    const patch: Partial<typeof apps.$inferInsert> = {};
    if (rest.name !== undefined) patch.name = rest.name.trim();
    if (rest.urls !== undefined) patch.urls = rest.urls;
    if (rest.repo !== undefined) patch.repo = rest.repo === null ? null : rest.repo.trim() || null;
    if (rest.stack !== undefined) patch.stack = rest.stack;
    if (rest.archived !== undefined) patch.archived = rest.archived;
    if (Object.keys(patch).length === 0) return getApp(ctx.orgId, appId);
    const rows = await db.update(apps).set(patch).where(and(eq(apps.orgId, ctx.orgId), eq(apps.id, appId))).returning({ id: apps.id });
    if (rows.length === 0) throw new ActionError("not_found", `No app ${appId} in this organization`);
    return getApp(ctx.orgId, appId);
  },
});

defineAction({
  name: "app.stats",
  title: "App stats",
  description: "Open tasks, critical tasks (priority ≥ 75), highest open priority and the streams touching one app.",
  input: z.object({ appId: z.number().int().positive().describe("App id, from app.list.") }),
  requiredRole: "manager",
  surface: "overview",
  handler: async (args, ctx) => appStats(ctx.orgId, args.appId),
});

/* ------------------------------------------------------------------- admin+ */

defineAction({
  name: "webhook.list",
  title: "List webhooks",
  description: "Outgoing webhook subscriptions for this organization. Secrets are never returned — only whether one is set.",
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  handler: async (_args, ctx) => listWebhooks(ctx.orgId),
});

defineAction({
  name: "webhook.create",
  title: "Create webhook",
  description:
    "Subscribe a URL to task events. Each delivery is a JSON body {event, orgId, taskId, actor, payload, ts} with an " +
    "`X-PTD-Signature: sha256=<hex HMAC-SHA256 of the raw body>` header. A secret is generated when you omit one and shown exactly once.",
  input: z.object({
    url: z.string().min(1).max(500).describe("Absolute http(s) endpoint to POST to."),
    secret: z.string().min(8).max(200).optional().describe("HMAC key. Generated when omitted; returned once either way."),
    events: z.array(z.string().max(48)).max(30).optional().describe(
      'Event kinds to receive, or ["*"] for all (the default). Task kinds carry a taskId and a {old,new} diff: ' +
        "task.created, task.updated, task.completed, task.assigned, task.priority_changed, task.scheduled, task.unscheduled, " +
        "task.cascade_shifted, task.stream_moved, task.deleted. Stream kinds have no taskId: stream.created, stream.updated, " +
        "stream.renamed, stream.tasks_moved, stream.app_attached, stream.app_detached. webhook.test sends `ping`.",
    ),
  }),
  requiredRole: "admin",
  surface: "org",
  handler: async (args, ctx) => createWebhook(ctx.orgId, ctx.userId, args),
});

defineAction({
  name: "webhook.delete",
  title: "Delete webhook",
  description: "Remove a webhook subscription. Deliveries stop immediately.",
  input: z.object({ id: z.number().int().positive().describe("Webhook id, from webhook.list.") }),
  requiredRole: "admin",
  surface: "org",
  handler: async (args, ctx) => deleteWebhook(ctx.orgId, args.id),
});

defineAction({
  name: "webhook.test",
  title: "Test webhook",
  description: "Deliver a signed `ping` envelope through the real delivery path and report the HTTP status, so you can confirm the endpoint and the signature before relying on it.",
  input: z.object({ id: z.number().int().positive().describe("Webhook id, from webhook.list.") }),
  requiredRole: "admin",
  surface: "org",
  handler: async (args, ctx) => testWebhook(ctx.orgId, args.id, ctx.displayName),
});
