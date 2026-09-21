/**
 * Who may read a certified invoice, and the emailed code that lets them.
 *
 * The verification link is printed on a document that travels: it goes to a
 * client, an accountant, a bank, and it gets forwarded. So the link proves one
 * thing to whoever holds it — *this is a genuine PTD invoice, issued on this
 * date, and its record is intact* — and nothing else. No organization name, no
 * contractor or customer, no period, no amounts, no lines. Those are released
 * only to an address that was named as a recipient, and only after a six-digit
 * code sent to that address is typed back in.
 *
 * Four decisions are worth stating, because they are the ones that make this
 * safe rather than ceremonial.
 *
 *  1. **No address is stored.** A recipient is `sha256(verifyToken + ":" +
 *     address)` plus a mask like `a••••a@northwind.example`. The token is 32
 *     random bytes, so the hash is salted per invoice: the same accountant on two
 *     invoices produces two unrelated hashes, and the column cannot be turned
 *     back into a mailing list. The cost is that "resend" means retyping the
 *     address — which is the honest behaviour for a system that does not keep it.
 *  2. **Asking is never an oracle.** `request-code` answers the same sentence
 *     for an address on the allowlist, an address that is not, and a token that
 *     never existed. Nothing in the response, its shape or its timing says which.
 *  3. **The state rides in the snapshot, unsigned.** `invoices` has no column for
 *     this and the schema is frozen, so recipients and codes live in
 *     `snapshot.access` — which `contentHashOf` strips before hashing, so sharing
 *     an invoice cannot break the hash printed on a PDF already in the post.
 *  4. **The code buys a purposed JWT, not a session.** It carries
 *     `purpose: "invoice.access"`, the hash of the one token it was issued for and
 *     the recipient's hash, and lasts thirty minutes. `verifySessionJwt` refuses
 *     any token with a purpose, so it can never be used as a login, and it cannot
 *     be replayed against another invoice.
 */

import { randomInt, timingSafeEqual } from "crypto";
import jwt from "jsonwebtoken";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { invoices, memberships, users } from "../../db/schema";
import { audit } from "../audit/log";
import { sendLetter } from "../email/send";
import { escapeHtml } from "../email/templates";
import { isEmailConfigured } from "../email/transport";
import { verifyUrlFor } from "./issue";
import { emptyAccess, sha256Hex, type AccessCode, type AccessRecipient, type InvoiceAccess, type InvoiceSnapshot } from "./snapshot";

/* ── The dials ───────────────────────────────────────────────────────── */

/** Long enough to switch to a mail client, short enough to be worthless later. */
export const CODE_TTL_SECONDS = 600;
/** Wrong codes before the code dies and a new one has to be asked for. */
export const MAX_CODE_ATTEMPTS = 5;
/** How long the details stay open once a code has been redeemed. */
export const ACCESS_TTL_SECONDS = 1800;
/** Codes kept per invoice; oldest are pruned. One recipient only ever has one. */
const MAX_LIVE_CODES = 20;
/** Recipients per invoice. A document with fifty named readers is not a private link. */
export const MAX_RECIPIENTS = 50;

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "dev-secret");
const ACCESS_PURPOSE = "invoice.access" as const;

/** The one sentence `request-code` ever answers. Says nothing about the address. */
export const NEUTRAL_REQUEST_MESSAGE =
  "If that address is a named recipient of this invoice, an access code is on its way. It is valid for 10 minutes.";

/* ── Addresses, hashed ───────────────────────────────────────────────── */

export const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();

/** Per-invoice salted hash: the token is secret to whoever holds the document. */
export const recipientHash = (verifyToken: string, email: string): string => sha256Hex(`${verifyToken}:${normaliseEmail(email)}`);

/** The code's stored form. Salted with the token too, so a stolen row is not a code. */
export const codeHashOf = (verifyToken: string, code: string): string => sha256Hex(`${code}:${verifyToken}`);

/**
 * `annika@northwind.example` → `a••••a@northwind.example`.
 *
 * The domain survives because a manager checking a list needs to see they sent it
 * to the client's domain and not a personal one; the local part does not, because
 * that is the part that names a person.
 */
