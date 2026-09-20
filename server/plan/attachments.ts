import crypto from "crypto";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { taskAttachments, users } from "../../db/schema";
import { ActionError } from "../actions/registry";

/** db/schema.ts is frozen and exports no row type for this table, so it is inferred here. */
export type TaskAttachment = typeof taskAttachments.$inferSelect;

/**
 * Content-addressed file storage for task attachments.
 *
 * Layout under `PTD_FILES_DIR` (`./data/files` in dev, the `ptd_files` volume
 * at `/data/files` under compose):
 *
 *   <root>/<orgId>/<sha[0:2]>/<sha[2:4]>/<sha>
 *
 * Three rules the rest of the code depends on:
 *
 *  1. **The path never contains anything the caller sent.** It is built from the
 *     org id and the sha256 of the bytes, so `?filename=../../etc/passwd` is a
 *     display label and nothing more.
 *  2. **The bytes are hashed while they are written**, so the digest belongs to
 *     what actually landed on disk rather than to a buffer that was inspected
 *     separately.
 *  3. **Identical bytes are stored once per org.** A second upload of the same
 *     file inserts a row (a card may want its own name for it) and reuses the
 *     blob, and a delete only unlinks the blob when the last row goes.
 */

const DEFAULT_DIR = "./data/files";
const KEY_SHAPE = /^[0-9]+\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

/** 25 MB, matching the `express.raw` limit on the upload route. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function filesRoot(): string {
  return path.resolve(process.env.PTD_FILES_DIR || DEFAULT_DIR);
}

/**
 * A filename safe to store as a label and to echo in a Content-Disposition
 * header: basename only, no separators, no control characters, no leading dot.
 */
export function safeFilename(raw: string | undefined | null): string {
  const base = path.basename(String(raw ?? "").replace(/\\/g, "/"));
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .replace(/[/\\:*?<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return cleaned || "upload.bin";
}

/** MIME types the browser may render in place. Everything else downloads. */
const INLINE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
]);

/**
 * `image/svg+xml` is deliberately absent: an SVG is a script host, and these
 * files are served from the app's own origin.
 */
export function isInlineMime(mime: string): boolean {
  return INLINE_MIME.has(mime);
}

/** Normalise a Content-Type header into something storable, or octet-stream. */
export function sanitizeMime(raw: string | undefined | null): string {
  const value = String(raw ?? "").split(";")[0].trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/.test(value)) return "application/octet-stream";
  return value.slice(0, 120);
}

