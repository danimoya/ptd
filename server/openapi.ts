import type { Express, Request, Response } from "express";
import { z } from "zod";
import { allActions } from "./actions";
import { baseUrl } from "./discovery";

/** Minimal zod → JSON Schema for the shapes actions use (objects, primitives, arrays, enums, optional/nullable). */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName: string; [k: string]: unknown };
  const withDesc = (o: Record<string, unknown>) => (schema.description ? { ...o, description: schema.description } : o);
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodDefault":
      return withDesc(zodToJsonSchema(def.innerType as z.ZodTypeAny));
    case "ZodNullable": {
      const inner = zodToJsonSchema(def.innerType as z.ZodTypeAny);
      return withDesc({ anyOf: [inner, { type: "null" }] });
    }
    case "ZodString":
      return withDesc({ type: "string" });
    case "ZodNumber": {
      const checks = (def.checks as { kind: string; value?: number }[]) ?? [];
      const out: Record<string, unknown> = { type: checks.some((c) => c.kind === "int") ? "integer" : "number" };
      for (const c of checks) { if (c.kind === "min") out.minimum = c.value; if (c.kind === "max") out.maximum = c.value; }
      return withDesc(out);
    }
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodEnum":
      return withDesc({ type: "string", enum: def.values as string[] });
    case "ZodLiteral":
      return withDesc({ const: def.value });
    case "ZodArray":
      return withDesc({ type: "array", items: zodToJsonSchema(def.type as z.ZodTypeAny) });
    case "ZodUnion":
      return withDesc({ anyOf: (def.options as z.ZodTypeAny[]).map(zodToJsonSchema) });
    case "ZodObject": {
      const shape = (def.shape as () => z.ZodRawShape)();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v as z.ZodTypeAny);
        if (!(v as z.ZodTypeAny).isOptional()) required.push(k);
      }
      return withDesc({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
    }
    case "ZodRecord":
      return withDesc({ type: "object", additionalProperties: zodToJsonSchema(def.valueType as z.ZodTypeAny) });
    default:
      return withDesc({});
  }
}

export function buildOpenApi(req: Request) {
  const base = baseUrl(req);
  const paths: Record<string, unknown> = {};
  for (const a of allActions()) {
    paths[`/api/actions/${a.name}`] = {
      post: {
        operationId: a.name.replace(/[^a-zA-Z0-9]+/g, "_"),
        summary: a.title,
        description: `${a.description} Requires role ${a.requiredRole} or higher. Surface: ${a.surface}.`,
        tags: [a.surface],
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { "application/json": { schema: zodToJsonSchema(a.input) } } },
        responses: {
          "200": { description: "Action result (JSON)", content: { "application/json": { schema: {} } } },
          "400": { description: "Invalid arguments" }, "401": { description: "Missing or invalid credentials" },
          "403": { description: "Role does not allow this action" }, "404": { description: "Not found" }, "409": { description: "Conflict" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "PTD — Plan Track Done", version: "0.1.0",
      description: "Every operation is a registry action: POST /api/actions/<name> with a JSON body. The same actions are exposed over MCP at /mcp. Authenticate with `Authorization: Bearer ptd_…` (agent token) or a user JWT; pass `X-Org-Id` to pick an organization when you belong to several.",
    },
    servers: [{ url: base }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths,
  };
}

export function registerOpenApi(app: Express) {
  app.get("/openapi.json", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(buildOpenApi(req));
  });
}