export function maskEmail(email: string): string {
  const at = normaliseEmail(email).lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = normaliseEmail(email).slice(0, at);
  const domain = normaliseEmail(email).slice(at);
  if (local.length <= 2) return `${local[0]}•${domain}`;
  return `${local[0]}${"•".repeat(Math.min(6, local.length - 2))}${local[local.length - 1]}${domain}`;
}

/** Six digits, leading zeros kept — 000123 is as good a code as any other. */
export const mintCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** `123 456` — what a letter prints, because nobody reads six digits in one run. */
export const formatCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

const sameHash = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

/* ── The row this all hangs off ──────────────────────────────────────── */

export interface InvoiceAccessRow {
  id: number;
  orgId: number;
  kind: string;
  memberUserId: number | null;
  reference: string | null;
  verifyToken: string;
  snapshot: InvoiceSnapshot;
}

const ROW = {
  id: invoices.id,
  orgId: invoices.orgId,
  kind: invoices.kind,
  memberUserId: invoices.memberUserId,
  reference: invoices.reference,
  verifyToken: invoices.verifyToken,
  snapshot: invoices.snapshot,
} as const;

const usable = (row: { verifyToken: string | null; snapshot: unknown } | undefined): InvoiceAccessRow | null =>
  row && row.verifyToken && row.snapshot ? (row as InvoiceAccessRow) : null;

export async function invoiceByVerifyToken(token: string): Promise<InvoiceAccessRow | null> {
  if (!/^[0-9a-f]{64}$/i.test(token)) return null;
  const [row] = await db.select(ROW).from(invoices).where(eq(invoices.verifyToken, token)).limit(1);
  return usable(row);
}

export async function invoiceForSharing(orgId: number, invoiceId: number): Promise<InvoiceAccessRow | null> {
  const [row] = await db
    .select(ROW)
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)))
    .limit(1);
  return usable(row);
}

export const accessOf = (snapshot: InvoiceSnapshot): InvoiceAccess => {
  const raw = snapshot.access;
  if (!raw || typeof raw !== "object") return emptyAccess();
  return { version: 1, recipients: Array.isArray(raw.recipients) ? raw.recipients : [], codes: Array.isArray(raw.codes) ? raw.codes : [] };
};

/**
 * Write the access block back.
 *
 * Read-modify-write of one jsonb column rather than a partial update: the
 * deployment's database speaks plain SQL only, and the whole point of the column
 * is that it is small. Two codes requested in the same millisecond can therefore
 * lose one write; the loser simply asks again, which is why nothing irreversible
 * is ever recorded here.
 */
async function writeAccess(row: InvoiceAccessRow, access: InvoiceAccess): Promise<void> {
  const next: InvoiceSnapshot = { ...row.snapshot, access };
  await db
    .update(invoices)
    .set({ snapshot: next as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(invoices.id, row.id));
  // Keep the caller's copy in step, so a handler that shares twice in one call
  // does not write the first change away.
  row.snapshot = next;
}

/* ── The allowlist ───────────────────────────────────────────────────── */

/**
 * Every address this invoice will send a code to, besides the named recipients:
 * the organization's owner, admins and managers — who can read the document in
 * the application anyway — and, on a contractor invoice, the contractor
 * themselves. Agent seats are left out: an agent has no inbox.
 */
async function standingAddresses(row: InvoiceAccessRow): Promise<string[]> {
  const staff = await db
    .select({ email: users.email, role: memberships.role, isAgent: users.isAgent, userId: users.id })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.orgId, row.orgId), inArray(memberships.role, ["owner", "admin", "manager"])));
  const out = staff.filter((s) => !s.isAgent).map((s) => normaliseEmail(s.email));

  if (row.memberUserId !== null) {
    const [member] = await db.select({ email: users.email }).from(users).where(eq(users.id, row.memberUserId)).limit(1);
    if (member?.email) out.push(normaliseEmail(member.email));
  }
  return out;
}

export type Eligibility = "recipient" | "standing" | "none";

/** Is this address allowed to ask for a code? The answer never leaves the server. */
export async function eligibilityOf(row: InvoiceAccessRow, email: string): Promise<Eligibility> {
  const hash = recipientHash(row.verifyToken, email);
  if (accessOf(row.snapshot).recipients.some((r) => sameHash(r.hash, hash))) return "recipient";
  const standing = await standingAddresses(row);
  return standing.includes(normaliseEmail(email)) ? "standing" : "none";
}