/** What a download should send: the real type inline, or a forced attachment. */
export function dispositionFor(mime: string, filename: string): { contentType: string; disposition: string } {
  const inline = isInlineMime(mime);
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  const encoded = encodeURIComponent(filename);
  return {
    contentType: inline ? mime : "application/octet-stream",
    disposition: `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
  };
}

/**
 * Extension → MIME, used only when the request's own Content-Type is the
 * generic octet-stream (curl's default with `--data-binary`, and what a browser
 * sends for a file it does not recognise). It can only ever *narrow* to a type
 * on the inline allow-list, so it cannot be used to talk the server into
 * serving something dangerous inline.
 */
const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};

export function mimeFromFilename(filename: string): string | null {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  return EXTENSION_MIME[ext] ?? null;
}

/** The type to store: the header when it says something, else a guess from the name. */
export function resolveMime(headerValue: string | undefined | null, filename: string): string {
  const fromHeader = sanitizeMime(headerValue);
  if (fromHeader !== "application/octet-stream") return fromHeader;
  return mimeFromFilename(filename) ?? "application/octet-stream";
}

export function storageKeyFor(orgId: number, sha256: string): string {
  return `${orgId}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/**
 * Absolute path for a storage key, refusing anything that is not the shape this
 * module writes. Belt and braces on top of rule 1 above: even a storage_key
 * corrupted in the database cannot address a file outside the root.
 */
export function resolveStoragePath(storageKey: string): string {
  if (!KEY_SHAPE.test(storageKey)) throw new ActionError("invalid", "Malformed attachment storage key");
  const root = filesRoot();
  const full = path.resolve(root, storageKey);
  if (full !== path.join(root, ...storageKey.split("/"))) throw new ActionError("invalid", "Malformed attachment storage key");
  if (!full.startsWith(root + path.sep)) throw new ActionError("invalid", "Attachment path escapes the storage root");
  return full;
}

/**
 * The file a storage key points at, verified to be a plain file inside the
 * root. `lstat` rather than `stat` so a symlink planted in the store is refused
 * instead of followed, and `realpath` on the directory so a symlinked parent
 * cannot redirect the read either.
 */
export async function statBlob(storageKey: string): Promise<{ path: string; size: number }> {
  const full = resolveStoragePath(storageKey);
  const info = await fs.lstat(full).catch(() => null);
  if (!info || !info.isFile()) throw new ActionError("not_found", "The stored file is missing");
  const realDir = await fs.realpath(path.dirname(full));
  const realRoot = await fs.realpath(filesRoot());
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new ActionError("invalid", "Attachment path escapes the storage root");
  }
  return { path: full, size: info.size };
}

export function blobStream(fullPath: string) {
  return createReadStream(fullPath);
}

export interface StoredBlob {
  sha256: string;
  storageKey: string;
  sizeBytes: number;
  /** True when these exact bytes were already in this org's store. */
  deduped: boolean;
}

/**
 * Write bytes to the store, hashing as they go.
 *
 * The digest is only known once the last chunk is written, so the bytes land in
 * a temporary file and are renamed into their content-addressed home
 * afterwards. `O_EXCL` on both opens means the write can never follow a
 * pre-existing symlink, and an `EEXIST` on the rename target is the dedupe
 * path rather than an error.
 */
export async function writeBlob(orgId: number, body: Buffer): Promise<StoredBlob> {
  if (body.length === 0) throw new ActionError("invalid", "The request body is empty — send the file as the raw request body");
  if (body.length > MAX_UPLOAD_BYTES) throw new ActionError("invalid", `File is larger than the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit`);

  const root = filesRoot();
  const tmpDir = path.join(root, "tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `up-${crypto.randomBytes(12).toString("hex")}`);

  const hash = crypto.createHash("sha256");
  const handle = await fs.open(tmpPath, "wx", 0o600);
  try {
    const CHUNK = 64 * 1024;
    for (let offset = 0; offset < body.length; offset += CHUNK) {
      const chunk = body.subarray(offset, Math.min(offset + CHUNK, body.length));
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }

  const sha256 = hash.digest("hex");
  const storageKey = storageKeyFor(orgId, sha256);
  const full = resolveStoragePath(storageKey);
  await fs.mkdir(path.dirname(full), { recursive: true });

  let deduped = false;
  const existing = await fs.lstat(full).catch(() => null);
  if (existing && existing.isFile() && existing.size === body.length) {
    deduped = true;
    await fs.unlink(tmpPath).catch(() => {});
  } else {
    if (existing) await fs.unlink(full).catch(() => {}); // a truncated or symlinked leftover
    await fs.rename(tmpPath, full);
    await fs.chmod(full, 0o600).catch(() => {});
  }
  return { sha256, storageKey, sizeBytes: body.length, deduped };
}

/** Unlink the blob once no row in the org still points at it. */
export async function dropBlobIfUnreferenced(orgId: number, sha256: string, storageKey: string): Promise<boolean> {
  const rows = await db
    .select({ id: taskAttachments.id })
    .from(taskAttachments)
    .where(and(eq(taskAttachments.orgId, orgId), eq(taskAttachments.sha256, sha256)))
    .limit(1);
  if (rows.length > 0) return false;
  try {
    await fs.unlink(resolveStoragePath(storageKey));
    return true;
  } catch {
    return false;
  }
}

export interface AttachmentRow {
  id: number;
  taskId: number;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  inline: boolean;
  uploadedBy: { userId: number | null; displayName: string | null; isAgent: boolean };
  createdAt: string | null;
  url: string;
}

export function serializeAttachment(row: TaskAttachment, uploader: { displayName: string | null; isAgent: boolean } | null): AttachmentRow {
  return {
    id: row.id,
    taskId: row.taskId,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    inline: isInlineMime(row.mime),
    uploadedBy: { userId: row.userId, displayName: uploader?.displayName ?? null, isAgent: uploader?.isAgent ?? false },
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    url: `/api/plan/attachments/${row.id}`,
  };
}

/** Every attachment on one card, oldest first, with who uploaded it. */
export async function listAttachments(orgId: number, taskId: number): Promise<AttachmentRow[]> {
  const rows = await db
    .select({ a: taskAttachments, displayName: users.displayName, isAgent: users.isAgent })
    .from(taskAttachments)
    .leftJoin(users, eq(taskAttachments.userId, users.id))
    .where(and(eq(taskAttachments.orgId, orgId), eq(taskAttachments.taskId, taskId)))
    .orderBy(asc(taskAttachments.createdAt), asc(taskAttachments.id));
  return rows.map((r) => serializeAttachment(r.a as TaskAttachment, r.displayName === null && r.isAgent === null ? null : { displayName: r.displayName, isAgent: !!r.isAgent }));
}

export async function fetchAttachment(orgId: number, id: number): Promise<TaskAttachment | null> {
  const [row] = await db
    .select()
    .from(taskAttachments)
    .where(and(eq(taskAttachments.id, id), eq(taskAttachments.orgId, orgId)))
    .limit(1);
  return (row as TaskAttachment) ?? null;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
