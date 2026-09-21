/**
 * What a certified invoice is, and what makes it checkable.
 *
 * An invoice PTD issues for an external contractor is a claim about the world:
 * "these hours were produced inside this system, by this person, against these
 * tasks". The claim is only worth something if a third party — the client, an
 * accountant, a court — can check it without an account here. So generating one
 * freezes a **snapshot**: every entry that went into it, with its times, its
 * attribution and a hash of its immutable columns. The snapshot is serialised
 * canonically, hashed, and the hash is signed with the deployment's Ed25519 key.
 *
 * That gives three independent checks at verification time:
 *
 *  1. `contentHashMatches` — re-serialise the stored snapshot, re-hash it. Fails
 *     if the snapshot itself was edited in the database.
 *  2. `signatureValid` — verify the signature against the published public key.
 *     Fails if the snapshot *and* its hash were rewritten by someone without the
 *     private key.
 *  3. `entriesUnchanged` — re-hash the live ledger rows. Fails, naming the rows,
 *     if a time entry was altered after the invoice was issued.
 *
 * Nothing private travels in a snapshot: no notes, no email addresses. A line is
 * a date, a duration, what it was booked against and who (or what) produced it.
 *
 * One block in here is **not** part of what was signed: `access`, the list of
 * named recipients and the one-time codes that release the invoice's details. It
 * lives in the same jsonb column because `invoices` has nowhere else to put it
 * and the schema is frozen, and it is stripped before hashing (see `signedPart`)
 * so sharing an invoice cannot move the hash printed on a PDF already in the
 * post.
 */

import { createHash } from "crypto";

export const SNAPSHOT_VERSION = 1 as const;

export type InvoiceKind = "contractor" | "customer";

/** What the "Certified by PTD" block on a rendered document prints. */
export interface Certification {
  reference: string;
  contentHash: string;
  keyId: number;
  algorithm: string;
  verifyUrl: string;
  issuedAt: string;
  voided: boolean;
}

/** One ledger entry, frozen. */
export interface SnapshotLine {
  entryId: number;
  checkIn: string;
  checkOut: string;
  minutes: number;
  taskId: number | null;
  taskKey: string | null;
  taskTitle: string | null;
  streamId: number | null;
  streamName: string | null;
  entrySource: string;
  tokensUsed: number | null;
  apiCostUsd: number | null;
  approvalStatus: string;
  /** sha256 of the entry's immutable columns — see `entrySha256`. */
  entrySha256: string;
  /** Customer invoices price per line, because a stream may override the rate. */
  rate?: number | null;
  amountCents?: number | null;
}

export interface SnapshotTotals {
  minutes: number;
  amountCents: number | null;
  humanMinutes: number;
  agentMinutes: number;
  tokens: number;
  costUsd: number;
}

export interface InvoiceSnapshot {
  version: typeof SNAPSHOT_VERSION;
  kind: InvoiceKind;
  org: { id: number; name: string };
  contractor?: { userId: number; name: string; billingName: string | null; taxId: string | null };
  customer?: { id: number; name: string; billingAddress: string | null; billingEmail: string | null };
  period: { month: number; year: number; label: string; from: string; to: string };
  currency: string;
  rate: number | null;
  lines: SnapshotLine[];
  totals: SnapshotTotals;
  issuedAt: string;
  reference: string;
  /** Who may read the details, and the outstanding codes. Never signed — see `signedPart`. */
  access?: InvoiceAccess;
}

/* ── Access: who the details are released to ─────────────────────────── */

export const ACCESS_VERSION = 1 as const;

/**
 * One named recipient of an invoice.
 *
 * The address itself is never written. `hash` is sha-256 over the invoice's own
 * verification token and the normalised address, so the same person on two
 * invoices produces two unrelated hashes and this column cannot be mined for a
 * mailing list. `mask` is what a manager reads back — enough to recognise an
 * address they typed, not enough to be one.
 */
export interface AccessRecipient {
  hash: string;
  mask: string;
  addedAt: string;
  /** Who shared it; null when PTD allowlisted it automatically at issue. */
  addedBy: number | null;
  via: "issue" | "share";
  /** How many codes this recipient has asked for, and how many opened the details. */
  requests?: number;
  grants?: number;
}

/** One outstanding code. The code itself exists only in the letter that carried it. */
export interface AccessCode {
  /** Whose request this answers — the recipient's `hash`. */
  hash: string;
  /** sha-256 of the code and the invoice's verification token. */
  codeHash: string;
  issuedAt: string;
  expiresAt: string;
  attempts: number;
}

