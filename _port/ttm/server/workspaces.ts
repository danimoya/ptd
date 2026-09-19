import { Express, Request, Response, NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db } from "../db";
import { workspaces, memberships, invitations, users } from "../db/schema";
import { auth } from "./auth";
import { AuthenticatedRequest } from "./types";
import { validate } from "./validation";
import { z } from "zod";

export type WorkspaceRole = "owner" | "admin" | "member";

const ROLE_RANK: Record<WorkspaceRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

export interface WorkspaceRequest extends AuthenticatedRequest {
  workspace: { id: number; role: WorkspaceRole };
}

export async function resolveWorkspace(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const ar = req as AuthenticatedRequest;
  if (!ar.user || !ar.user[0]) return res.status(401).json({ error: "Unauthenticated" });

  const headerId = req.header("X-Workspace-Id");
  const queryId = (req.query.workspaceId as string | undefined) ?? undefined;
  const rawId = headerId || queryId;
  const userId = ar.user[0].id;

  let memberRow;
  if (rawId) {
    const wsId = parseInt(rawId, 10);
    if (!Number.isFinite(wsId)) return res.status(400).json({ error: "Invalid workspace id" });
    [memberRow] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, wsId)));
    if (!memberRow) return res.status(403).json({ error: "Not a member of this workspace" });
  } else {
    [memberRow] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .orderBy(memberships.createdAt);
    if (!memberRow) {
      // No auto-create here: parallel requests would race and spawn duplicate
      // Personal workspaces. Registration sets up the first workspace up-front;
      // invited users accept an invitation. If neither happened, surface a clear
      // error instead of silently bifurcating the user's data.
      return res
        .status(409)
        .json({ error: "No workspace bound to this account yet" });
    }
  }

  (req as WorkspaceRequest).workspace = {
    id: memberRow.workspaceId,
    role: memberRow.role as WorkspaceRole,
  };
  next();
}

