import { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { entryTemplates } from "../db/schema";
import { auth } from "./auth";
import { resolveWorkspace, WorkspaceRequest } from "./workspaces";
import {
  validate,
  createTemplateSchema,
  updateTemplateSchema,
  idParamSchema,
} from "./validation";

export function registerTemplates(app: Express) {
  app.get("/api/entry-templates", auth, resolveWorkspace, async (req: Request, res: Response) => {
    try {
      const wr = req as WorkspaceRequest;
      const rows = await db
        .select()
        .from(entryTemplates)
        .where(
          and(
            eq(entryTemplates.workspaceId, wr.workspace.id),
            eq(entryTemplates.userId, wr.user[0].id)
          )
        )
        .orderBy(entryTemplates.createdAt);
      res.json(rows);
    } catch (error) {
      console.error("Templates list error:", error);
      res.status(500).json({ error: "Failed to fetch templates" });
    }
  });

  app.post(
    "/api/entry-templates",
    auth,
    resolveWorkspace,
    validate(createTemplateSchema),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const { name, customerId, projectId, notes, icon, isBreak } = req.body;
        const [row] = await db
          .insert(entryTemplates)
          .values({
            userId: wr.user[0].id,
            workspaceId: wr.workspace.id,
            customerId: customerId || null,
            projectId: projectId || null,
            name,
            icon: icon || null,
            notes: notes || null,
            isBreak: isBreak ?? false,
          })
          .returning();
        res.json(row);
      } catch (error) {
        console.error("Template create error:", error);
        res.status(500).json({ error: "Failed to create template" });
      }
    }
  );

  app.patch(
    "/api/entry-templates/:id",
    auth,
    resolveWorkspace,
    validate(idParamSchema, "params"),
    validate(updateTemplateSchema),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const { id } = req.params as unknown as { id: number };
        const existing = await db
          .select()
          .from(entryTemplates)
          .where(
            and(
              eq(entryTemplates.id, id),
              eq(entryTemplates.workspaceId, wr.workspace.id),
              eq(entryTemplates.userId, wr.user[0].id)
            )
          );
        if (existing.length === 0) return res.status(404).json({ error: "Not found" });
        const [row] = await db
          .update(entryTemplates)
          .set(req.body)
          .where(eq(entryTemplates.id, id))
          .returning();
        res.json(row);
      } catch (error) {
        console.error("Template update error:", error);
        res.status(500).json({ error: "Failed to update template" });
      }
    }
  );

  app.delete(
    "/api/entry-templates/:id",
    auth,
    resolveWorkspace,
    validate(idParamSchema, "params"),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const { id } = req.params as unknown as { id: number };
        const deleted = await db
          .delete(entryTemplates)
          .where(
            and(
              eq(entryTemplates.id, id),
              eq(entryTemplates.workspaceId, wr.workspace.id),
              eq(entryTemplates.userId, wr.user[0].id)
            )
          )
          .returning();
        if (deleted.length === 0) return res.status(404).json({ error: "Not found" });
        res.json({ message: "Template deleted" });
      } catch (error) {
        console.error("Template delete error:", error);
        res.status(500).json({ error: "Failed to delete template" });
      }
    }
  );
}
