import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { allActions } from "./actions";

/**
 * The public documents an agent or a browser-based MCP client reads before it has a
 * token: the manifest, `llms.txt`, and (from server/oauth/routes.ts) the two OAuth
 * metadata documents. All of them are fetched cross-origin from a page, so they all
 * answer the preflight and expose `WWW-Authenticate` — the header a connector needs
 * to read off the 401 that sends it to the authorization server.
 */
export function corsHeaders(res: Response, methods = "GET, OPTIONS"): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, X-Request-Id");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, X-Request-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/** CORS for a family of public documents; answers OPTIONS itself, passes GET through. */
export function publicDocumentCors(methods = "GET, OPTIONS"): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    corsHeaders(res, methods);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

function describeShape(shape: z.ZodRawShape) {
  const out: Record<string, string> = {};
  for (const [key, field] of Object.entries(shape)) {
    const f = field as z.ZodTypeAny;
    let inner: z.ZodTypeAny = f;
    let optional = false;
    let nullable = false;
    // Peel optional/nullable/default wrappers in any order; .describe() text survives on the outer type.
    for (let i = 0; i < 8; i++) {
      const def = inner._def as { typeName?: string; innerType?: z.ZodTypeAny };
      if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") { optional = true; inner = def.innerType!; continue; }
      if (def.typeName === "ZodNullable") { nullable = true; inner = def.innerType!; continue; }
      break;
    }
    const def = inner._def as { typeName?: string; values?: string[] };
    let typeName = def.typeName?.replace(/^Zod/, "").toLowerCase() ?? "unknown";
    if (def.typeName === "ZodEnum" && def.values) typeName = def.values.join(" | ");
    const flags = [optional ? "optional" : "", nullable ? "nullable" : ""].filter(Boolean).join(", ");
    out[key] = `${typeName}${flags ? ` (${flags})` : ""}${f.description ? ` — ${f.description}` : ""}`;
  }
  return out;
}

export function baseUrl(req: Request): string {
  const proto = (req.header("x-forwarded-proto") || req.protocol || "http").split(",")[0];
  return `${proto}://${req.header("x-forwarded-host") || req.header("host")}`;
}

export function buildManifest(req: Request) {
  const base = baseUrl(req);
  return {
    service: "ptd",
    title: "PTD — Plan Track Done",
    version: "0.1.0",
    description:
      "Work tracker for hybrid human + AI-agent teams: plan tasks on a Gantt-backed board, log time against them, " +
      "and see human vs agent minutes, tokens and cost per task. Agents are members with a role; the same role gate applies to every tool.",
    auth: {
      scheme: "Bearer",
      token_format: "ptd_<8-hex-prefix><32-hex-secret>",
      header_example: "Authorization: Bearer ptd_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      signup: {
        method: "POST",
        url: `${base}/api/agent/register`,
        body_fields: {
          name: "string (required)",
          email: "string (optional, derived if omitted)",
          orgName: "string (optional) — create a new organization owned by the agent; mutually exclusive with inviteCode",
          inviteCode: "string (optional) — join an existing organization as member (Org → Agents shows the code)",
        },
      },
      mint_additional: { method: "POST", url: `${base}/api/tokens` },
      rotate: { method: "POST", url: `${base}/api/tokens/rotate` },
      revoke: { method: "DELETE", url: `${base}/api/tokens/{id}` },
    },
    endpoints: {
      mcp: { url: `${base}/mcp`, transport: "streamable-http", method: "POST", auth: "bearer", protocol: "https://modelcontextprotocol.io" },
      rest_base: `${base}/api`,
      discovery: `${base}/.well-known/ai-agent.json`,
      llms_txt: `${base}/llms.txt`,
      openapi: `${base}/openapi.json`,
    },
    roles: ["member", "manager", "admin", "owner"],
    tools: allActions().map((a) => ({
      name: a.name, title: a.title, description: a.description, surface: a.surface,
      required_role: a.requiredRole, input: describeShape(a.input.shape),
    })),
  };
}

export function registerDiscovery(app: Express) {
  // Everything under /.well-known is a public document: one CORS layer covers this
  // module's manifest and the OAuth metadata that server/oauth/routes.ts adds later.
  app.use("/.well-known", publicDocumentCors());

  const handler = (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(buildManifest(req));
  };
  app.get("/.well-known/ai-agent.json", handler);
  app.options("/api/agent/discovery", publicDocumentCors());
  app.get("/api/agent/discovery", publicDocumentCors(), handler);

  app.options("/llms.txt", publicDocumentCors());
  app.get("/llms.txt", publicDocumentCors(), (req: Request, res: Response) => {
    const m = buildManifest(req);
    const lines = [
      `# ${m.title}`, "", m.description, "",
      `- MCP endpoint: ${m.endpoints.mcp.url} (Streamable HTTP, Bearer ptd_ token)`,
      `- Agent signup: POST ${m.auth.signup.url} {"name": "...", "inviteCode": "..."}`,
      `- Discovery: ${m.endpoints.discovery}`, "",
      "## Tools by role", "",
      ...m.tools.map((t) => `- \`${t.name}\` (${t.required_role}+, ${t.surface}): ${t.description}`),
    ];
    res.type("text/plain").send(lines.join("\n"));
  });
}
