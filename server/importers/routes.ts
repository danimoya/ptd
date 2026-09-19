/**
 * HTTP for the importer.
 *
 * Two endpoints that the action registry cannot cover, because both are about
 * *files* rather than JSON arguments:
 *
 *   POST /api/import/upload          a CSV as a multipart form, as raw text, or
 *                                    as {"csv": "…"} JSON — up to 5 MB — and
 *                                    back comes the same answer `import.preview`
 *                                    gives, so the browser can drop a file in
 *                                    without base64-ing it into a JSON body.
 *   GET  /api/import/template/:s.csv an example file per source, to download,
 *                                    fill in and upload back.
 *
 * `express.text({ limit: "5mb" })` is mounted on the upload route ONLY. The
 * global `express.json()` in server/index.ts has already run by then; body-parser
 * sets `req._body` once a body has been consumed and every later parser honours
 * it, so a JSON request arrives here as a parsed object and anything else — CSV
 * text, a multipart envelope — arrives as a string for the branch below to sort
 * out. A global text parser would break every other endpoint in the product.
 */

import express, { type Express, type Request, type Response } from "express";
import { auth } from "../auth";
import { resolveOrg, requireRole } from "../orgs";
import { heavyLimiter } from "../rate-limit";
import { contextFromRequest } from "../actions/context";
import { ActionError } from "../actions/registry";
import { preview } from "./apply";
import { MAPPERS, mapperFor } from "./mappers";
import { toCsv } from "./csv";
import { FIELD_LABELS, IGNORE, SOURCES, TASK_FIELDS, TIME_FIELDS, type Source, type SourceArg } from "./types";

export const MAX_UPLOAD = "5mb";

/** Read the CSV out of whatever shape the client sent. */
export function extractCsv(body: unknown, contentType: string): { csv: string; filename: string | null } {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.csv === "string") return { csv: record.csv, filename: null };
    throw new ActionError("invalid", 'A JSON body must carry the file text as {"csv": "…"}.');
  }
  if (typeof body !== "string" || body.length === 0) {
    throw new ActionError("invalid", "No file content. Send a multipart form, a text/csv body, or JSON {\"csv\": \"…\"}.");
  }
  if (/multipart\/form-data/i.test(contentType)) return parseMultipart(body, contentType);
  return { csv: body, filename: null };
}

/**
 * The one multipart case we need: a small text file in a browser form.
 *
 * Written out rather than pulled in as a dependency (`multer`), because the
 * whole requirement is "find the one part that has a filename, in a body we
 * already hold in memory as a 5 MB-capped string". Binary parts are not a
 * concern — a CSV is text, and anything else is rejected downstream by the
 * parser rather than here.
 */
export function parseMultipart(body: string, contentType: string): { csv: string; filename: string | null } {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const marker = (boundary?.[1] ?? boundary?.[2] ?? "").trim();
  if (!marker) throw new ActionError("invalid", "The multipart body has no boundary.");

  const parts = body.split(`--${marker}`);
  let fallback: { csv: string; filename: string | null } | null = null;
  for (const part of parts) {
    const split = part.indexOf("\r\n\r\n");
    if (split === -1) continue;
    const headers = part.slice(0, split);
    if (!/content-disposition/i.test(headers)) continue;
    // Strip the CRLF that belongs to the following boundary delimiter.
    const content = part.slice(split + 4).replace(/\r\n$/, "");
    const filename = headers.match(/filename="([^"]*)"/i)?.[1] ?? null;
    const name = headers.match(/\bname="([^"]*)"/i)?.[1] ?? "";
    if (filename) return { csv: content, filename };
    if (!fallback && ["csv", "file", "text"].includes(name.toLowerCase())) fallback = { csv: content, filename: null };
  }
  if (fallback) return fallback;
  throw new ActionError("invalid", "No file part found in the multipart body.");
}

/** `?source=` / form field, validated against the known sources. */
export function readSource(value: unknown): SourceArg {
  if (typeof value !== "string" || value === "" || value === "auto") return "auto";
  if ((SOURCES as readonly string[]).includes(value)) return value as Source;
  throw new ActionError("invalid", `Unknown source "${value}". One of: auto, ${SOURCES.join(", ")}.`);
}

const STATUS: Record<ActionError["code"], number> = { forbidden: 403, not_found: 404, invalid: 400, conflict: 409 };

export function registerImportRoutes(app: Express) {
  app.post(
    "/api/import/upload",
    auth,
    resolveOrg,
    requireRole("manager"),
    heavyLimiter,
    // Every content type EXCEPT the JSON that express.json() already took.
    express.text({ limit: MAX_UPLOAD, type: () => true }),
    async (req: Request, res: Response) => {
      try {
        const { csv, filename } = extractCsv(req.body, req.header("content-type") ?? "");
        const source = readSource(req.query.source);
        const ctx = contextFromRequest(req, "import");
        const result = await preview({ source, csv }, ctx);
        res.json({
          filename,
          bytes: Buffer.byteLength(csv, "utf8"),
          ...result,
          fields: fieldCatalogue(result.kind),
          next: "Adjust `mapping` if a column landed on the wrong field, then POST the same csv to /api/actions/import.commit.",
        });
      } catch (err) {
        if (err instanceof ActionError) return res.status(STATUS[err.code]).json({ error: err.code, message: err.message });
        console.error("[import upload]", err);
        res.status(500).json({ error: "internal", message: "Could not read that file." });
      }
    }
  );

  app.get("/api/import/template/:source.csv", auth, resolveOrg, (req: Request, res: Response) => {
    // `:source.csv` keeps or drops the extension depending on the path-to-regexp
    // version express is built against; strip it either way.
    const raw = String((req.params as Record<string, string>).source ?? "").replace(/\.csv$/i, "");
    let source: Source;
    try {
      const parsed = readSource(raw);
      if (parsed === "auto") throw new ActionError("invalid", "Name a source, not 'auto'.");
      source = parsed;
    } catch (err) {
      const message = err instanceof ActionError ? err.message : "Unknown source.";
      return res.status(404).json({ error: "not_found", message, sources: SOURCES });
    }
    const body = toCsv(mapperFor(source).template());
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="ptd-${source}-template.csv"`);
    res.set("Cache-Control", "public, max-age=3600");
    res.send(body);
  });

  app.get("/api/import/sources", auth, resolveOrg, (_req: Request, res: Response) => {
    res.json(
      MAPPERS.map((m) => ({
        source: m.source,
        kind: m.kind,
        label: m.label,
        hint: m.hint,
        template: `/api/import/template/${m.source}.csv`,
      }))
    );
  });
}

function fieldCatalogue(kind: "task" | "time") {
  const fields = kind === "task" ? TASK_FIELDS : TIME_FIELDS;
  return [{ field: IGNORE, label: FIELD_LABELS[IGNORE] }, ...fields.map((f) => ({ field: f, label: FIELD_LABELS[f] ?? f }))];
}
