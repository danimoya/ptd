import type { Express, Request, Response } from "express";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { db } from "../db";
import {
  users,
  workspaces,
  memberships,
  apiTokens,
  projects,
  tasks,
  timeEntries,
  type User,
} from "../db/schema";

/**
 * Agent surface for TimeTracker:
 *   GET  /.well-known/ai-agent.json   — public discovery manifest
 *   GET  /api/agent/discovery         — alias of the above
 *   POST /api/agent/register          — public; creates a service account
 *                                       + workspace + initial bearer token
 *   POST /mcp                         — bearer-auth MCP server (Streamable
 *                                       HTTP) exposing project/task/time
 *                                       tools so an agent in Claude Code
 *                                       can log time against any card.
 *
 * Bearer token format: ttm_{8 hex prefix}{32 hex secret}.
 * The existing `auth` middleware (auth.ts) accepts both JWTs and ttm_…
 * tokens, so REST endpoints work for agents transparently.
 */

const scrypt = promisify(scryptCb);

const TOKEN_PREFIX = "ttm_";

/* ───────────────────── Token helpers ───────────────────── */

interface MintedToken {
  id: number;
  prefix: string;
  secret: string;
  name: string;
}

async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scrypt(secret, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function verifySecret(supplied: string, stored: string): Promise<boolean> {
  const [hashedHex, salt] = stored.split(".");
  if (!hashedHex || !salt) return false;
  const expected = Buffer.from(hashedHex, "hex");
  const actual = (await scrypt(supplied, salt, 64)) as Buffer;
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function mintToken(
  userId: number,
  workspaceId: number,
  name: string
): Promise<MintedToken> {
  const prefix = randomBytes(4).toString("hex");
  const body = randomBytes(16).toString("hex");
  const fullSecret = `${TOKEN_PREFIX}${prefix}${body}`;
  const hash = await hashSecret(body);

  const [created] = await db
    .insert(apiTokens)
    .values({ userId, workspaceId, name, prefix, hash })
    .returning();

  return { id: created.id, prefix, secret: fullSecret, name: created.name };
}

const lastUsedCache = new Map<string, number>();
const TOUCH_DEBOUNCE_MS = 60_000;

async function touchLastUsed(prefix: string): Promise<void> {
  const now = Date.now();
  if (now - (lastUsedCache.get(prefix) ?? 0) < TOUCH_DEBOUNCE_MS) return;
  lastUsedCache.set(prefix, now);
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.prefix, prefix));
}

/**
 * Verify an Authorization: Bearer ttm_… header and return the bound user
 * with their primary workspace membership. Returns null on any failure;
 * never throws.
 */
export async function verifyApiToken(
  authHeader: string | undefined
): Promise<{ user: User; workspaceId: number } | null> {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const supplied = m[1].trim();
  if (!supplied.startsWith(TOKEN_PREFIX)) return null;
  const body = supplied.slice(TOKEN_PREFIX.length);
  if (body.length !== 8 + 32) return null;
  const prefix = body.slice(0, 8);
  const secret = body.slice(8);

  const [row] = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.prefix, prefix))
    .limit(1);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;
  const ok = await verifySecret(secret, row.hash);
  if (!ok) return null;

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user) return null;

  touchLastUsed(prefix).catch(() => {});
  return { user, workspaceId: row.workspaceId };
}

/* ───────────────────── Agent signup ───────────────────── */

const registerSchema = z
  .object({
    name: z.string().min(1).max(80),
    email: z.string().email().optional(),
    workspaceName: z.string().min(1).max(255).optional(),
    inviteToken: z.string().min(1).max(64).optional(),
  })
  .refine((d) => !((d.inviteToken ?? "").trim() && (d.workspaceName ?? "").trim()), {
    message: "inviteToken and workspaceName are mutually exclusive",
    path: ["workspaceName"],
  });

function slugify(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return cleaned || "anon";
}

/* ───────────────────── Manifest ───────────────────── */