export interface InvoiceAccess {
  version: typeof ACCESS_VERSION;
  recipients: AccessRecipient[];
  codes: AccessCode[];
}

export const emptyAccess = (): InvoiceAccess => ({ version: ACCESS_VERSION, recipients: [], codes: [] });

/* ── Canonical serialisation ─────────────────────────────────────────── */

/**
 * JSON with object keys in sorted order and no incidental whitespace.
 *
 * A hash is only reproducible if the bytes are. `JSON.stringify` preserves
 * insertion order, which means the same snapshot read back through a driver that
 * hands columns over in a different order would hash differently — so keys are
 * sorted at every depth, arrays keep their order (a ledger is ordered), `undefined`
 * members are dropped, and Dates are rendered as ISO-8601.
 */
export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): string => {
    if (node === null) return "null";
    if (node instanceof Date) return JSON.stringify(node.toISOString());
    const t = typeof node;
    if (t === "number") return Number.isFinite(node as number) ? JSON.stringify(node) : "null";
    if (t === "boolean" || t === "string") return JSON.stringify(node);
    if (t === "undefined" || t === "function") return "null";
    if (Array.isArray(node)) return `[${node.map(walk).join(",")}]`;
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined && typeof obj[k] !== "function")
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(obj[k])}`).join(",")}}`;
  };
  return walk(value);
}

export const sha256Hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

/**
 * What the content hash is taken over: the whole snapshot except its access block.
 *
 * Sharing an invoice, requesting a code and redeeming one all write into
 * `access`, and none of them may move the hash — a copy of the PDF prints it, and
 * a verifier re-derives it. `canonicalJson` drops `undefined` and this drops the
 * key outright, so a snapshot that has never been shared hashes byte-for-byte as
 * it did before the field existed: every invoice issued earlier goes on verifying.
 */
export function signedPart(snapshot: InvoiceSnapshot): Omit<InvoiceSnapshot, "access"> {
  const { access: _unsigned, ...signed } = snapshot;
  return signed;
}

/** The digest that gets signed. */
export const contentHashOf = (snapshot: InvoiceSnapshot): string => sha256Hex(canonicalJson(signedPart(snapshot)));

/** First twelve hex digits, grouped — what a human reads off a printed page. */
export const shortHash = (hash: string): string => `${hash.slice(0, 4)} ${hash.slice(4, 8)} ${hash.slice(8, 12)}`.toUpperCase();

/* ── Per-entry hashes ────────────────────────────────────────────────── */

/**
 * The columns of a time entry that an invoice's truthfulness rests on: who, when,
 * how long, against what, and by human or machine. The note is deliberately out —
 * it is prose a member may fix afterwards, it is private, and rewording it does
 * not change an hour that was worked.
 */
export interface HashableEntry {
  id: number;
  userId: number;
  checkIn: Date | string;
  checkOut: Date | string | null;
  isBreak: boolean;
  taskId: number | null;
  streamId: number | null;
  customerId: number | null;
  entrySource: string | null;
  tokensUsed: number | null;
  apiCostUsd: number | null;
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

export function entrySha256(entry: HashableEntry): string {
  return sha256Hex(
    canonicalJson({
      id: entry.id,
      userId: entry.userId,
      checkIn: iso(entry.checkIn),
      checkOut: iso(entry.checkOut),
      isBreak: entry.isBreak,
      taskId: entry.taskId,
      streamId: entry.streamId,
      customerId: entry.customerId,
      entrySource: entry.entrySource ?? "human",
      // float4 round-trips as 0.03999999910593033; four decimals is past a tenth
      // of a cent and is what every other surface prints, so hash that instead.
      tokensUsed: entry.tokensUsed ?? null,
      apiCostUsd: entry.apiCostUsd === null || entry.apiCostUsd === undefined ? null : Math.round(entry.apiCostUsd * 10_000) / 10_000,
    })
  );
}

/** Minutes of a closed entry, the same rounding the rest of Track uses. */
export function lineMinutes(checkIn: Date | string, checkOut: Date | string): number {
  const seconds = (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 1000;
  return Math.max(0, Math.round(seconds / 60));
}

/** Money from minutes: one rounding, at the end, so many short lines do not drift. */
export function amountCentsFor(minutes: number, rate: number | null): number | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return Math.round((minutes / 60) * rate * 100);
}