/* ── Seeding the allowlist when the invoice is issued ─────────────────── */

/**
 * The addresses an invoice is born knowing: the contractor being paid, and a
 * customer's billing address when one is recorded. Both are parties to the
 * document — they are going to be sent it — so neither should have to be shared
 * by hand before they can read their own invoice.
 */
export async function initialAccess(args: { verifyToken: string; snapshot: InvoiceSnapshot; memberUserId?: number | null }): Promise<InvoiceAccess> {
  const addresses: string[] = [];
  const contractorUserId = args.memberUserId ?? args.snapshot.contractor?.userId ?? null;
  if (contractorUserId !== null) {
    const [member] = await db.select({ email: users.email, isAgent: users.isAgent }).from(users).where(eq(users.id, contractorUserId)).limit(1);
    if (member?.email && !member.isAgent) addresses.push(member.email);
  }
  const billing = args.snapshot.customer?.billingEmail;
  if (billing) addresses.push(billing);

  const at = new Date().toISOString();
  const access = emptyAccess();
  for (const address of addresses) {
    const hash = recipientHash(args.verifyToken, address);
    if (access.recipients.some((r) => r.hash === hash)) continue;
    access.recipients.push({ hash, mask: maskEmail(address), addedAt: at, addedBy: null, via: "issue", requests: 0, grants: 0 });
  }
  return access;
}

/* ── The letters ─────────────────────────────────────────────────────── */

const PARCHMENT = "#F4F1EA";
const CARD = "#FBF9F4";
const INK = "#1A1510";
const MUTED = "#6B6255";
const VERMILION = "#B8451A";
const RULE = "#D9D2C4";
const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";
const MONO = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";

export interface Letter {
  subject: string;
  text: string;
  html: string;
}

function shell(body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${PARCHMENT};color:${INK};font-family:${SERIF};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PARCHMENT};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${CARD};border:1px solid ${RULE};">
<tr><td style="padding:22px 28px 14px 28px;border-bottom:1px solid ${RULE};">
<div style="font-family:${MONO};font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${VERMILION};">Plan &middot; Track &middot; Done</div>
<div style="font-family:${SERIF};font-size:26px;letter-spacing:-0.02em;margin-top:6px;color:${INK};"><strong>PTD</strong><span style="color:${VERMILION};">.</span></div>
</td></tr>
<tr><td style="padding:26px 28px 28px 28px;">${body}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

const para = (html: string): string => `<p style="margin:0 0 14px 0;font-family:${SERIF};font-size:16px;line-height:1.6;color:${INK};">${html}</p>`;
const small = (html: string): string => `<p style="margin:0 0 14px 0;font-family:${SERIF};font-size:14px;line-height:1.6;color:${MUTED};">${html}</p>`;

/**
 * The code letter names the reference and nothing else about the invoice.
 *
 * A subject line is the least private thing in an inbox — it shows on a lock
 * screen and in a notification — so it carries a reference and a code, never a
 * client, a contractor or an amount.
 */
export function accessCodeLetter(input: { code: string; reference: string; verifyUrl: string }): Letter {
  const pretty = formatCode(input.code);
  return {
    subject: `Your PTD invoice access code: ${pretty}`,
    text: [
      `Your PTD invoice access code: ${pretty}`,
      "",
      `It is valid for 10 minutes and opens the details of invoice ${input.reference} on the verification page:`,
      input.verifyUrl,
      "",
      "If you did not ask for this code, nothing has happened and you can ignore this letter — the details stay closed.",
    ].join("\n"),
    html: shell(
      `<div style="font-family:${MONO};font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${MUTED};margin:0 0 14px 0;">invoice access code</div>` +
        `<div style="font-family:${MONO};font-size:34px;letter-spacing:0.22em;color:${INK};margin:0 0 18px 0;">${escapeHtml(pretty)}</div>` +
        para(`Valid for 10 minutes. Type it into the verification page for invoice <strong>${escapeHtml(input.reference)}</strong> to see its details.`) +
        `<p style="margin:0 0 16px 0;font-family:${MONO};font-size:11px;line-height:1.5;word-break:break-all;color:${MUTED};">${escapeHtml(input.verifyUrl)}</p>` +
        small("If you did not ask for this code, nothing has happened and you can ignore this letter — the details stay closed.")
    ),
  };
}