const MANIFEST = {
  service: "timetracker",
  title: "TimeTracker — daily ledger of hours",
  version: "0.1.0",
  description:
    "Per-user time tracking, attributable to customer / project / task. Pairs with Kanttban: Stream ↔ Project, Card ↔ Task.",
  auth: {
    scheme: "Bearer",
    token_format: "ttm_<8-hex-prefix><32-hex-secret>",
    header_example: "Authorization: Bearer ttm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    signup: {
      method: "POST",
      url: "/api/agent/register",
      body_fields: {
        name: "string (required)",
        email: "string (optional, derived if omitted)",
        workspaceName: "string (optional, default: '<name> workspace')",
        inviteToken: "string (optional). Mutually exclusive with workspaceName.",
      },
    },
  },
  endpoints: {
    mcp: {
      url: "/mcp",
      transport: "streamable-http",
      method: "POST",
      auth: "bearer",
    },
    rest_base: "/api",
    discovery: "/.well-known/ai-agent.json",
  },
  mcp: {
    server_info: {
      name: "timetracker",
      title: "TimeTracker",
      version: "0.1.0",
    },
    tools: [
      {
        name: "whoami",
        title: "Identify the calling token",
        description: "Returns the user + workspace the bearer token resolves to.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "project.list",
        title: "List projects",
        description: "Projects in the caller's workspace, optionally filtered by archived flag.",
        input_schema: {
          type: "object",
          properties: { includeArchived: { type: "boolean" } },
        },
      },
      {
        name: "task.list",
        title: "List tasks",
        description: "Tasks in the workspace, optionally scoped to a project.",
        input_schema: {
          type: "object",
          properties: {
            projectId: { type: "integer" },
            includeArchived: { type: "boolean" },
          },
        },
      },
      {
        name: "task.find_or_create",
        title: "Find or create a task by external ref",
        description:
          "Look up a task by (projectId, externalRef); create it with the given title if it doesn't exist. Idempotent — call this from your editor when you start working on, e.g., a Kanttban card.",
        input_schema: {
          type: "object",
          required: ["projectId", "title", "externalRef"],
          properties: {
            projectId: { type: "integer" },
            title: { type: "string" },
            externalRef: { type: "string", description: "Stable cross-system id (e.g. Kanttban jiraId)" },
          },
        },
      },
      {
        name: "time_entry.start",
        title: "Start a timer",
        description:
          "Start a work session right now, attributed to a project (and optionally a task).",
        input_schema: {
          type: "object",
          properties: {
            projectId: { type: "integer" },
            taskId: { type: "integer" },
            notes: { type: "string" },
          },
        },
      },
      {
        name: "time_entry.stop",
        title: "Stop the active timer",
        description: "Set check_out=now on the caller's currently-running session.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "time_entry.log_past",
        title: "Log a completed session retroactively",
        description: "Insert a closed time entry with explicit checkIn / checkOut.",
        input_schema: {
          type: "object",
          required: ["checkIn", "checkOut"],
          properties: {
            checkIn: { type: "string", description: "ISO 8601" },
            checkOut: { type: "string", description: "ISO 8601" },
            projectId: { type: "integer" },
            taskId: { type: "integer" },
            notes: { type: "string" },
          },
        },
      },
      {
        name: "time_entry.list",
        title: "List recent time entries",
        description: "Most recent N time entries for the caller in this workspace.",
        input_schema: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
        },
      },
      {
        name: "task.totals",
        title: "Logged minutes per task",
        description: "Total minutes attributed to each task (closed sessions only).",
        input_schema: {
          type: "object",
          properties: { projectId: { type: "integer" } },
        },
      },
      {
        name: "today_summary",
        title: "Today's summary",
        description: "Total minutes worked today, broken down by project.",
        input_schema: { type: "object", properties: {} },
      },
    ],
  },
  rest_endpoints: [
    { method: "POST", path: "/api/agent/register", description: "Provision an agent service account + initial token." },
    { method: "GET", path: "/api/projects", description: "List projects in the workspace." },
    { method: "POST", path: "/api/projects", description: "Create a project." },
    { method: "GET", path: "/api/tasks", description: "List tasks (optionally ?projectId=)." },
    { method: "POST", path: "/api/tasks", description: "Create a task." },
    { method: "POST", path: "/api/tasks/find-or-create", description: "Idempotent create-by-externalRef." },
    { method: "PUT", path: "/api/tasks/:id", description: "Update a task." },
    { method: "DELETE", path: "/api/tasks/:id", description: "Delete a task." },
    { method: "GET", path: "/api/tasks/totals", description: "Logged minutes per task." },
    { method: "POST", path: "/api/time-entries", description: "Start (open) or log a past entry." },
    { method: "PATCH", path: "/api/time-entries/:id", description: "Update a time entry (e.g. set checkOut)." },
  ],
  hints_for_agents: [
    "Cold start: GET /.well-known/ai-agent.json — no auth needed.",
    "Provision: POST /api/agent/register { name } — returns ttm_… token (shown once).",
    "When an editor opens a Kanttban card, call task.find_or_create with externalRef = the card's jiraId so this MCP and the Kanttban MCP stay aligned.",
    "Every REST and MCP call accepts Authorization: Bearer ttm_…",
  ],
} as const;

