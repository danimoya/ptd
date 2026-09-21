/**
 * The reporting routes that cannot be actions.
 *
 * Everything else in this feature goes through `POST /api/actions/<name>`, which
 * answers JSON. These three cannot:
 *
 *  - **`GET /api/track/invoices/:id.pdf`** — a PDF is bytes with a content type.
 *    It stays a plain authenticated GET so the URL recorded on the `invoices` row
 *    is a real, re-fetchable link rather than a one-shot download. An invoice that
 *    has been certified is drawn from its own snapshot, because the content hash
 *    printed on it is the hash of that record; an older uncertified row is still
 *    drawn from the ledger, as it always was.
 *
 *  - **`GET /api/verify/:token`** — the point of certification. It is public and
 *    unauthenticated by design: the people who need to check an invoice are the
 *    client's accountant and the contractor's bank, and neither has an account
 *    here. It is rate-limited, and the token is 32 random bytes so the endpoint
 *    cannot be walked. What it answers is now deliberately anonymous — a
 *    reference, a kind, an issue date, whether it was withdrawn, and the three
 *    integrity checks. A verification link travels: it is printed on a document
 *    that gets forwarded, filed and attached to other mail, so it must prove a
 *    document is genuine without saying whose it is or what it is worth.
 *
 *  - **`POST /api/verify/:token/request-code`**, **`/redeem`** and
 *    **`GET /api/verify/:token/details`** — how the particulars are released. A
 *    named recipient (or the issuing organization's own managers, or the
 *    contractor being paid) asks for a six-digit code, it is emailed to that
 *    address, and redeeming it returns the full account plus a thirty-minute
 *    access token bound to this one invoice. Asking is never an oracle: every
 *    outcome answers the same sentence.
 *
 *  - **`GET /.well-known/ptd-signing-key.json`** — the public half of every key
 *    this deployment has ever signed with, so a verifier can check a signature
 *    without trusting the verification endpoint's own answer.
 *
 * Wire it up in server/routes.ts:  registerReportsRoutes(app);
 */

import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { invoices, organizations } from "../../db/schema";
import { auth } from "../auth";
import { resolveOrg } from "../orgs";
import { contextFromRequest } from "../actions/context";
import { hasRole } from "../types";
import { heavyLimiter } from "../rate-limit";
import { buildInvoiceData, customerDataFromSnapshot, renderContractorInvoicePdf, renderInvoicePdf } from "./invoice";
import { buildContractorInvoice, contractorDataFromSnapshot } from "../invoices/contractor";
import { certificationOf } from "../invoices/issue";
import { billingProfile } from "../invoices/entries";
import { publishedKeys } from "../invoices/keys";
import { publicVerifyByToken, verifyByToken } from "../invoices/verify";
import {
  ACCESS_TTL_SECONDS,
  MAX_CODE_ATTEMPTS,
  NEUTRAL_REQUEST_MESSAGE,
  redeemAccessCode,
  requestAccessCode,
  verifyAccessToken,
} from "../invoices/access";
import type { InvoiceSnapshot } from "../invoices/snapshot";

/** Safe for a Content-Disposition filename on every client. */
const slug = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "invoice";

/* ── The access-code ceilings ────────────────────────────────────────── */

/**
 * Per token *and* per address, not per address alone.
 *
 * One ceiling on the IP would let a client's whole office share a budget of five
 * codes; one ceiling on the token would let anyone who has the link lock its
 * recipients out by asking five times. Keyed on both, a nuisance can only spend
 * the budget they are sitting in.
 */
const perTokenAndIp = (name: string, max: number, message: string) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => `${name}:${req.ip ?? "unknown"}:${String(req.params.token ?? "")}`,
    message: { error: "rate_limited", message },
  });

const requestCodeLimiter = perTokenAndIp(
  "verify-request",
  5,
  "Too many access codes have been requested for this invoice from here. Try again in a quarter of an hour."
);

const redeemLimiter = perTokenAndIp("verify-redeem", 15, "Too many attempts. Try again in a quarter of an hour.");

const emailIn = z.object({ email: z.string().trim().min(3).max(200).email() });
const redeemIn = emailIn.extend({ code: z.string().trim().min(4).max(12) });

