import { Express, Request, Response } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { tasks, projects, timeEntries } from "../db/schema";
import { auth } from "./auth";
import { resolveWorkspace, WorkspaceRequest } from "./workspaces";
import { validate } from "./validation";

/**
 * Tasks per project. The unit of attribution for a time entry; maps 1:1 to
 * "Cards" in Kanttban (with Stream → Project here).
 *
 * Auth: anything that owns the workspace. The same JWT and ttm_… bearer
 * tokens that work elsewhere work here.
 */

const createTaskSchema = z.object({
  projectId: z.number().int(),
  title: z.string().min(1).max(255),
  externalRef: z.string().max(128).optional(),
  archived: z.boolean().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  externalRef: z.string().max(128).nullable().optional(),
  archived: z.boolean().optional(),
});

const findOrCreateSchema = z.object({
  projectId: z.number().int(),
  title: z.string().min(1).max(255),
  externalRef: z.string().min(1).max(128),
});

export function registerTasks(app: Express) {
  // List tasks. Optional ?projectId= to scope, ?archived=true to include.
  app.get(
    "/api/tasks",
    auth,
    resolveWorkspace,
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const projectId = req.query.projectId
          ? parseInt(req.query.projectId as string, 10)
          : undefined;
        const includeArchived = req.query.archived === "true";

        const filters = [eq(tasks.workspaceId, wr.workspace.id)];
        if (projectId) filters.push(eq(tasks.projectId, projectId));
        if (!includeArchived) filters.push(eq(tasks.archived, false));

        const rows = await db
          .select({
            id: tasks.id,
            projectId: tasks.projectId,
            projectName: projects.name,
            title: tasks.title,
            externalRef: tasks.externalRef,
            archived: tasks.archived,
            createdAt: tasks.createdAt,
          })
          .from(tasks)
          .leftJoin(projects, eq(tasks.projectId, projects.id))
          .where(and(...filters))
          .orderBy(tasks.title);
        res.json(rows);
      } catch (error) {
        console.error("Tasks list error:", error);
        res.status(500).json({ error: "Failed to list tasks" });
      }
    }
  );

  app.post(
    "/api/tasks",
    auth,
    resolveWorkspace,
    validate(createTaskSchema),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const { projectId, title, externalRef, archived } = req.body;

        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.workspaceId, wr.workspace.id)))
          .limit(1);
        if (!project) {
          return res.status(400).json({ error: "Project is not in this workspace" });
        }

        const [row] = await db
          .insert(tasks)
          .values({
            workspaceId: wr.workspace.id,
            projectId,
            title,
            externalRef: externalRef ?? null,
            archived: archived ?? false,
          })
          .returning();
        res.json(row);
      } catch (error) {
        console.error("Task create error:", error);
        res.status(500).json({ error: "Failed to create task" });
      }
    }
  );

  // Idempotent helper used by integrations: look up by (projectId,
  // externalRef) and return that task; create one if it doesn't exist.
  // Intended for tools that mirror an upstream system (e.g. Kanttban cards)
  // and don't want to track TimeTracker's surrogate id.
  app.post(
    "/api/tasks/find-or-create",
    auth,
    resolveWorkspace,
    validate(findOrCreateSchema),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const { projectId, title, externalRef } = req.body;

        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.workspaceId, wr.workspace.id)))
          .limit(1);
        if (!project) {
          return res.status(400).json({ error: "Project is not in this workspace" });
        }

        const [existing] = await db
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.workspaceId, wr.workspace.id),
              eq(tasks.projectId, projectId),
              eq(tasks.externalRef, externalRef)
            )
          )
          .limit(1);
        if (existing) {
          return res.json({ ...existing, created: false });
        }

        const [row] = await db
          .insert(tasks)
          .values({
            workspaceId: wr.workspace.id,
            projectId,
            title,
            externalRef,
            archived: false,
          })
          .returning();
        res.json({ ...row, created: true });
      } catch (error) {
        console.error("Task find-or-create error:", error);
        res.status(500).json({ error: "Failed to find or create task" });
      }
    }
  );

  app.put(
    "/api/tasks/:id",
    auth,
    resolveWorkspace,
    validate(updateTaskSchema),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

        const [existing] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, id), eq(tasks.workspaceId, wr.workspace.id)))
          .limit(1);
        if (!existing) return res.status(404).json({ error: "Task not found" });

        const update: Record<string, unknown> = {};
        if ("title" in req.body) update.title = req.body.title;
        if ("externalRef" in req.body) update.externalRef = req.body.externalRef ?? null;
        if ("archived" in req.body) update.archived = req.body.archived;

        const [row] = await db
          .update(tasks)
          .set(update)
          .where(eq(tasks.id, id))
          .returning();
        res.json(row);
      } catch (error) {
        console.error("Task update error:", error);
        res.status(500).json({ error: "Failed to update task" });
      }
    }
  );

  app.delete(
    "/api/tasks/:id",
    auth,
    resolveWorkspace,
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

        const [existing] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, id), eq(tasks.workspaceId, wr.workspace.id)))
          .limit(1);
        if (!existing) return res.status(404).json({ error: "Task not found" });

        await db.delete(tasks).where(eq(tasks.id, id));
        res.status(204).send();
      } catch (error) {
        console.error("Task delete error:", error);
        res.status(500).json({ error: "Failed to delete task" });
      }
    }
  );

  // Aggregate logged minutes per task in this workspace, optionally
  // scoped to a date range. Used by the dashboard and by an MCP tool so
  // an agent can answer "how long has card X taken so far?".
  app.get(
    "/api/tasks/totals",
    auth,
    resolveWorkspace,
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const projectId = req.query.projectId
          ? parseInt(req.query.projectId as string, 10)
          : undefined;

        const filters = [
          eq(timeEntries.workspaceId, wr.workspace.id),
          eq(timeEntries.isBreak, false),
        ];
        if (projectId) filters.push(eq(timeEntries.projectId, projectId));

        const rows = await db
          .select({
            taskId: timeEntries.taskId,
            // SUM of minutes between check_in and check_out, ignoring open
            // sessions (NULL check_out). The Drizzle `sql` template keeps
            // the dialect-specific datediff out of TS.
            minutes: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (${timeEntries.checkOut} - ${timeEntries.checkIn})) / 60), 0)::int`,
            entries: sql<number>`COUNT(*)::int`,
          })
          .from(timeEntries)
          .where(and(...filters))
          .groupBy(timeEntries.taskId);

        res.json(rows);
      } catch (error) {
        console.error("Task totals error:", error);
        res.status(500).json({ error: "Failed to compute task totals" });
      }
    }
  );
}
