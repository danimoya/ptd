/**
 * `POST /api/contact` — the one form on the public page.
 *
 * It backs the third pricing column ("Larger deployments & consulting"), which
 * flips in place into a form rather than navigating anywhere. Three decisions
 * are worth stating, because they are the ones a reader will second-guess:
 *
 *   1. **It always answers 200 once the body is valid.** A landing-page form
 *      that returns 500 because the mail server is down loses the lead *and*
 *      tells a stranger about our infrastructure. When SMTP is unconfigured or
 *      refuses the letter, the reply carries `queued: false` and the address to
 *      write to instead, and the form prints that. Only a malformed body gets a
 *      400.
 *   2. **The honeypot answers 200 too, and sends nothing.** `website` is a
 *      field no human sees; anything that fills it is scripted. Telling a bot
 *      it was caught only teaches the bot. It gets the same `{ queued: true }`
 *      a real submission gets.
 *   3. **Reply-to is the submitter, From is ours.** The letter must pass SPF
 *      and DKIM for the domain that sent it, so it cannot be From the stranger
 *      who filled the form — it is From our own SMTP identity with `replyTo`
 *      set, which makes "reply" in any mail client do the obvious thing.
 *
 * `server/email/send.ts` has no seam for `replyTo` (its three letters are all
 * transactional mail to a known member), so this route goes one layer down to
 * the same memoised transport that file uses. Same configuration, same
 * never-throws contract, one extra header. `setEmailTransport()` remains the
 * injection point for tests.
 */

import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { emailTransport, smtpEnv } from "./email/transport";
import { escapeHtml } from "./email/templates";

/* ── Where it lands ──────────────────────────────────────────────────── */

/** The desk that reads these. Overridable so a self-hoster gets their own. */
export function contactRecipient(): string {
  return (process.env.CONTACT_TO || "").trim() || "me@danimoya.com";
}

/* ── What we accept ──────────────────────────────────────────────────── */

export const ORG_SIZES = ["1–10", "11–50", "51–200", "201–1000", "1000+"] as const;

export const NEEDS = {
  hosted: "Hosted at scale",
  "on-prem": "On-premises deployment",
  consulting: "Implementation & integration consulting",
} as const;

export type Need = keyof typeof NEEDS;

const trimmed = (max: number) => z.string().trim().max(max);

export const contactSchema = z.object({
  name: trimmed(120).min(1, "Tell us who you are"),
  email: trimmed(200).min(1, "We need an address to reply to").email("That does not look like an email address"),
  company: trimmed(160).optional().default(""),
  orgSize: z.enum(ORG_SIZES).optional().default("11–50"),
  need: z.enum(["hosted", "on-prem", "consulting"] as const).optional().default("hosted"),
  message: trimmed(4000).min(1, "Say what you need"),
  // The honeypot. Named for something a scraper wants to fill and a person
  // never sees; the field is `aria-hidden` and off-screen in the form.
  website: z.string().max(400).optional().default(""),
});

export type ContactInput = z.infer<typeof contactSchema>;

/* ── The letter ──────────────────────────────────────────────────────── */

export interface ContactLetter {
  subject: string;
  text: string;
  html: string;
}

const PARCHMENT = "#F4F1EA";
const INK = "#1A1510";
const MUTED = "#6E6257";
const RULE = "#DCD3C4";

/**
 * Plain text first, HTML second, and both carry every field — a lead read on a
 * phone with images off is still a lead.
 */
export function contactLetter(input: ContactInput): ContactLetter {
  const rows: [string, string][] = [
    ["Name", input.name],
    ["Email", input.email],
    ["Company", input.company || "—"],
    ["Organization size", input.orgSize],
    ["Needs", NEEDS[input.need as Need]],
  ];

  const subject = `PTD enquiry — ${input.name}${input.company ? ` (${input.company})` : ""}`;

  const text = [
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    input.message,
    "",
    "— sent from the pricing section of the PTD landing page",
  ].join("\n");

  const html = [
    `<div style="background:${PARCHMENT};padding:24px;font-family:Georgia,'Times New Roman',serif;color:${INK}">`,
    `<div style="max-width:560px;margin:0 auto">`,
    `<p style="margin:0 0 4px;font:500 11px/1.4 ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase;color:${MUTED}">PTD · enquiry</p>`,
    `<h1 style="margin:0 0 16px;font-size:22px;font-weight:600">${escapeHtml(input.name)} wants to talk</h1>`,
    `<table style="width:100%;border-collapse:collapse;margin:0 0 16px">`,
    ...rows.map(
      ([k, v]) =>
        `<tr><th align="left" style="border-bottom:1px solid ${RULE};padding:6px 0;font:500 11px/1.4 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:${MUTED};font-weight:500">${escapeHtml(
          k
        )}</th><td align="right" style="border-bottom:1px solid ${RULE};padding:6px 0;font-size:15px">${escapeHtml(v)}</td></tr>`
    ),
    `</table>`,
    `<div style="border-left:2px solid ${INK};padding:2px 0 2px 14px;font-size:15px;line-height:1.6;white-space:pre-wrap">${escapeHtml(
      input.message
    )}</div>`,
    `<p style="margin:20px 0 0;font:11px/1.5 ui-monospace,monospace;color:${MUTED}">Reply to this letter and it goes straight to ${escapeHtml(
      input.email
    )}.</p>`,
    `</div></div>`,
  ].join("");

  return { subject, text, html };
}

/* ── Handing it to SMTP ──────────────────────────────────────────────── */

export interface ContactSendResult {
  queued: boolean;
  reason?: "smtp_not_configured" | "smtp_error";
}

/** Never throws; the caller has already decided to answer 200. */
export async function sendContactLetter(input: ContactInput): Promise<ContactSendResult> {
  const transport = emailTransport();
  if (!transport) return { queued: false, reason: "smtp_not_configured" };
  const letter = contactLetter(input);
  try {
    await transport.sendMail({
      from: smtpEnv().from,
      to: contactRecipient(),
      replyTo: `${input.name} <${input.email}>`,
      subject: letter.subject,
      text: letter.text,
      html: letter.html,
    });
    return { queued: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[contact] could not send the enquiry from ${input.email}: ${message}`);
    return { queued: false, reason: "smtp_error" };
  }
}

/* ── The route ───────────────────────────────────────────────────────── */

/**
 * Five in a quarter of an hour. A real person fills this once; the ceiling is
 * there so a script cannot turn the form into a relay for our mail server.
 * Deliberately stricter than `authLimiter` (20/15min) — nobody mistypes an
 * enquiry four times.
 */
export const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many enquiries from this address. Try again later, or write to us directly." },
});

export async function handleContact(req: Request, res: Response) {
  const parsed = contactSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const input = parsed.data;

  // Caught. Answer exactly as if it had worked, and send nothing.
  if (input.website.trim() !== "") {
    return res.status(200).json({ ok: true, queued: true });
  }

  const result = await sendContactLetter(input);
  if (result.queued) return res.status(200).json({ ok: true, queued: true });
  return res.status(200).json({ ok: true, queued: false, reason: result.reason, contactEmail: contactRecipient() });
}

export function registerContactRoutes(app: Express) {
  app.post("/api/contact", contactLimiter, handleContact);
}
