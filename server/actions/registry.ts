import { z } from "zod";
import type { Role } from "../../db/schema";
import { hasRole } from "../types";

/** Which adapter invoked the action — recorded on task_events.via. */
export type Via = "web" | "mcp" | "slack" | "api" | "import";

export interface ActionContext {
  userId: number;
  email: string;
  displayName: string;
  orgId: number;
  role: Role;
  authType: "human" | "agent";
  via: Via;
}

export interface ActionDef<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Minimum role. The check lives here, so no adapter can bypass it. */
  requiredRole: Role;
  /** Surfaces the action belongs to; purely descriptive for docs/manifests. */
  surface: "overview" | "plan" | "track" | "org";
  handler: (args: z.infer<S>, ctx: ActionContext) => Promise<unknown>;
}

export class ActionError extends Error {
  constructor(public code: "forbidden" | "not_found" | "invalid" | "conflict", message: string) {
    super(message);
  }
}

const registry = new Map<string, ActionDef>();

export function defineAction<S extends z.ZodObject<z.ZodRawShape>>(def: ActionDef<S>): ActionDef<S> {
  if (registry.has(def.name)) throw new Error(`Action already registered: ${def.name}`);
  registry.set(def.name, def as unknown as ActionDef);
  return def;
}

export function allActions(): ActionDef[] {
  return Array.from(registry.values());
}

export function actionsFor(role: Role): ActionDef[] {
  return allActions().filter((a) => hasRole(role, a.requiredRole));
}

export function getAction(name: string): ActionDef | undefined {
  return registry.get(name);
}

export async function runAction(name: string, rawArgs: unknown, ctx: ActionContext): Promise<unknown> {
  const def = registry.get(name);
  if (!def) throw new ActionError("not_found", `Unknown action: ${name}`);
  if (!hasRole(ctx.role, def.requiredRole)) {
    throw new ActionError("forbidden", `${name} requires role ${def.requiredRole} or higher (you are ${ctx.role})`);
  }
  const parsed = def.input.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new ActionError("invalid", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  return def.handler(parsed.data, ctx);
}
