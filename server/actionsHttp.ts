import type { Express, Request, Response } from "express";
import { auth } from "./auth";
import { resolveOrg } from "./orgs";
import { actionsFor, runAction, ActionError } from "./actions";
import { contextFromRequest } from "./actions/context";

const STATUS: Record<ActionError["code"], number> = { forbidden: 403, not_found: 404, invalid: 400, conflict: 409 };

/**
 * REST face of the action registry: POST /api/actions/<name> with a JSON body of
 * arguments. Same role gate and same handlers as MCP, so the web client and any
 * HTTP integration get parity for free. GET /api/actions lists what the caller may run.
 */
export function registerActionsHttp(app: Express) {
  app.get("/api/actions", auth, resolveOrg, (req: Request, res: Response) => {
    const ctx = contextFromRequest(req);
    res.json(actionsFor(ctx.role).map((a) => ({ name: a.name, title: a.title, description: a.description, surface: a.surface, requiredRole: a.requiredRole })));
  });

  app.post("/api/actions/:name", auth, resolveOrg, async (req: Request, res: Response) => {
    const ctx = contextFromRequest(req);
    try {
      res.json(await runAction(req.params.name, req.body ?? {}, ctx));
    } catch (err) {
      if (err instanceof ActionError) return res.status(STATUS[err.code]).json({ error: err.code, message: err.message });
      console.error(`[action ${req.params.name}]`, err);
      res.status(500).json({ error: "internal", message: "Action failed" });
    }
  });
}
