/**
 * The public verification page — the reason certified invoices exist.
 *
 * Someone is holding a PDF. They are not a member of this organization, they have
 * no account here, and they want to know two things: is this document real, and
 * are the hours on it the hours that were actually recorded. The page answers the
 * first in its first line, to anybody. The second it answers only to the people
 * the invoice was actually sent to.
 *
 * Four deliberate choices:
 *
 *  - **The verdict is the page.** A visitor should be able to stop reading after
 *    the first heading. Everything below is the evidence for people who want it.
 *  - **The bare link discloses nothing.** No organization, no contractor or
 *    customer, no period, no rate, no total, no lines. A verification link is
 *    printed on a document that gets forwarded, filed and attached to other mail;
 *    it has to prove authenticity without telling a stranger who is billing whom
 *    for how much.
 *  - **The details are earned, not requested.** An address that was named as a
 *    recipient asks for a six-digit code, it arrives in that inbox, and typing it
 *    back opens the invoice for half an hour. Asking about an address that was
 *    never named gets the same answer as asking about one that was.
 *  - **It is outside the application shell.** No navigation, no sign-in prompt, no
 *    hint that there is a product behind it to buy. A verifier is not a lead.
 */

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, KeyRound, Loader2, Lock, Mail, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface VerifyLine {
  date: string;
  minutes: number;
  taskKey: string | null;
  taskTitle: string | null;
  streamName: string | null;
  entrySource: string;
}

/** What the bare link answers: the proof, and none of the particulars. */
interface PublicVerifyResponse {
  valid: boolean;
  reason?: string;
  reasons?: string[];
  invoice?: {
    reference: string;
    kind: string;
    issuedAt: string;
    voided: boolean;
  };
  integrity?: {
    contentHashMatches: boolean;
    signatureValid: boolean;
    entriesUnchanged: boolean;
    keyId: number | null;
  };
  detailsAvailable?: boolean;
}

/** What a redeemed code adds: everything the old public endpoint used to say. */
interface DetailResponse {
  valid: boolean;
  reason?: string;
  reasons?: string[];
  invoice?: {
    reference: string;
    kind: string;
    org: string;
    contractorOrCustomer: string;
    period: { month: number; year: number; label: string };
    currency: string;
    rate: number | null;
    totals: { minutes: number; hours: number; amountCents: number | null };
    issuedAt: string;
    voided: boolean;
    voidedAt: string | null;
  };
  integrity?: {
    contentHashMatches: boolean;
    signatureValid: boolean;
    keyId: number | null;
    algorithm: string | null;
    publicKeyUrl: string;
    contentHash: string;
    entriesUnchanged: boolean;
    changedEntryIds: number[];
    missingEntryIds: number[];
    entriesChecked: number;
  };
  lines?: VerifyLine[];
  access?: { token: string; expiresAt: string; ttlSeconds: number };
}

const PUBLIC_KEY_URL = "/.well-known/ptd-signing-key.json";

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" };

function money(cents: number | null, currency: string): string {
  if (cents === null) return "—";
  const amount = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = SYMBOLS[currency?.toUpperCase() ?? ""];
  return symbol ? `${symbol}${amount}` : `${amount} ${currency.toUpperCase()}`;
}

const hm = (minutes: number): string => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

const longDate = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

/* ── The three calls ─────────────────────────────────────────────────── */

/** The verification endpoint is public, so this is a bare fetch: no token, no org header. */
async function verify(token: string): Promise<PublicVerifyResponse> {
  const res = await fetch(`/api/verify/${encodeURIComponent(token)}`, { headers: { Accept: "application/json" } });
  if (res.status === 429) throw new Error("Too many checks from this address just now. Wait a minute and reload.");
  return (await res.json()) as PublicVerifyResponse;
}

async function requestCode(token: string, email: string): Promise<{ message: string; code?: string; sent?: boolean }> {
  const res = await fetch(`/api/verify/${encodeURIComponent(token)}/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = (await res.json()) as { message?: string; code?: string; sent?: boolean; error?: string };
  if (!res.ok) throw new Error(body.message ?? "The code could not be requested.");
  return { message: body.message ?? "", code: body.code, sent: body.sent };
}

async function redeem(token: string, email: string, code: string): Promise<DetailResponse> {
  const res = await fetch(`/api/verify/${encodeURIComponent(token)}/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, code }),
  });
  const body = (await res.json()) as DetailResponse & { message?: string };
  if (!res.ok) throw new Error(body.message ?? "That code was refused.");
  return body;
}

