import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { db } from "../db";
import { memberships, type Role } from "../db/schema";
import { verifyApiToken } from "./tokens";
import { actionsFor, runAction, ActionError, type ActionContext } from "./actions";
import { isRole } from "./types";

/** One MCP server per request (stateless Streamable HTTP), exposing only the actions the caller's role allows. */
export function buildMcpForContext(ctx: ActionContext): McpServer {
  const mcp = new McpServer(
    { name: "ptd", title: "PTD — Plan Track Done", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        `You are ${ctx.displayName} (${ctx.role}) in organization ${ctx.orgId}. ` +
        `Plan with task.*, log work with time_entry.* — when you stop a session, report tokensUsed and apiCostUsd ` +
        `so the organization can see what agent work costs next to human hours. Call next_task to pull the highest-priority open task.`,
    }
  );
  for (const def of actionsFor(ctx.role)) {
    mcp.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.input.shape },
      async (args: unknown) => {
        try {
          const result = await runAction(def.name, args, ctx);
          return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
        } catch (err) {
          const message = err instanceof ActionError ? `${err.code}: ${err.message}` : (err as Error).message;
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      }
    );
  }
  return mcp;
}

export function registerMcp(app: Express) {
  app.post("/mcp", async (req: Request, res: Response) => {
    const auth = await verifyApiToken(req.header("Authorization"));
    if (!auth) {
      return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Missing or invalid Bearer token" }, id: null });
    }
    const [m] = await db.select({ role: memberships.role }).from(memberships)
      .where(and(eq(memberships.userId, auth.user.id), eq(memberships.orgId, auth.orgId))).limit(1);
    if (!m) return res.status(403).json({ jsonrpc: "2.0", error: { code: -32002, message: "Token's organization membership no longer exists" }, id: null });
    const ctx: ActionContext = {
      userId: auth.user.id, email: auth.user.email, displayName: auth.user.displayName,
      orgId: auth.orgId, role: (isRole(m.role) ? m.role : "member") as Role, authType: "agent", via: "mcp",
    };
    const server = buildMcpForContext(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, req.body);
    } finally {
      transport.close().catch(() => {});
    }
  });
}
