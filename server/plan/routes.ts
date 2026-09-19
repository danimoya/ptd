import type { Express, Request, Response } from "express";
import { auth } from "../auth";
import { resolveOrg, requireRole } from "../orgs";
import type { OrgRequest } from "../types";
import { listEventsForTask } from "./taskEvents";
import { fetchOrgTask } from "./taskOps";

/**
 * Bespoke REST for the Plan surface. Everything the board can express as a verb
 * lives in server/actions/plan.ts instead — this is the one exception:
 *
 *   GET /api/plan/tasks/:id/history   the same rows as the `task.history` action,
 *                                     shaped for a plain GET so the History panel
 *                                     (and curl) can poll it cheaply.
 *
 * The card editor's app catalogue used to live here too; it now comes from the
 * Overview surface's `app.list` action (member+), which already rolls up each
 * app's streams — one source of truth beats two.
 */
export function registerPlanRoutes(app: Express) {
  app.get("/api/plan/tasks/:id/history", auth, resolveOrg, requireRole("member"), async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const taskId = parseInt(req.params.id, 10);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: "invalid", message: "Bad task id" });
    const task = await fetchOrgTask(r.org.id, taskId);
    if (!task) return res.status(404).json({ error: "not_found", message: `Task ${taskId} not found in this organization` });
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
    res.json({ taskId, events: await listEventsForTask(taskId, r.org.id, limit) });
  });
}