async function details(token: string, access: string): Promise<DetailResponse | null> {
  const res = await fetch(`/api/verify/${encodeURIComponent(token)}/details`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${access}` },
  });
  if (res.status === 401) return null;
  if (!res.ok) return null;
  return (await res.json()) as DetailResponse;
}

/**
 * The access token is kept for the tab and nothing longer.
 *
 * `sessionStorage`, keyed on the verification token, so a reload does not ask for
 * a second code and closing the tab ends the access. It is per-origin and per-tab,
 * which is the right lifetime for a half-hour grant read by one person at a desk.
 */
const accessKey = (token: string) => `ptd.invoice.access.${token}`;

function readAccess(token: string): string | null {
  try {
    return window.sessionStorage.getItem(accessKey(token));
  } catch {
    return null;
  }
}

function writeAccess(token: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(accessKey(token));
    else window.sessionStorage.setItem(accessKey(token), value);
  } catch {
    /* Private windows and blocked site data: the page works, it just asks again. */
  }
}

/* ── The page ────────────────────────────────────────────────────────── */

export default function Verify() {
  const { token = "" } = useParams<{ token: string }>();
  const [copied, setCopied] = useState(false);
  const [detail, setDetail] = useState<DetailResponse | null>(null);

  const q = useQuery({ queryKey: ["verify", token], queryFn: () => verify(token), retry: false });

  // A tab that already redeemed a code shows the details straight away. A stale or
  // expired grant simply falls back to the anonymous page.
  useEffect(() => {
    const stored = readAccess(token);
    if (!stored || detail) return;
    let live = true;
    void details(token, stored).then((found) => {
      if (!live) return;
      if (found?.invoice) setDetail(found);
      else writeAccess(token, null);
    });
    return () => {
      live = false;
    };
  }, [token, detail]);

  const data = q.data;
  const ok = data?.valid === true;
  const known = Boolean(data?.invoice);
  const shown = detail?.invoice ?? null;

  return (
    <div className="min-h-screen w-full bg-parchment text-ink">
      <div className="mx-auto max-w-3xl px-5 sm:px-8 py-10 sm:py-16">
        <header className="mb-8 sm:mb-10">
          <div className="eyebrow">
            <span className="text-vermilion">Plan Track Done</span> · invoice verification
          </div>
          <div className="mt-2 border-b border-ink pb-1" />
        </header>

        {q.isLoading ? (
          <div className="paper p-10 text-center">
            <Loader2 className="h-5 w-5 animate-spin mx-auto text-ink-muted" />
            <p className="eyebrow text-[9px] mt-3">Checking the record…</p>
          </div>
        ) : q.isError ? (
          <div className="paper p-8">
            <h1 className="font-display text-3xl">Could not check</h1>
            <p className="font-serif mt-2 text-ink-muted">{(q.error as Error).message}</p>
          </div>
        ) : (
          <>
            {/* The verdict */}
            <section
              className={cn("paper p-6 sm:p-8 border-2", ok ? "border-sage/70" : "border-vermilion/70")}
              data-testid="verify-verdict"
              data-valid={String(ok)}
            >
              <div className="flex items-start gap-4">
                {ok ? (
                  <ShieldCheck className="h-10 w-10 sm:h-12 sm:w-12 text-sage shrink-0" strokeWidth={1.5} aria-hidden />
                ) : (
                  <ShieldAlert className="h-10 w-10 sm:h-12 sm:w-12 text-vermilion shrink-0" strokeWidth={1.5} aria-hidden />
                )}
                <div className="min-w-0">
                  <h1 className={cn("font-display text-3xl sm:text-5xl tracking-tight leading-none", ok ? "text-ink" : "text-vermilion")}>
                    {ok ? "Verified" : "Not verified"}
                  </h1>
                  <p className="font-serif text-base sm:text-lg mt-3 text-ink-muted" data-testid="verify-statement">
                    {ok && data?.invoice ? (
                      <>
                        This is a genuine PTD certified invoice{" "}
                        <span className="text-ink font-numeric tabular-nums">{data.invoice.reference}</span>, issued{" "}
                        <span className="text-ink">{longDate(data.invoice.issuedAt)}</span>. Integrity: verified.
                        {shown ? null : " To see the invoice details, request an access code below."}
                      </>
                    ) : known ? (
                      "This document does not check out. The reasons are below."
                    ) : (
                      data?.reason ?? "No invoice carries that verification token."
                    )}
                  </p>
                  {!ok && (data?.reasons?.length ?? 0) > 0 ? (
                    <ul className="mt-4 space-y-1.5" data-testid="verify-reasons">
                      {data!.reasons!.map((r) => (
                        <li key={r} className="font-serif text-sm flex gap-2">
                          <X className="h-4 w-4 text-vermilion shrink-0 mt-0.5" strokeWidth={2.5} aria-hidden />
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </section>

            {data?.invoice ? (
              <>
                {/* What the document is — the anonymous half, always shown */}
                <section className="paper mt-6 overflow-hidden" data-testid="verify-invoice">
                  <div className="px-4 py-3 flex items-center justify-between border-b border-rule">
                    <span className="eyebrow">The document</span>
                    <span className="section-num">i.</span>
                  </div>
                  <dl className="grid grid-cols-2 sm:grid-cols-3 divide-x divide-y sm:divide-y-0 divide-rule">
                    <Field label="Reference" value={data.invoice.reference} mono />
                    <Field label="Kind" value={data.invoice.kind === "contractor" ? "Contractor invoice" : "Customer invoice"} />
                    <Field label="Issued" value={longDate(data.invoice.issuedAt)} />
                  </dl>
                  {shown ? (
                    <dl
                      className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-rule border-t border-rule"
                      data-testid="verify-particulars"
                    >
                      <Field label="Issued by" value={shown.org} />
                      <Field label={shown.kind === "contractor" ? "Contractor" : "Customer"} value={shown.contractorOrCustomer || "—"} />
                      <Field label="Period" value={shown.period.label} />
                      <Field label="Amount" value={money(shown.totals.amountCents, shown.currency)} mono accent />
                    </dl>
                  ) : null}
                  {data.invoice.voided ? (
                    <p className="px-4 py-3 border-t border-rule font-serif text-sm text-vermilion" data-testid="verify-voided">
                      Withdrawn by the issuer
                      {detail?.invoice?.voidedAt ? ` on ${longDate(detail.invoice.voidedAt)}` : ""}. The record itself is intact — it simply no
                      longer stands as a claim for payment.
                    </p>
                  ) : null}
                </section>

                {/* How it was checked */}
                {data.integrity ? (
                  <section className="paper mt-6 overflow-hidden" data-testid="verify-integrity">
                    <div className="px-4 py-3 flex items-center justify-between border-b border-rule">
                      <span className="eyebrow">How this was checked</span>
                      <span className="section-num">ii.</span>
                    </div>
                    <ul className="divide-y divide-rule">
                      <CheckRow
                        ok={data.integrity.contentHashMatches}
                        title="The frozen record hashes to its recorded value"
                        detail={detail?.integrity ? `sha-256 · ${detail.integrity.contentHash}` : "sha-256 over the canonical record"}
                      />
                      <CheckRow
                        ok={data.integrity.signatureValid}
                        title="The signature verifies against this deployment's published key"
                        detail={`${detail?.integrity?.algorithm ?? "ed25519"} · key #${data.integrity.keyId ?? "?"}`}
                      />
                      <CheckRow
                        ok={data.integrity.entriesUnchanged}
                        title={
                          detail?.integrity
                            ? `All ${detail.integrity.entriesChecked} time ${detail.integrity.entriesChecked === 1 ? "entry is" : "entries are"} unchanged in the ledger`
                            : "Every time entry behind it is unchanged in the ledger"
                        }
                        detail={
                          data.integrity.entriesUnchanged
                            ? "Each entry's times, attribution and attachments re-hash to the values frozen at issue"
                            : detail?.integrity
                              ? [
                                  detail.integrity.changedEntryIds.length ? `altered: ${detail.integrity.changedEntryIds.join(", ")}` : "",
                                  detail.integrity.missingEntryIds.length ? `deleted: ${detail.integrity.missingEntryIds.join(", ")}` : "",
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : "At least one entry no longer re-hashes to the value frozen at issue"
                        }
                      />
                    </ul>
                    <div className="px-4 py-3 border-t border-rule flex flex-wrap items-center gap-4">
                      <a
                        href={detail?.integrity?.publicKeyUrl ?? PUBLIC_KEY_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="eyebrow text-[9px] inline-flex items-center gap-1.5 hover:text-vermilion focus-ink"
                        data-testid="verify-key-link"
                      >
                        the public key <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                      <button
                        onClick={() => {
                          void navigator.clipboard?.writeText(JSON.stringify(detail ?? data, null, 2));
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1800);
                        }}
                        className="eyebrow text-[9px] inline-flex items-center gap-1.5 hover:text-vermilion focus-ink"
                        data-testid="verify-copy-json"
                      >
                        {copied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />} {copied ? "copied" : "copy this answer as JSON"}
                      </button>
                    </div>
                  </section>
                ) : null}

                {/* The details — locked, then open */}
                {shown && detail ? (
                  <Details detail={detail} onForget={() => {
                    writeAccess(token, null);
                    setDetail(null);
                  }} />
                ) : (
                  <AccessGate
                    token={token}
                    onOpen={(payload) => {
                      if (payload.access?.token) writeAccess(token, payload.access.token);
                      setDetail(payload);
                    }}
                  />
                )}
              </>
            ) : null}

            <footer className="mt-8 pt-4 border-t border-rule">
              <p className="font-display italic text-sm text-ink-muted">
                Hours on a PTD invoice are recorded as the work happens — by a person at a timer or by an agent over the API — and
                frozen into a signed record when the invoice is issued. That is what this page checks. Proof of work, not proof of presence.
              </p>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Asking for a code, then typing it in ────────────────────────────── */