export function requireRole(min: WorkspaceRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    const wr = req as WorkspaceRequest;
    if (!wr.workspace) return res.status(403).json({ error: "No workspace context" });
    if (ROLE_RANK[wr.workspace.role] < ROLE_RANK[min]) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

const createWorkspaceSchema = z.object({ name: z.string().min(1).max(255) });
const inviteSchema = z.object({
  email: z.string().email().max(255),
  role: z.enum(["admin", "member"]),
});
const updateRoleSchema = z.object({ role: z.enum(["owner", "admin", "member"]) });
const acceptSchema = z.object({ token: z.string().min(8).max(64) });

export function registerWorkspaceRoutes(app: Express) {
  app.get("/api/workspaces", auth, async (req: Request, res: Response) => {
    try {
      const ar = req as AuthenticatedRequest;
      const rows = await db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          ownerId: workspaces.ownerId,
          role: memberships.role,
          createdAt: workspaces.createdAt,
        })
        .from(memberships)
        .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
        .where(eq(memberships.userId, ar.user[0].id))
        .orderBy(workspaces.createdAt);
      res.json(rows);
    } catch (error) {
      console.error("List workspaces error:", error);
      res.status(500).json({ error: "Failed to list workspaces" });
    }
  });

  app.post(
    "/api/workspaces",
    auth,
    validate(createWorkspaceSchema),
    async (req: Request, res: Response) => {
      try {
        const ar = req as AuthenticatedRequest;
        const [ws] = await db
          .insert(workspaces)
          .values({ name: req.body.name, ownerId: ar.user[0].id })
          .returning();
        await db
          .insert(memberships)
          .values({ workspaceId: ws.id, userId: ar.user[0].id, role: "owner" });
        res.json(ws);
      } catch (error) {
        console.error("Create workspace error:", error);
        res.status(500).json({ error: "Failed to create workspace" });
      }
    }
  );

  app.get(
    "/api/workspaces/:id/members",
    auth,
    resolveWorkspace,
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const rows = await db
          .select({
            userId: memberships.userId,
            role: memberships.role,
            email: users.email,
            createdAt: memberships.createdAt,
          })
          .from(memberships)
          .innerJoin(users, eq(memberships.userId, users.id))
          .where(eq(memberships.workspaceId, wr.workspace.id))
          .orderBy(memberships.createdAt);
        res.json(rows);
      } catch (error) {
        console.error("List members error:", error);
        res.status(500).json({ error: "Failed to list members" });
      }
    }
  );

  app.post(
    "/api/workspaces/:id/invitations",
    auth,
    resolveWorkspace,
    requireRole("admin"),
    validate(inviteSchema),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const token = randomBytes(24).toString("hex");
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const [row] = await db
          .insert(invitations)
          .values({
            workspaceId: wr.workspace.id,
            email: req.body.email,
            role: req.body.role,
            token,
            invitedBy: wr.user[0].id,
            expiresAt,
          })
          .returning();
        res.json(row);
      } catch (error) {
        console.error("Invite error:", error);
        res.status(500).json({ error: "Failed to create invitation" });
      }
    }
  );

  app.get(
    "/api/workspaces/:id/invitations",
    auth,
    resolveWorkspace,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const rows = await db
          .select()
          .from(invitations)
          .where(eq(invitations.workspaceId, wr.workspace.id))
          .orderBy(invitations.createdAt);
        res.json(rows);
      } catch (error) {
        console.error("List invitations error:", error);
        res.status(500).json({ error: "Failed to list invitations" });
      }
    }
  );

  app.post(
    "/api/invitations/accept",
    auth,
    validate(acceptSchema),
    async (req: Request, res: Response) => {
      try {
        const ar = req as AuthenticatedRequest;
        const [invite] = await db
          .select()
          .from(invitations)
          .where(eq(invitations.token, req.body.token));
        if (!invite) return res.status(404).json({ error: "Invitation not found" });
        if (invite.acceptedAt) return res.status(400).json({ error: "Already accepted" });
        if (new Date(invite.expiresAt) < new Date())
          return res.status(400).json({ error: "Invitation expired" });
        if (invite.email.toLowerCase() !== ar.user[0].email.toLowerCase())
          return res.status(403).json({ error: "Invitation email does not match" });

        const existing = await db
          .select()
          .from(memberships)
          .where(
            and(
              eq(memberships.workspaceId, invite.workspaceId),
              eq(memberships.userId, ar.user[0].id)
            )
          );
        if (existing.length === 0) {
          await db.insert(memberships).values({
            workspaceId: invite.workspaceId,
            userId: ar.user[0].id,
            role: invite.role,
          });
        }
        await db
          .update(invitations)
          .set({ acceptedAt: new Date() })
          .where(eq(invitations.id, invite.id));
        res.json({ workspaceId: invite.workspaceId });
      } catch (error) {
        console.error("Accept invitation error:", error);
        res.status(500).json({ error: "Failed to accept invitation" });
      }
    }
  );

  app.patch(
    "/api/workspaces/:id/members/:userId",
    auth,
    resolveWorkspace,
    requireRole("owner"),
    validate(updateRoleSchema),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const targetId = parseInt(req.params.userId, 10);
        if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Bad user id" });
        const [row] = await db
          .update(memberships)
          .set({ role: req.body.role })
          .where(
            and(
              eq(memberships.workspaceId, wr.workspace.id),
              eq(memberships.userId, targetId)
            )
          )
          .returning();
        if (!row) return res.status(404).json({ error: "Member not found" });
        res.json(row);
      } catch (error) {
        console.error("Update role error:", error);
        res.status(500).json({ error: "Failed to update role" });
      }
    }
  );

  app.delete(
    "/api/workspaces/:id/members/:userId",
    auth,
    resolveWorkspace,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      try {
        const wr = req as WorkspaceRequest;
        const targetId = parseInt(req.params.userId, 10);
        if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Bad user id" });
        if (targetId === wr.user[0].id && wr.workspace.role === "owner") {
          return res.status(400).json({ error: "Owners cannot remove themselves" });
        }
        const deleted = await db
          .delete(memberships)
          .where(
            and(
              eq(memberships.workspaceId, wr.workspace.id),
              eq(memberships.userId, targetId)
            )
          )
          .returning();
        if (deleted.length === 0) return res.status(404).json({ error: "Member not found" });
        res.json({ message: "Member removed" });
      } catch (error) {
        console.error("Remove member error:", error);
        res.status(500).json({ error: "Failed to remove member" });
      }
    }
  );
}
