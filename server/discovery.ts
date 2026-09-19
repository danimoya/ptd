import type { Express, Request, Response } from "express";
import { z } from "zod";
import { allActions } from "./actions";

function describeShape(shape: z.ZodRawShape) {
  const out: Record<string, string> = {};
  for (const [key, field] of Object.entries(shape)) {
    const f = field as z.ZodTypeAny;
    const optional = f.isOptional();
    const inner = optional ? (f as z.ZodOptional<z.ZodTypeAny>).unwrap() : f;
    const typeName = (inner._def as { typeName?: string }).typeName?.replace(/^Zod/, "").toLowerCase() ?? "unknown";
    out[key] = `${typeName}${optional ? " (optional)" : ""}${f.description ? ` — ${f.description}` : ""}`;
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
    },
    roles: ["member", "manager", "admin", "owner"],
    tools: allActions().map((a) => ({
      name: a.name, title: a.title, description: a.description, surface: a.surface,
      required_role: a.requiredRole, input: describeShape(a.input.shape),
    })),
  };
}

export function registerDiscovery(app: Express) {
  const handler = (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(buildManifest(req));
  };
  app.get("/.well-known/ai-agent.json", handler);
  app.get("/api/agent/discovery", handler);

  app.get("/llms.txt", (req: Request, res: Response) => {
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