function AccessGate({ token, onOpen }: { token: string; onOpen: (payload: DetailResponse) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: () => requestCode(token, email.trim()),
    onSuccess: (r) => {
      setError(null);
      setNotice(r.message);
      setDevCode(r.code ?? null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const open = useMutation({
    mutationFn: () => redeem(token, email.trim(), code.replace(/\s+/g, "")),
    onSuccess: (r) => {
      setError(null);
      onOpen(r);
    },
    onError: (e: Error) => setError(e.message),
  });

  const asked = ask.isSuccess;

  return (
    <section className="paper mt-6 overflow-hidden" data-testid="verify-access-gate">
      <div className="px-4 py-3 flex items-center justify-between border-b border-rule">
        <span className="eyebrow">The invoice details</span>
        <span className="section-num">iii.</span>
      </div>
      <div className="px-4 py-5 sm:px-6">
        <div className="flex items-start gap-3">
          <Lock className="h-5 w-5 text-ink-muted shrink-0 mt-0.5" strokeWidth={1.6} aria-hidden />
          <div className="min-w-0">
            <p className="font-serif text-base">
              Who this invoice is from, who it is for, the period it covers, the amount and the hours behind it are released only to the
              people it was sent to.
            </p>
            <p className="font-serif text-[13px] text-ink-muted mt-1.5">
              Enter the address the invoice was sent to and we will email it a six-digit code, good for ten minutes. Nothing on this page
              says whether an address is on the list.
            </p>
          </div>
        </div>

        <form
          className="mt-4 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) ask.mutate();
          }}
        >
          <label className="block flex-1 min-w-[220px]">
            <span className="eyebrow text-[9px]">your email address</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="accounts@your-company.example"
              className="draft-input w-full mt-1 text-sm focus-ink"
              data-testid="verify-email-input"
            />
          </label>
          <button
            type="submit"
            disabled={ask.isPending || !email.trim()}
            className="h-10 px-3 rounded-sm border border-ink/30 inline-flex items-center gap-2 font-display uppercase tracking-tight text-sm focus-ink disabled:opacity-50"
            data-testid="verify-request-code"
          >
            {ask.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
            {asked ? "Send another code" : "Request a code"}
          </button>
        </form>

        {notice ? (
          <p className="font-serif text-sm mt-3 text-ink" data-testid="verify-request-notice">
            {notice}
          </p>
        ) : null}
        {devCode ? (
          <p className="font-mono text-[11px] mt-1.5 text-vermilion" data-testid="verify-dev-code">
            No SMTP is configured on this deployment, so the code is {devCode} — this only ever happens outside production.
          </p>
        ) : null}

        {asked ? (
          <form
            className="mt-4 pt-4 border-t border-rule flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) open.mutate();
            }}
          >
            <label className="block">
              <span className="eyebrow text-[9px]">the six-digit code</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, "").slice(0, 7))}
                placeholder="123 456"
                className="draft-input mt-1 w-[150px] font-mono tracking-[0.3em] text-sm focus-ink"
                data-testid="verify-code-input"
              />
            </label>
            <button
              type="submit"
              disabled={open.isPending || code.replace(/\D/g, "").length < 6}
              className="h-10 px-3 rounded-sm bg-ink text-parchment hover:bg-vermilion inline-flex items-center gap-2 font-display uppercase tracking-tight text-sm focus-ink disabled:opacity-50"
              data-testid="verify-redeem-code"
            >
              {open.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />} Show the details
            </button>
          </form>
        ) : null}

        {error ? (
          <p className="font-serif text-sm mt-3 text-vermilion" data-testid="verify-access-error">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/* ── The details, once they are open ─────────────────────────────────── */

function Details({ detail, onForget }: { detail: DetailResponse; onForget: () => void }) {
  const invoice = detail.invoice!;
  return (
    <>
      <section className="paper mt-6 overflow-hidden" data-testid="verify-details">
        <div className="px-4 py-3 flex items-center justify-between border-b border-rule">
          <span className="eyebrow">What the document says</span>
          <span className="section-num">iii.</span>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-rule">
          <Field label="Billed to" value={invoice.org} />
          <Field label="Recorded" value={hm(invoice.totals.minutes)} mono />
          <Field label="Hours" value={invoice.totals.hours.toFixed(2)} mono />
          <Field label="Amount" value={money(invoice.totals.amountCents, invoice.currency)} mono accent />
        </dl>
        <div className="px-4 py-3 border-t border-rule flex flex-wrap items-center justify-between gap-3">
          <span className="eyebrow text-[9px]">
            open for this tab{detail.access ? ` · until ${new Date(detail.access.expiresAt).toLocaleTimeString()}` : ""}
          </span>
          <button onClick={onForget} className="eyebrow text-[9px] hover:text-vermilion focus-ink" data-testid="verify-close-details">
            close the details
          </button>
        </div>
      </section>

      {detail.lines?.length ? (
        <section className="paper mt-6 overflow-hidden" data-testid="verify-lines">
          <div className="px-4 py-3 flex items-center justify-between border-b border-rule">
            <span className="eyebrow">The hours on this invoice</span>
            <span className="section-num">iv.</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[460px] border-collapse">
              <thead>
                <tr className="border-b border-rule">
                  {["Date", "Stream · task", "By", "Duration"].map((h, i) => (
                    <th key={h} scope="col" className={cn("eyebrow text-[9px] py-2 px-4", i < 3 ? "text-left" : "text-right")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {detail.lines.map((l, i) => (
                  <tr key={`${l.date}-${i}`}>
                    <td className="ledger-cell px-4 py-2 whitespace-nowrap">{l.date}</td>
                    <td className="px-4 py-2">
                      <span className="font-display text-sm">
                        {l.taskKey ? `${l.taskKey} ` : ""}
                        {l.taskTitle ?? l.streamName ?? "—"}
                      </span>
                      {l.taskTitle && l.streamName ? <span className="eyebrow text-[9px] block">{l.streamName}</span> : null}
                    </td>
                    <td className={cn("px-4 py-2 text-[10px] uppercase tracking-wide", l.entrySource === "agent" ? "text-vermilion" : "text-ink-muted")}>
                      {l.entrySource}
                    </td>
                    <td className="ledger-cell px-4 py-2 text-right tabular-nums">{hm(l.minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 border-t border-rule font-serif text-[13px] text-ink-muted">
            Only dates, durations and what the work was booked against are shown. Session notes, email addresses and anything else
            private to the organization are never exposed here.
          </p>
        </section>
      ) : null}
    </>
  );
}

function Field({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: boolean }) {
  return (
    <div className="px-4 py-3">
      <dt className="eyebrow text-[9px]">{label}</dt>
      <dd className={cn("mt-1.5 text-sm break-words", mono ? "font-numeric tabular-nums" : "font-serif", accent && "text-vermilion")}>{value}</dd>
    </div>
  );
}

function CheckRow({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <li className="px-4 py-3 flex items-start gap-3">
      {ok ? (
        <Check className="h-4 w-4 text-sage shrink-0 mt-0.5" strokeWidth={3} aria-label="passed" />
      ) : (
        <X className="h-4 w-4 text-vermilion shrink-0 mt-0.5" strokeWidth={3} aria-label="failed" />
      )}
      <div className="min-w-0">
        <div className={cn("font-serif text-sm", !ok && "text-vermilion")}>{title}</div>
        <div className="font-mono text-[10px] text-ink-muted break-all mt-0.5">{detail}</div>
      </div>
    </li>
  );
}
