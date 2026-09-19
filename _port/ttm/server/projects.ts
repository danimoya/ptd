import { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { projects, customers, timeEntries } from "../db/schema";
import { auth } from "./auth";
import { resolveWorkspace, WorkspaceRequest } from "./workspaces";
import {
  validate,
  createProjectSchema,
  updateProjectSchema,
  idParamSchema,
} from "./validation";

export function registerProjects(app: Express) {
  // List projects in this workspace, optionally filtered by ?customerId=
  app.get("/api/projects", auth, resolveWorkspace, async (req: Request, res: Response) => {
    try {
      const wr = req as WorkspaceRequest;
      const customerId = req.query.customerId
        ? parseInt(req.query.customerId as string, 10)
        : undefined;
      const where = customerId
        ? and(eq(projects.workspaceId, wr.workspace.id), eq(projects.customerId, customerId))
        : eq(projects.workspaceId, wr.workspace.id);
      const rows = await db
        .select({
          id: projects.id,
          name: projects.name,
          color: projects.color,
          archived: projects.archived,
          customerId: projects.customerId,
          customerName: customers.name,
          createdAt: projects.createdAt,
        })
        .from(projects)
        .leftJoin(customers, eq(projects.customerId, customers.id))
        .where(where)
        .orderBy(projects.name);
      res.json(rows);
    } catch (error) {
      console.error("Projects list error:", error);
      res.status(500).json({ error: "Failed to fetch projects" });
    }
  });

  app.post(
    "/api/projects",
    auth,
    resolveWorkspace,
    validate(createProjectSchema),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const { name, customerId, color, archived } = req.body;

        if (customerId) {
          const owned = await db
            .select({ id: customers.id })
            .from(customers)
            .where(and(eq(customers.id, customerId), eq(customers.workspaceId, wr.workspace.id)));
          if (owned.length === 0) {
            return res.status(400).json({ error: "Customer is not in this workspace" });
          }
        }

        const [row] = await db
          .insert(projects)
          .values({
            workspaceId: wr.workspace.id,
            userId: wr.user[0].id,
            customerId: customerId ?? null,
            name,
            color: color || null,
            archived: archived ?? false,
          })
          .returning();
        res.json(row);
      } catch (error) {
        console.error("Project create error:", error);
        res.status(500).json({ error: "Failed to create project" });
      }
    }
  );

  app.patch(
    "/api/projects/:id",
    auth,
    resolveWorkspace,
    validate(idParamSchema, "params"),
    validate(updateProjectSchema),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const { id } = req.params as unknown as { id: number };
        const existing = await db
          .select()
          .from(projects)
          .where(and(eq(projects.id, id), eq(projects.workspaceId, wr.workspace.id)));
        if (existing.length === 0) return res.status(404).json({ error: "Project not found" });

        if (req.body.customerId) {
          const owned = await db
            .select({ id: customers.id })
            .from(customers)
            .where(and(eq(customers.id, req.body.customerId), eq(customers.workspaceId, wr.workspace.id)));
          if (owned.length === 0) {
            return res.status(400).json({ error: "Customer is not in this workspace" });
          }
        }

        const patch: Record<string, unknown> = {};
        if (req.body.name !== undefined) patch.name = req.body.name;
        if (req.body.customerId !== undefined) patch.customerId = req.body.customerId;
        if (req.body.color !== undefined) patch.color = req.body.color || null;
        if (req.body.archived !== undefined) patch.archived = req.body.archived;

        const [row] = await db
          .update(projects)
          .set(patch)
          .where(eq(projects.id, id))
          .returning();
        res.json(row);
      } catch (error) {
        console.error("Project update error:", error);
        res.status(500).json({ error: "Failed to update project" });
      }
    }
  );

  app.delete(
    "/api/projects/:id",
    auth,
    resolveWorkspace,
    validate(idParamSchema, "params"),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const { id } = req.params as unknown as { id: number };
        // Null out time_entries.project_id for this project first (keeps entries)
        await db
          .update(timeEntries)
          .set({ projectId: null, updatedAt: new Date() })
          .where(and(eq(timeEntries.projectId, id), eq(timeEntries.workspaceId, wr.workspace.id)));
        const deleted = await db
          .delete(projects)
          .where(and(eq(projects.id, id), eq(projects.workspaceId, wr.workspace.id)))
          .returning();
        if (deleted.length === 0) return res.status(404).json({ error: "Project not found" });
        res.json({ message: "Project deleted" });
      } catch (error) {
        console.error("Project delete error:", error);
        res.status(500).json({ error: "Failed to delete project" });
      }
    }
  );
}
