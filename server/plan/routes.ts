import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { taskAttachments } from "../../db/schema";
import { auth } from "../auth";
import { resolveOrg, requireRole } from "../orgs";
import type { OrgRequest } from "../types";
import { contextFromRequest } from "../actions/context";
import { ActionError } from "../actions/registry";
import {
  MAX_UPLOAD_BYTES,
  blobStream,
  dispositionFor,
  fetchAttachment,
  resolveMime,
  safeFilename,
  serializeAttachment,
  statBlob,
  writeBlob,
  type TaskAttachment,
} from "./attachments";
import { startScheduler } from "./scheduler";
import { actorFrom, listEventsForTask, recordEvent } from "./taskEvents";
import { fetchOrgTask } from "./taskOps";

/**
 * Bespoke REST for the Plan surface. Everything the board can express as a verb
 * lives in server/actions/plan.ts (or server/actions/workflow.ts) instead —
 * these are the exceptions, because none of them is JSON:
 *
 *   GET    /api/plan/tasks/:id/history       the same rows as the `task.history` action,
 *                                            shaped for a plain GET so the History panel
 *                                            (and curl) can poll it cheaply.
 *   PUT    /api/plan/tasks/:id/attachments   raw bytes in, one attachment row out.
 *   GET    /api/plan/attachments/:id         the bytes back, org-scoped.
 *
 * Deleting an attachment IS a verb, so it stays an action
 * (`task.attachment_delete`) and there is no DELETE route here.
 *
 * The card editor's app catalogue used to live here too; it now comes from the
 * Overview surface's `app.list` action (member+), which already rolls up each
 * app's streams — one source of truth beats two.
 */

/**
 * Accept any Content-Type: this route is the one place in PTD where the body is
 * opaque bytes. The 25 MB ceiling is enforced here as well as in writeBlob, so
 * an oversized body is refused before it is buffered.
 */
const rawBody = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

/** body-parser's own errors as JSON, in the shape the rest of the API uses. */
function rawBodyError(err: unknown, _req: Request, res: Response, next: NextFunction) {
  const e = err as { type?: string; status?: number; message?: string } | null;
  if (!e) return next();
  if (e.type === "entity.too.large" || e.status === 413) {
    return res.status(413).json({ error: "invalid", message: `File is larger than the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit` });
  }
  return next(err);
}

function fail(res: Response, error: unknown) {
  if (error instanceof ActionError) {
    const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : 400;
    return res.status(status).json({ error: error.code, message: error.message });
  }
  console.error("[plan] route failed:", error);
  return res.status(500).json({ error: "internal", message: "Unexpected error" });
}

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

  /**
   * Upload one file to a card.
   *
   *   PUT /api/plan/tasks/12/attachments?filename=spec.pdf
   *   Content-Type: application/octet-stream
   *   <bytes>
   *
   * `filename` is a *label*: the storage path is derived from the org id and the
   * sha256 of the bytes, so `?filename=../../etc/passwd` is stored as the
   * harmless name `passwd` and cannot influence where anything is written.
   * Re-uploading identical bytes to the same card returns the existing row.
   */
  app.put(
    "/api/plan/tasks/:id/attachments",
    auth,
    resolveOrg,
    requireRole("member"),
    rawBody,
    rawBodyError,
    async (req: Request, res: Response) => {
      const r = req as OrgRequest;
      try {
        const taskId = parseInt(req.params.id, 10);
        if (!Number.isFinite(taskId)) return res.status(400).json({ error: "invalid", message: "Bad task id" });
        const task = await fetchOrgTask(r.org.id, taskId);
        if (!task) return res.status(404).json({ error: "not_found", message: `Task ${taskId} not found in this organization` });

        const body = req.body;
        if (!Buffer.isBuffer(body)) {
          return res.status(400).json({
            error: "invalid",
            message: "Send the file as the raw request body with Content-Type: application/octet-stream",
          });
        }
        if (body.length === 0) return res.status(400).json({ error: "invalid", message: "The request body is empty" });

        const filename = safeFilename(typeof req.query.filename === "string" ? req.query.filename : undefined);
        const mime = resolveMime(req.header("content-type"), filename);
        const blob = await writeBlob(r.org.id, body);

        // Same bytes, same card: one row, so a retried upload is idempotent.
        const [duplicate] = await db
          .select()
          .from(taskAttachments)
          .where(and(eq(taskAttachments.orgId, r.org.id), eq(taskAttachments.taskId, taskId), eq(taskAttachments.sha256, blob.sha256)))
          .limit(1);
        if (duplicate) {
          const row = duplicate as TaskAttachment;
          return res.status(200).json({
            attachment: serializeAttachment(row, { displayName: r.user[0].displayName, isAgent: r.authType === "agent" }),
            deduped: { blob: true, row: true },
          });
        }

        const [inserted] = await db
          .insert(taskAttachments)
          .values({
            taskId,
            orgId: r.org.id,
            userId: r.user[0].id,
            filename,
            mime,
            sizeBytes: blob.sizeBytes,
            storageKey: blob.storageKey,
            sha256: blob.sha256,
          })
          .returning();
        const row = inserted as TaskAttachment;

        const ctx = contextFromRequest(req);
        await recordEvent({
          taskId,
          orgId: r.org.id,
          actor: actorFrom(ctx),
          kind: "updated",
          note: `attachment added · ${filename}`,
          webhookKind: "task.attachment_added",
          payload: { attachmentId: row.id, filename, mime, sizeBytes: row.sizeBytes, sha256: row.sha256 },
        });

        res.status(201).json({
          attachment: serializeAttachment(row, { displayName: r.user[0].displayName, isAgent: r.authType === "agent" }),
          deduped: { blob: blob.deduped, row: false },
        });
      } catch (error) {
        fail(res, error);
      }
    }
  );

  /**
   * Download one attachment. Images, PDFs and text render in place; everything
   * else is forced to download, and nothing is ever served with a type the
   * browser might treat as script (`nosniff` + a no-source CSP + a sandbox,
   * because these bytes come from the app's own origin).
   */
  app.get("/api/plan/attachments/:id", auth, resolveOrg, requireRole("member"), async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid", message: "Bad attachment id" });
      const row = await fetchAttachment(r.org.id, id);
      if (!row) return res.status(404).json({ error: "not_found", message: `Attachment ${id} not found in this organization` });

      const blob = await statBlob(row.storageKey);
      const { contentType, disposition } = dispositionFor(row.mime, row.filename);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(blob.size));
      res.setHeader("Content-Disposition", disposition);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("ETag", `"${row.sha256}"`);
      if (req.header("if-none-match") === `"${row.sha256}"`) return res.status(304).end();

      const stream = blobStream(blob.path);
      stream.on("error", (error) => {
        console.error("[plan] attachment stream failed:", error);
        if (!res.headersSent) res.status(500).json({ error: "internal", message: "Could not read the stored file" });
        else res.destroy();
      });
      stream.pipe(res);
    } catch (error) {
      fail(res, error);
    }
  });

  // The recurrence tick. Skipped when PTD_SCHEDULER=0; guarded against a second
  // instance by the claiming UPDATE in scheduler.ts, not by this call.
  startScheduler();
}