/* ───────────────────── Mounting ───────────────────── */

export function registerAgentRoutes(app: Express) {
  // ─── Discovery ───
  const discoveryHandler = (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(MANIFEST);
  };
  app.get("/.well-known/ai-agent.json", discoveryHandler);
  app.get("/api/agent/discovery", discoveryHandler);

  // ─── Self-service signup ───
  app.post("/api/agent/register", async (req: Request, res: Response) => {
    const parsed = registerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid_request",
        message: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const { name, email, workspaceName } = parsed.data;

    const baseEmail = email ?? `agent_${slugify(name)}@agents.ttm.local`;
    const [emailTaken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, baseEmail))
      .limit(1);
    if (emailTaken) {
      return res.status(409).json({
        error: "email_taken",
        message: "Email already registered. Provide a different email or omit it.",
      });
    }

    try {
      // Random unguessable password — agents authenticate by token.
      const sentinel = `agent.${randomBytes(32).toString("hex")}`;
      const hashedPassword = await bcrypt.hash(sentinel, 10);

      const [user] = await db
        .insert(users)
        .values({ email: baseEmail, password: hashedPassword })
        .returning();

      const [workspace] = await db
        .insert(workspaces)
        .values({ name: workspaceName?.trim() || `${name} workspace`, ownerId: user.id })
        .returning();

      await db
        .insert(memberships)
        .values({ workspaceId: workspace.id, userId: user.id, role: "owner" });

      const minted = await mintToken(user.id, workspace.id, `${name} — initial`);

      return res.status(201).json({
        user: { id: user.id, email: user.email },
        workspace: { id: workspace.id, name: workspace.name },
        token: {
          id: minted.id,
          name: minted.name,
          prefix: minted.prefix,
          secret: minted.secret,
        },
        auth_header_example: `Authorization: Bearer ${minted.secret}`,
        mcp_url: MANIFEST.endpoints.mcp.url,
        discovery_url: MANIFEST.endpoints.discovery,
        manifest: MANIFEST,
      });
    } catch (error) {
      console.error("Agent register error:", error);
      return res.status(500).json({ error: "internal_error", message: "Failed to provision agent" });
    }
  });

  // ─── MCP — Streamable HTTP, stateless ───
  app.post("/mcp", async (req: Request, res: Response) => {
    const auth = await verifyApiToken(req.header("Authorization"));
    if (!auth) {
      return res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Missing or invalid Bearer token" },
        id: null,
      });
    }
    const server = buildMcpForUser(auth.user.id, auth.user.email, auth.workspaceId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, req.body);
    } finally {
      transport.close().catch(() => {});
    }
  });
}

/* ───────────────────── MCP server ───────────────────── */