/** The share letter: the link, who sent it, and how the details are opened. */
export function shareLetter(input: { reference: string; verifyUrl: string; sharedBy: string; orgName: string; message?: string }): Letter {
  const note = input.message?.trim() ? input.message.trim() : "";
  return {
    subject: `A certified invoice to verify: ${input.reference}`,
    text: [
      `${input.sharedBy} at ${input.orgName} has shared a certified PTD invoice with you.`,
      "",
      input.verifyUrl,
      "",
      "The link confirms the invoice is genuine and that the record behind it is intact. It shows no names, no figures and no line items to whoever opens it.",
      "To see the details, ask for an access code on that page: a six-digit code will be sent to this address, and it opens the invoice for half an hour.",
      ...(note ? ["", `— ${note}`] : []),
    ].join("\n"),
    html: shell(
      `<div style="font-family:${MONO};font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${MUTED};margin:0 0 14px 0;">certified invoice ${escapeHtml(
        input.reference
      )}</div>` +
        para(`<strong>${escapeHtml(input.sharedBy)}</strong> at ${escapeHtml(input.orgName)} has shared a certified PTD invoice with you.`) +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px 0;"><tr><td style="background:${INK};border:1px solid ${INK};">` +
        `<a href="${escapeHtml(input.verifyUrl)}" style="display:inline-block;padding:13px 22px;font-family:${MONO};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${PARCHMENT};text-decoration:none;">verify the invoice &rarr;</a>` +
        `</td></tr></table>` +
        `<p style="margin:0 0 16px 0;font-family:${MONO};font-size:11px;line-height:1.5;word-break:break-all;color:${MUTED};">${escapeHtml(input.verifyUrl)}</p>` +
        para(
          "The link confirms the invoice is genuine and that the record behind it is intact. It shows no names, no figures and no line items to whoever opens it."
        ) +
        small(
          "To see the details, ask for an access code on that page. A six-digit code is sent to this address and opens the invoice for half an hour."
        ) +
        (note ? small(`&mdash; ${escapeHtml(note)}`) : "")
    ),
  };
}

/* ── Requesting a code ───────────────────────────────────────────────── */

export interface RequestOutcome {
  message: string;
  /** Whether a letter left the building. Only ever reported in development. */
  sent?: boolean;
  /** The code itself, returned **only** when SMTP is unconfigured outside production. */
  code?: string;
}

const devDisclosure = (): boolean => process.env.NODE_ENV !== "production" && !isEmailConfigured();

/**
 * Ask for a code.
 *
 * Every path answers `NEUTRAL_REQUEST_MESSAGE`: an unknown token, an address
 * nobody named, an address on the allowlist. The only difference a caller can see
 * is in development with no SMTP configured, where the code comes back in the
 * response because there is nowhere else for it to go.
 */
export async function requestAccessCode(args: { token: string; email: string; ip?: string | null }): Promise<RequestOutcome> {
  const neutral: RequestOutcome = { message: NEUTRAL_REQUEST_MESSAGE };
  const row = await invoiceByVerifyToken(args.token);
  if (!row) return neutral;

  const hash = recipientHash(row.verifyToken, args.email);
  const where = { orgId: row.orgId, userId: null, label: "invoice verification page", ip: args.ip ?? null };
  const eligibility = await eligibilityOf(row, args.email);
  if (eligibility === "none") {
    // Recorded, because a stream of refusals against one invoice is exactly the
    // thing an organization should be able to see. The address is not recorded.
    audit(where, "invoice.access_denied", row.reference, { recipient: hash, reason: "not_a_recipient" });
    return neutral;
  }

  const code = mintCode();
  const now = new Date();
  const access = accessOf(row.snapshot);
  const entry: AccessCode = {
    hash,
    codeHash: codeHashOf(row.verifyToken, code),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CODE_TTL_SECONDS * 1000).toISOString(),
    attempts: 0,
  };
  // One live code per recipient: asking again replaces the last one, so a code
  // read out of an older letter stops working the moment a newer one is sent.
  access.codes = [...access.codes.filter((c) => c.hash !== hash && new Date(c.expiresAt) > now), entry].slice(-MAX_LIVE_CODES);
  access.recipients = access.recipients.map((r) => (r.hash === hash ? { ...r, requests: (r.requests ?? 0) + 1 } : r));
  await writeAccess(row, access);

  const letter = accessCodeLetter({ code, reference: row.reference ?? "—", verifyUrl: verifyUrlFor(row.verifyToken) });
  const result = await sendLetter(normaliseEmail(args.email), letter);
  audit(where, "invoice.access_requested", row.reference, { recipient: hash, eligibility, mailed: result.sent });

  return devDisclosure() ? { ...neutral, sent: result.sent, code } : neutral;
}

