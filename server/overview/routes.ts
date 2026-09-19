import type { Express, Request, Response } from "express";
import { auth } from "../auth";
import { requireRole, resolveOrg } from "../orgs";
import { contextFromRequest } from "../actions/context";
import { orgStats } from "./stats";
import { queryTasks, taskQueryInput } from "./query";
import { TASK_STATUSES } from "../../db/schema";

/**
 * Bespoke REST routes for the overview surface (most reads/writes go through
 * POST /api/actions/<name>). These two exist as GETs because the backlog table
 * and the KPI strip are plain reads the browser should be able to cache, bookmark
 * and hit with a querystring — and because a querystring is what a `curl` user reaches for.
 */

/**
 * Parse a numeric query param. An absent or empty value means "no filter", but
 * a value that is present and unparsable is returned as-is so zod rejects it with
 * a 400 — silently dropping `?priorityMin=hgh` would widen the result set and the
 * caller would never learn their filter did nothing.
 */
const num = (v: unknown): number | string | undefined => {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : v;
};

const bool = (v: unknown): boolean | undefined => {
  if (typeof v !== "string") return undefined;
  if (["1", "true", "yes"].includes(v.toLowerCase())) return true;
  if (["0", "false", "no"].includes(v.toLowerCase())) return false;
  return undefined;
};

/** `?status=a&status=b` or `?status=a,b` — both shapes, because both get typed by hand. */
const list = (v: unknown): string[] | undefined => {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : undefined;
  const out = raw?.map((s) => s.trim()).filter(Boolean);
  return out && out.length > 0 ? out : undefined;
};

export function registerOverviewRoutes(app: Express) {
  app.get("/api/org/stats", auth, resolveOrg, requireRole("manager"), async (req: Request, res: Response) => {
    const ctx = contextFromRequest(req);
    try {
      res.json(await orgStats(ctx.orgId));
    } catch (err) {
      console.error("[GET /api/org/stats]", err);
      res.status(500).json({ error: "internal", message: "Could not compute stats" });
    }
  });

  app.get("/api/tasks/query", auth, resolveOrg, async (req: Request, res: Response) => {
    const ctx = contextFromRequest(req);
    const q = req.query;
    const assigneeRaw = typeof q.assignedTo === "string" ? q.assignedTo : undefined;
    /** `?appId=none` means "filed against no app"; anything else must parse as an id. */
    const idOrNone = (v: unknown) => (v === "none" ? ("none" as const) : num(v));
    const statuses = list(q.status) as (typeof TASK_STATUSES)[number][] | undefined;

    const parsed = taskQueryInput.safeParse({
      search: typeof q.search === "string" && q.search.trim() ? q.search.trim() : undefined,
      streamId: idOrNone(q.streamId),
      appId: idOrNone(q.appId),
      status: statuses,
      assignedTo: assigneeRaw === "me" || assigneeRaw === "none" ? assigneeRaw : num(assigneeRaw),
      // An unrecognised status is a typo, not a filter — let zod say so.
      priorityMin: num(q.priorityMin),
      priorityMax: num(q.priorityMax),
      effortMax: num(q.effortMax),
      tags: list(q.tags),
      includeCompleted: bool(q.includeCompleted),
      sort: typeof q.sort === "string" ? q.sort : undefined,
      order: typeof q.order === "string" ? q.order : undefined,
      limit: num(q.limit),
      offset: num(q.offset),
    });
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid", message: parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ") });
    }
    try {
      res.json(await queryTasks(parsed.data, ctx.orgId, ctx.userId));
    } catch (err) {
      console.error("[GET /api/tasks/query]", err);
      res.status(500).json({ error: "internal", message: "Could not query tasks" });
    }
  });
}
