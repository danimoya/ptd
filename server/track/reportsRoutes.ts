/**
 * The one reporting endpoint that cannot be an action: the invoice PDF.
 *
 * Everything else in this feature goes through `POST /api/actions/<name>`, which
 * answers JSON. A PDF is bytes with a content type, so it needs a route of its
 * own — and it stays a plain authenticated GET so the URL recorded on the
 * `invoices` row (`/api/track/invoices/<id>.pdf`) is a real, re-fetchable link
 * rather than a one-shot download.
 *
 * The document is rendered on demand from the ledger rather than stored, so a
 * corrected entry is reflected the next time anyone opens the invoice, and no
 * stale artefact can outlive the rows it was drawn from.
 *
 * Wire it up in server/routes.ts:  registerReportsRoutes(app);
 */

import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { invoices, organizations } from "../../db/schema";
import { auth } from "../auth";
import { resolveOrg } from "../orgs";
import { contextFromRequest } from "../actions/context";
import { hasRole } from "../types";
import { buildInvoiceData, renderInvoicePdf } from "./invoice";

/** Safe for a Content-Disposition filename on every client. */
const slug = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "customer";

export function registerReportsRoutes(app: Express) {
  app.get("/api/track/invoices/:id.pdf", auth, resolveOrg, async (req: Request, res: Response) => {
    const ctx = contextFromRequest(req);
    // Invoices are a billing artefact, so the gate matches `invoice.generate`.
    if (!hasRole(ctx.role, "manager")) {
      return res.status(403).json({ error: "forbidden", message: "Reading an invoice requires manager or above" });
    }

    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
      return res.status(400).json({ error: "invalid", message: "Invoice id must be a positive integer" });
    }

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, ctx.orgId)))
      .limit(1);
    if (!invoice) return res.status(404).json({ error: "not_found", message: `Invoice ${invoiceId} not found` });
    if (invoice.customerId === null) {
      return res.status(409).json({ error: "conflict", message: "That invoice's customer has been deleted, so it can no longer be rendered" });
    }

    try {
      const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.orgId)).limit(1);
      const data = await buildInvoiceData({
        orgId: ctx.orgId,
        orgName: org?.name ?? "Plan Track Done",
        customerId: invoice.customerId,
        month: invoice.month,
        year: invoice.year,
        invoiceId: invoice.id,
        status: invoice.status,
        issuedAt: invoice.createdAt,
      });
      const pdf = await renderInvoicePdf(data);
      const filename = `invoice-${slug(data.customer.name)}-${data.period.year}-${String(data.period.month).padStart(2, "0")}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(pdf.length));
      // `inline` so the browser can preview it; the client still offers a save.
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(pdf);
    } catch (err) {
      console.error("[invoice pdf]", err);
      if (!res.headersSent) res.status(500).json({ error: "internal", message: "Failed to render the invoice" });
    }
  });
}