export function registerReportsRoutes(app: Express) {
  app.get("/api/track/invoices/:id.pdf", auth, resolveOrg, async (req: Request, res: Response) => {
    const ctx = contextFromRequest(req);
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

    const isContractor = invoice.kind === "contractor";
    // A contractor invoice is about the member, and they are the party being paid,
    // so they may always fetch their own. Everything else matches `invoice.generate`.
    const allowed = hasRole(ctx.role, "manager") || (isContractor && invoice.memberUserId === ctx.userId);
    if (!allowed) {
      return res.status(403).json({ error: "forbidden", message: "Reading this invoice requires manager or above" });
    }

    try {
      const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.orgId)).limit(1);
      const orgName = org?.name ?? "Plan Track Done";
      const certification = certificationOf(invoice);
      const snapshot = (invoice.snapshot ?? null) as InvoiceSnapshot | null;
      let pdf: Buffer;
      let filename: string;

      if (isContractor) {
        if (invoice.memberUserId === null) {
          return res.status(409).json({ error: "conflict", message: "That invoice's member has been deleted, so it can no longer be rendered" });
        }
        const profile = await billingProfile(ctx.orgId, invoice.memberUserId);
        const data = snapshot
          ? contractorDataFromSnapshot(snapshot, {
              invoiceId: invoice.id,
              status: invoice.status,
              certification,
              billingAddress: profile?.billingAddress ?? null,
              email: profile?.email,
            })
          : await buildContractorInvoice({
              orgId: ctx.orgId,
              orgName,
              userId: invoice.memberUserId,
              month: invoice.month,
              year: invoice.year,
              invoiceId: invoice.id,
              status: invoice.status,
              issuedAt: invoice.issuedAt ?? invoice.createdAt,
              certification,
            });
        pdf = await renderContractorInvoicePdf(data);
        filename = `invoice-${slug(data.contractor.billingName ?? data.contractor.name)}-${data.period.year}-${String(data.period.month).padStart(2, "0")}.pdf`;
      } else {
        if (invoice.customerId === null && !snapshot) {
          return res.status(409).json({ error: "conflict", message: "That invoice's customer has been deleted, so it can no longer be rendered" });
        }
        const data = snapshot
          ? customerDataFromSnapshot(snapshot, { invoiceId: invoice.id, status: invoice.status, certification })
          : await buildInvoiceData({
              orgId: ctx.orgId,
              orgName,
              customerId: invoice.customerId as number,
              month: invoice.month,
              year: invoice.year,
              invoiceId: invoice.id,
              status: invoice.status,
              issuedAt: invoice.issuedAt ?? invoice.createdAt,
              certification,
            });
        pdf = await renderInvoicePdf(data);
        filename = `invoice-${slug(data.customer.name)}-${data.period.year}-${String(data.period.month).padStart(2, "0")}.pdf`;
      }

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

  /**
   * Public verification. No auth, no organization header, no way to enumerate:
   * a wrong token gets the same answer as a token that never existed.
   *
   * Anonymous by construction — it cannot name the organization or the amount
   * because `publicVerifyByToken` never carries them off the server.
   */
  app.get("/api/verify/:token", heavyLimiter, async (req: Request, res: Response) => {
    try {
      const result = await publicVerifyByToken(String(req.params.token ?? ""));
      res.setHeader("Cache-Control", "no-store");
      res.status(result.invoice ? 200 : 404).json(result);
    } catch (err) {
      console.error("[invoice verify]", err);
      res.status(500).json({ valid: false, reason: "Verification could not be completed." });
    }
  });

  /**
   * Ask for a code. Always 200, always the same sentence — an address nobody
   * named, an address on the allowlist and a token that never existed are
   * indistinguishable from out here.
   */
  app.post("/api/verify/:token/request-code", requestCodeLimiter, async (req: Request, res: Response) => {
    const parsed = emailIn.safeParse(req.body ?? {});
    res.setHeader("Cache-Control", "no-store");
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid", message: "That does not look like an email address." });
    }
    try {
      const outcome = await requestAccessCode({ token: String(req.params.token ?? ""), email: parsed.data.email, ip: req.ip ?? null });
      res.status(200).json(outcome);
    } catch (err) {
      console.error("[invoice access request]", err);
      // Even a failure answers the neutral sentence: a 500 here would tell a
      // stranger which addresses are worth trying.
      res.status(200).json({ message: NEUTRAL_REQUEST_MESSAGE });
    }
  });

  /**
   * Redeem it. On success the full account comes back with the access token, so
   * the page does not have to make a second round trip to show anything.
   */
  app.post("/api/verify/:token/redeem", redeemLimiter, async (req: Request, res: Response) => {
    const parsed = redeemIn.safeParse(req.body ?? {});
    res.setHeader("Cache-Control", "no-store");
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid", message: "Give the address the code was sent to, and the code." });
    }
    const token = String(req.params.token ?? "");
    try {
      const outcome = await redeemAccessCode({ token, email: parsed.data.email, code: parsed.data.code, ip: req.ip ?? null });
      if (!outcome.ok) {
        return res.status(401).json({
          error: outcome.failure === "locked" ? "code_locked" : "invalid_code",
          message:
            outcome.failure === "locked"
              ? `That code has been refused ${MAX_CODE_ATTEMPTS} times and is now dead. Request a new one.`
              : "That code is not valid, or it has expired. Request a new one.",
        });
      }
      const full = await verifyByToken(token);
      res.status(200).json({ access: { token: outcome.accessToken, expiresAt: outcome.expiresAt, ttlSeconds: ACCESS_TTL_SECONDS }, ...full });
    } catch (err) {
      console.error("[invoice access redeem]", err);
      res.status(500).json({ error: "internal", message: "The code could not be checked." });
    }
  });

  /**
   * The details again, for a page that already holds an access token — a reload,
   * or a tab restored from session storage. The token names the one invoice it
   * was minted for, so it cannot be carried to another.
   */
  app.get("/api/verify/:token/details", heavyLimiter, async (req: Request, res: Response) => {
    const token = String(req.params.token ?? "");
    res.setHeader("Cache-Control", "no-store");
    // Header only. An access token in a query string ends up in access logs, in
    // `Referer` on every link the page carries, and in a pasted URL.
    const claim = verifyAccessToken(req.header("Authorization") ?? "", token);
    if (!claim) {
      return res.status(401).json({ error: "access_required", message: "Ask for an access code to see this invoice's details." });
    }
    try {
      const full = await verifyByToken(token);
      res.status(full.invoice ? 200 : 404).json(full);
    } catch (err) {
      console.error("[invoice access details]", err);
      res.status(500).json({ error: "internal", message: "Verification could not be completed." });
    }
  });

  /** Every public key this deployment has signed with, retired ones included. */
  app.get("/.well-known/ptd-signing-key.json", async (_req: Request, res: Response) => {
    try {
      const keys = await publishedKeys();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json({
        algorithm: "ed25519",
        note: "Invoice signatures are Ed25519 over the ASCII of the invoice's sha-256 content hash, base64-encoded. Retired keys stay published so invoices they signed keep verifying.",
        keys,
      });
    } catch (err) {
      console.error("[signing key document]", err);
      res.status(500).json({ error: "internal", message: "Could not read the signing keys" });
    }
  });
}