/* ── Redeeming one ───────────────────────────────────────────────────── */

export type RedeemFailure = "invalid" | "locked";

export type RedeemResult =
  | { ok: true; row: InvoiceAccessRow; accessToken: string; expiresAt: string; recipient: string }
  | { ok: false; failure: RedeemFailure };

/**
 * Trade a code for a thirty-minute access token.
 *
 * A wrong code is counted against the code, not the address, so five wrong
 * guesses kill that code and the recipient has to ask for another — which is
 * itself rate-limited. An expired code is discarded on sight rather than left to
 * be guessed at, and every outcome answers the same two failure shapes so the
 * page cannot be used to learn whether an address is on the list.
 */
export async function redeemAccessCode(args: { token: string; email: string; code: string; ip?: string | null }): Promise<RedeemResult> {
  const row = await invoiceByVerifyToken(args.token);
  if (!row) return { ok: false, failure: "invalid" };

  const hash = recipientHash(row.verifyToken, args.email);
  const where = { orgId: row.orgId, userId: null, label: "invoice verification page", ip: args.ip ?? null };
  const access = accessOf(row.snapshot);
  const now = new Date();
  const entry = access.codes.find((c) => c.hash === hash);

  const deny = async (failure: RedeemFailure, next?: InvoiceAccess) => {
    if (next) await writeAccess(row, next);
    audit(where, "invoice.access_denied", row.reference, { recipient: hash, reason: failure === "locked" ? "too_many_attempts" : "bad_code" });
    return { ok: false as const, failure };
  };

  if (!entry) return deny("invalid");
  if (new Date(entry.expiresAt) <= now) {
    return deny("invalid", { ...access, codes: access.codes.filter((c) => c !== entry) });
  }
  if (entry.attempts >= MAX_CODE_ATTEMPTS) {
    return deny("locked", { ...access, codes: access.codes.filter((c) => c !== entry) });
  }
  // The letter prints "123 456", so a recipient types a space — and a copy out of
  // a mail client may bring a non-breaking one. Strip all whitespace, then compare.
  const typed = String(args.code ?? "").replace(/\s+/gu, "");
  if (!sameHash(entry.codeHash, codeHashOf(row.verifyToken, typed))) {
    const attempts = entry.attempts + 1;
    const exhausted = attempts >= MAX_CODE_ATTEMPTS;
    return deny(exhausted ? "locked" : "invalid", {
      ...access,
      codes: exhausted ? access.codes.filter((c) => c !== entry) : access.codes.map((c) => (c === entry ? { ...c, attempts } : c)),
    });
  }

  // Spent. The code is removed rather than marked used: a one-time code that is
  // still in the row is a one-time code somebody can try again.
  await writeAccess(row, {
    ...access,
    codes: access.codes.filter((c) => c !== entry),
    recipients: access.recipients.map((r) => (r.hash === hash ? { ...r, grants: (r.grants ?? 0) + 1 } : r)),
  });
  audit(where, "invoice.access_granted", row.reference, { recipient: hash });

  const { token: accessToken, expiresAt } = signAccessToken(row.verifyToken, hash);
  return { ok: true, row, accessToken, expiresAt, recipient: hash };
}

/* ── The access token ────────────────────────────────────────────────── */

export interface AccessClaims {
  purpose: typeof ACCESS_PURPOSE;
  /** sha-256 of the verification token this was issued for. Binds it to one invoice. */
  inv: string;
  /** The recipient's hash, so a grant can be traced without an address. */
  sub: string;
}

export function signAccessToken(verifyToken: string, recipient: string): { token: string; expiresAt: string } {
  if (!JWT_SECRET) throw new Error("JWT_SECRET must be set in production");
  const token = jwt.sign({ purpose: ACCESS_PURPOSE, inv: sha256Hex(verifyToken), sub: recipient } satisfies AccessClaims, JWT_SECRET, {
    expiresIn: ACCESS_TTL_SECONDS,
  });
  return { token, expiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000).toISOString() };
}

