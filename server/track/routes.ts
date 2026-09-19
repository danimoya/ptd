import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { customers, streams, tasks } from "../../db/schema";
import { auth } from "../auth";
import { resolveOrg } from "../orgs";
import { contextFromRequest } from "../actions/context";

/**
 * Bespoke REST routes for the track surface (most reads/writes go through POST /api/actions/<name>).
 *
 * Only one route lives here, and on purpose. The timer's cascading picker needs
 * the org's streams and its open tasks in a single round trip, but reading tasks
 * and streams is the Plan surface's namespace (`task.*`, `stream.*` actions are
 * registered there). Adding a second `task.list` to the registry would collide
 * on import and take the whole server down, so Track reads what it needs to
 * draw the picker through its own endpoint instead of squatting those names.
 */
export function registerTrackRoutes(app: Express) {
  app.get("/api/track/pickers", auth, resolveOrg, async (req: Request, res: Response) => {
    const ctx = contextFromRequest(req);
    const [streamRows, taskRows, customerRows] = await Promise.all([
      db
        .select({ id: streams.id, name: streams.name, color: streams.color, customerId: streams.customerId, archived: streams.archived, agentBudgetUsd: streams.agentBudgetUsd })
        .from(streams)
        .where(and(eq(streams.orgId, ctx.orgId), eq(streams.archived, false)))
        .orderBy(asc(streams.position), asc(streams.id)),
      db
        .select({ id: tasks.id, title: tasks.title, streamId: tasks.streamId, status: tasks.status, assignedTo: tasks.assignedTo, priorityScore: tasks.priorityScore })
        .from(tasks)
        // Open work only: a finished task is not something you start a timer on.
        .where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.completed, false), ne(tasks.status, "wontfix")))
        .orderBy(desc(tasks.priorityScore), desc(tasks.id))
        .limit(500),
      db.select({ id: customers.id, name: customers.name, weeklyGoalHours: customers.weeklyGoalHours }).from(customers).where(eq(customers.orgId, ctx.orgId)).orderBy(customers.name),
    ]);
    res.json({
      streams: streamRows,
      // `mine` lets the picker float the caller's own assignments to the top
      // without the client needing to know its own user id.
      tasks: taskRows.map((t) => ({ ...t, mine: t.assignedTo === ctx.userId })),
      customers: customerRows,
    });
  });
}
