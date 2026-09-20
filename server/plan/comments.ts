import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { taskComments, users } from "../../db/schema";
import { ActionError, type ActionContext } from "../actions/registry";
import { hasRole } from "../types";
import { actorFrom, recordEvent } from "./taskEvents";
import { requireTask } from "./taskOps";

/** db/schema.ts is frozen and exports no row type for this table, so it is inferred here. */
export type TaskComment = typeof taskComments.$inferSelect;

/**
 * Discussion on a card.
 *
 * Bodies are stored exactly as they were typed — markdown-lite source, not HTML.
 * Rendering (and sanitising) happens where it is displayed
 * (client/src/features/plan/markdown.ts), because a comment can be written by an
 * agent over MCP or by a chat bot, so the stored text is untrusted by
 * construction and there is no safe moment to bake HTML into the column.
 *
 * Roles: any member may comment on any card in their org — a comment is the
 * cheapest way for a member who cannot edit a card to say something about it.
 * A comment may be deleted by its author, or by a manager and above.
 */

export const MAX_COMMENT_LENGTH = 10_000;

export interface CommentRow {
  id: number;
  taskId: number;
  body: string;
  via: string;
  author: { userId: number | null; displayName: string | null; isAgent: boolean };
  createdAt: string | null;
  updatedAt: string | null;
}

function serialize(row: TaskComment, author: { displayName: string | null; isAgent: boolean } | null): CommentRow {
  return {
    id: row.id,
    taskId: row.taskId,
    body: row.body,
    via: row.via,
    author: { userId: row.authorUserId, displayName: author?.displayName ?? null, isAgent: author?.isAgent ?? false },
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

/** Chronological — a discussion reads top to bottom, unlike the history panel. */
export async function listComments(orgId: number, taskId: number): Promise<CommentRow[]> {
  const rows = await db
    .select({ c: taskComments, displayName: users.displayName, isAgent: users.isAgent })
    .from(taskComments)
    .leftJoin(users, eq(taskComments.authorUserId, users.id))
    .where(and(eq(taskComments.orgId, orgId), eq(taskComments.taskId, taskId)))
    .orderBy(asc(taskComments.createdAt), asc(taskComments.id));
  return rows.map((r) =>
    serialize(r.c as TaskComment, r.displayName === null && r.isAgent === null ? null : { displayName: r.displayName, isAgent: !!r.isAgent })
  );
}

export async function addComment(ctx: ActionContext, taskId: number, rawBody: string): Promise<CommentRow> {
  const task = await requireTask(ctx.orgId, taskId);
  const body = rawBody.trim();
  if (!body) throw new ActionError("invalid", "A comment needs a body");
  if (body.length > MAX_COMMENT_LENGTH) throw new ActionError("invalid", `A comment is at most ${MAX_COMMENT_LENGTH} characters`);

  const [row] = await db
    .insert(taskComments)
    .values({ taskId, orgId: ctx.orgId, authorUserId: ctx.userId, body, via: ctx.via })
    .returning();
  const comment = row as TaskComment;

  // One history row (kind `updated`, note "commented") and one webhook, but the
  // webhook is `task.commented` so a consumer can route it without parsing the
  // note. recordEvent's `webhookKind` exists for exactly this.
  await recordEvent({
    taskId,
    orgId: ctx.orgId,
    actor: actorFrom(ctx),
    kind: "updated",
    note: "commented",
    webhookKind: "task.commented",
    payload: { commentId: comment.id, body: comment.body, taskTitle: task.title },
  });

  const author = { displayName: ctx.displayName, isAgent: ctx.authType === "agent" };
  return serialize(comment, author);
}

export async function deleteComment(ctx: ActionContext, commentId: number): Promise<{ deleted: number; taskId: number }> {
  const [row] = await db
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.id, commentId), eq(taskComments.orgId, ctx.orgId)))
    .limit(1);
  const comment = row as TaskComment | undefined;
  if (!comment) throw new ActionError("not_found", `Comment ${commentId} not found in this organization`);
  if (comment.authorUserId !== ctx.userId && !hasRole(ctx.role, "manager")) {
    throw new ActionError("forbidden", "You may only delete your own comments — ask a manager to remove someone else's");
  }

  await db.delete(taskComments).where(and(eq(taskComments.id, commentId), eq(taskComments.orgId, ctx.orgId)));
  await recordEvent({
    taskId: comment.taskId,
    orgId: ctx.orgId,
    actor: actorFrom(ctx),
    kind: "updated",
    note: "comment deleted",
    webhookKind: "task.comment_deleted",
    payload: { commentId },
  });
  return { deleted: commentId, taskId: comment.taskId };
}