function buildMcpForUser(userId: number, email: string, workspaceId: number): McpServer {
  const mcp = new McpServer(
    {
      name: "timetracker",
      title: "TimeTracker",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
      instructions:
        `Time-tracking ledger for user ${email} in workspace ${workspaceId}. Use task.find_or_create when ` +
        `starting work on a Kanttban card so this ledger stays aligned with that board, then call ` +
        `time_entry.start (and time_entry.stop later) or time_entry.log_past for retroactive entries.`,
    }
  );

  mcp.registerTool(
    "whoami",
    {
      title: "Identify the calling token",
      description: "Returns the user id, email, and workspace id the bearer resolves to.",
    },
    async () => jsonResult({ userId, email, workspaceId })
  );

  mcp.registerTool(
    "project.list",
    {
      title: "List projects",
      description: "Projects in the workspace, ordered by name.",
      inputSchema: { includeArchived: z.boolean().optional() },
    },
    async ({ includeArchived }) => {
      const where = includeArchived
        ? eq(projects.workspaceId, workspaceId)
        : and(eq(projects.workspaceId, workspaceId), eq(projects.archived, false));
      const rows = await db
        .select({
          id: projects.id,
          name: projects.name,
          color: projects.color,
          archived: projects.archived,
          customerId: projects.customerId,
        })
        .from(projects)
        .where(where);
      return jsonResult(rows);
    }
  );

  mcp.registerTool(
    "task.list",
    {
      title: "List tasks",
      description: "Tasks in the workspace, optionally scoped to one project.",
      inputSchema: {
        projectId: z.number().int().optional(),
        includeArchived: z.boolean().optional(),
      },
    },
    async ({ projectId, includeArchived }) => {
      const filters = [eq(tasks.workspaceId, workspaceId)];
      if (projectId) filters.push(eq(tasks.projectId, projectId));
      if (!includeArchived) filters.push(eq(tasks.archived, false));
      const rows = await db
        .select()
        .from(tasks)
        .where(and(...filters));
      return jsonResult(rows);
    }
  );

  mcp.registerTool(
    "task.find_or_create",
    {
      title: "Find or create task by external ref",
      description:
        "Idempotent: returns the existing (projectId, externalRef) task or creates one with `title`. Call this when an agent starts working on a Kanttban card to keep both systems aligned.",
      inputSchema: {
        projectId: z.number().int(),
        title: z.string().min(1).max(255),
        externalRef: z.string().min(1).max(128),
      },
    },
    async ({ projectId, title, externalRef }) => {
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
        .limit(1);
      if (!project) throw new Error("Project not in this workspace");

      const [existing] = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.projectId, projectId),
            eq(tasks.externalRef, externalRef)
          )
        )
        .limit(1);
      if (existing) return jsonResult({ ...existing, created: false });

      const [row] = await db
        .insert(tasks)
        .values({ workspaceId, projectId, title, externalRef })
        .returning();
      return jsonResult({ ...row, created: true });
    }
  );

  mcp.registerTool(
    "time_entry.start",
    {
      title: "Start a timer",
      description: "Open a new time entry now (no checkOut yet).",
      inputSchema: {
        projectId: z.number().int().optional(),
        taskId: z.number().int().optional(),
        notes: z.string().optional(),
      },
    },
    async ({ projectId, taskId, notes }) => {
      let resolvedProject = projectId ?? null;
      if (taskId) {
        const [t] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
          .limit(1);
        if (!t) throw new Error("Task not in this workspace");
        if (resolvedProject && t.projectId !== resolvedProject) {
          throw new Error("Task does not belong to that project");
        }
        if (!resolvedProject) resolvedProject = t.projectId;
      }
      const [entry] = await db
        .insert(timeEntries)
        .values({
          userId,
          workspaceId,
          projectId: resolvedProject,
          taskId: taskId ?? null,
          checkIn: new Date(),
          isBreak: false,
          notes: notes ?? null,
        })
        .returning();
      return jsonResult(entry);
    }
  );

  mcp.registerTool(
    "time_entry.stop",
    {
      title: "Stop the active timer",
      description: "Set check_out=now on the caller's currently-open work session.",
    },
    async () => {
      const open = await db
        .select()
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.userId, userId),
            eq(timeEntries.workspaceId, workspaceId),
            eq(timeEntries.isBreak, false)
          )
        );
      const candidate = open.find((e) => e.checkOut === null);
      if (!candidate) throw new Error("No open work session");
      const [entry] = await db
        .update(timeEntries)
        .set({ checkOut: new Date(), updatedAt: new Date() })
        .where(eq(timeEntries.id, candidate.id))
        .returning();
      return jsonResult(entry);
    }
  );

  mcp.registerTool(
    "time_entry.log_past",
    {
      title: "Log a completed session retroactively",
      description: "Insert a closed time entry with explicit checkIn / checkOut.",
      inputSchema: {
        checkIn: z.string(),
        checkOut: z.string(),
        projectId: z.number().int().optional(),
        taskId: z.number().int().optional(),
        notes: z.string().optional(),
      },
    },
    async ({ checkIn, checkOut, projectId, taskId, notes }) => {
      const ci = new Date(checkIn);
      const co = new Date(checkOut);
      if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) {
        throw new Error("Invalid ISO-8601 timestamp");
      }
      if (co <= ci) throw new Error("checkOut must be after checkIn");
      let resolvedProject = projectId ?? null;
      if (taskId) {
        const [t] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
          .limit(1);
        if (!t) throw new Error("Task not in this workspace");
        if (!resolvedProject) resolvedProject = t.projectId;
      }
      const [entry] = await db
        .insert(timeEntries)
        .values({
          userId,
          workspaceId,
          projectId: resolvedProject,
          taskId: taskId ?? null,
          checkIn: ci,
          checkOut: co,
          isBreak: false,
          notes: notes ?? null,
        })
        .returning();
      return jsonResult(entry);
    }
  );

  mcp.registerTool(
    "time_entry.list",
    {
      title: "List recent time entries",
      description: "Most recent N entries for the caller, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ limit }) => {
      const rows = await db
        .select()
        .from(timeEntries)
        .where(and(eq(timeEntries.userId, userId), eq(timeEntries.workspaceId, workspaceId)))
        .limit(limit ?? 50);
      // Order client-side because the underlying schema doesn't expose a
      // reliable id-DESC default; sufficient for an agent display.
      rows.sort((a, b) => +new Date(b.checkIn) - +new Date(a.checkIn));
      return jsonResult(rows.slice(0, limit ?? 50));
    }
  );

  mcp.registerTool(
    "task.totals",
    {
      title: "Logged minutes per task",
      description: "Returns aggregate duration in minutes per task (closed sessions only).",
      inputSchema: { projectId: z.number().int().optional() },
    },
    async ({ projectId }) => {
      const filters = [
        eq(timeEntries.workspaceId, workspaceId),
        eq(timeEntries.isBreak, false),
      ];
      if (projectId) filters.push(eq(timeEntries.projectId, projectId));
      const all = await db
        .select()
        .from(timeEntries)
        .where(and(...filters));
      const totals = new Map<number | null, { minutes: number; entries: number }>();
      for (const e of all) {
        if (!e.checkOut) continue;
        const min = Math.max(0, (+new Date(e.checkOut) - +new Date(e.checkIn)) / 60_000);
        const cur = totals.get(e.taskId) ?? { minutes: 0, entries: 0 };
        cur.minutes += min;
        cur.entries += 1;
        totals.set(e.taskId, cur);
      }
      return jsonResult(
        Array.from(totals.entries()).map(([taskId, v]) => ({
          taskId,
          minutes: Math.round(v.minutes),
          entries: v.entries,
        }))
      );
    }
  );

  mcp.registerTool(
    "today_summary",
    {
      title: "Today's summary",
      description: "Total minutes worked today, broken down by project.",
    },
    async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const all = await db
        .select()
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workspaceId, workspaceId),
            eq(timeEntries.userId, userId),
            eq(timeEntries.isBreak, false)
          )
        );
      const today = all.filter((e) => +new Date(e.checkIn) >= +startOfDay);
      const byProject = new Map<number | null, number>();
      let totalMin = 0;
      for (const e of today) {
        if (!e.checkOut) continue;
        const min = Math.max(0, (+new Date(e.checkOut) - +new Date(e.checkIn)) / 60_000);
        byProject.set(e.projectId, (byProject.get(e.projectId) ?? 0) + min);
        totalMin += min;
      }
      return jsonResult({
        date: startOfDay.toISOString().slice(0, 10),
        total_minutes: Math.round(totalMin),
        per_project: Array.from(byProject.entries()).map(([projectId, m]) => ({
          projectId,
          minutes: Math.round(m),
        })),
      });
    }
  );

  return mcp;
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