/**
 * Null rather than a throw, and null for every reason: expired, forged, minted
 * for a different invoice, or a session token someone tried to reuse here.
 */
export function verifyAccessToken(bearer: string, verifyToken: string): { recipient: string } | null {
  if (!bearer || !JWT_SECRET) return null;
  try {
    const claims = jwt.verify(bearer.replace(/^Bearer\s+/i, "").trim(), JWT_SECRET) as Partial<AccessClaims>;
    if (claims.purpose !== ACCESS_PURPOSE || typeof claims.sub !== "string" || typeof claims.inv !== "string") return null;
    if (!sameHash(claims.inv, sha256Hex(verifyToken))) return null;
    return { recipient: claims.sub };
  } catch {
    return null;
  }
}

/* ── Sharing ─────────────────────────────────────────────────────────── */

/** What a manager reads back: a mask, when it was added, and how it has been used. */
export interface RecipientView {
  mask: string;
  addedAt: string;
  via: "issue" | "share";
  requests: number;
  grants: number;
}

const view = (r: AccessRecipient): RecipientView => ({
  mask: r.mask,
  addedAt: r.addedAt,
  via: r.via,
  requests: r.requests ?? 0,
  grants: r.grants ?? 0,
});

export const recipientsOf = (row: InvoiceAccessRow): RecipientView[] =>
  accessOf(row.snapshot)
    .recipients.slice()
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt))
    .map(view);

export interface ShareOutcome {
  /** Masked, in the order they were given. */
  shared: { mask: string; mailed: boolean; reason?: string; added: boolean }[];
  recipients: RecipientView[];
}

/**
 * Add addresses to the allowlist and write to them.
 *
 * Sharing an address that is already on the list is not an error and not a
 * duplicate: it re-sends the letter and leaves the counters alone. That is also
 * the only "resend" there can be, since the address was never stored.
 */
export async function shareInvoice(args: {
  row: InvoiceAccessRow;
  emails: string[];
  message?: string;
  sharedBy: string;
  sharedByUserId: number;
  orgName: string;
}): Promise<ShareOutcome> {
  const access = accessOf(args.row.snapshot);
  const at = new Date().toISOString();
  const verifyUrl = verifyUrlFor(args.row.verifyToken);
  const shared: ShareOutcome["shared"] = [];
  const seen = new Set<string>();

  for (const raw of args.emails) {
    const email = normaliseEmail(raw);
    const hash = recipientHash(args.row.verifyToken, email);
    if (seen.has(hash)) continue;
    seen.add(hash);

    const existing = access.recipients.find((r) => r.hash === hash);
    if (!existing) {
      if (access.recipients.length >= MAX_RECIPIENTS) {
        shared.push({ mask: maskEmail(email), mailed: false, reason: "too_many_recipients", added: false });
        continue;
      }
      access.recipients.push({ hash, mask: maskEmail(email), addedAt: at, addedBy: args.sharedByUserId, via: "share", requests: 0, grants: 0 });
    }
    const result = await sendLetter(email, shareLetter({
      reference: args.row.reference ?? "—",
      verifyUrl,
      sharedBy: args.sharedBy,
      orgName: args.orgName,
      message: args.message,
    }));
    shared.push({ mask: maskEmail(email), mailed: result.sent, ...(result.sent ? {} : { reason: result.reason }), added: !existing });
  }

  await writeAccess(args.row, access);
  return { shared, recipients: recipientsOf(args.row) };
}

/** Take an address off the list. Answers whether it was there, never who else is. */
export async function unshareInvoice(args: { row: InvoiceAccessRow; email: string }): Promise<{ removed: boolean; mask: string; recipients: RecipientView[] }> {
  const access = accessOf(args.row.snapshot);
  const hash = recipientHash(args.row.verifyToken, args.email);
  const kept = access.recipients.filter((r) => r.hash !== hash);
  const removed = kept.length !== access.recipients.length;
  if (removed) {
    // Their outstanding code goes with them: revoking access that a code in an
    // inbox can still open is not revoking anything.
    await writeAccess(args.row, { ...access, recipients: kept, codes: access.codes.filter((c) => c.hash !== hash) });
  }
  return { removed, mask: maskEmail(args.email), recipients: recipientsOf(args.row) };
}
