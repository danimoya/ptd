/**
 * The public verification page — the reason certified invoices exist.
 *
 * Someone is holding a PDF. They are not a member of this organization, they have
 * no account here, and they want to know two things: is this document real, and
 * are the hours on it the hours that were actually recorded. This page answers
 * both in the first line, and shows its working underneath.
 *
 * Three deliberate choices:
 *
 *  - **The verdict is the page.** A visitor should be able to stop reading after
 *    the first heading. Everything below is the evidence for people who want it.
 *  - **It is outside the application shell.** No navigation, no sign-in prompt, no
 *    hint that there is a product behind it to buy. A verifier is not a lead.
 *  - **It shows the checks separately.** "Not verified" is not one thing: a
 *    rewritten record, a bad signature, an edited ledger row and a withdrawn
 *    invoice are four different situations, and telling them apart is the whole
 *    value of the exercise.
 */

import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Loader2, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface VerifyLine {
  date: string;
  minutes: number;
  taskKey: string | null;
  taskTitle: string | null;
  streamName: string | null;
  entrySource: string;
}

interface VerifyResponse {
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
}

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" };

function money(cents: number | null, currency: string): string {
  if (cents === null) return "—";
  const amount = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = SYMBOLS[currency?.toUpperCase() ?? ""];
  return symbol ? `${symbol}${amount}` : `${amount} ${currency.toUpperCase()}`;
}

const hm = (minutes: number): string => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

/** The verification endpoint is public, so this is a bare fetch: no token, no org header. */
async function verify(token: string): Promise<VerifyResponse> {
  const res = await fetch(`/api/verify/${encodeURIComponent(token)}`, { headers: { Accept: "application/json" } });
  const body = (await res.json()) as VerifyResponse;
  if (res.status === 429) throw new Error("Too many checks from this address just now. Wait a minute and reload.");
  return body;
}

export default function Verify() {
  const { token = "" } = useParams<{ token: string }>();
  const [copied, setCopied] = useState(false);
  const q = useQuery({ queryKey: ["verify", token], queryFn: () => verify(token), retry: false });

  const data = q.data;
  const ok = data?.valid === true;
  const known = Boolean(data?.invoice);

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
                  <p className="font-serif text-base sm:text-lg mt-3 text-ink-muted">
                    {ok ? (
                      <>
                        This invoice was issued by <span className="text-ink">{data?.invoice?.org}</span> through Plan Track Done, and
                        the {data?.integrity?.entriesChecked} time {data?.integrity?.entriesChecked === 1 ? "entry" : "entries"} behind
                        it are unchanged since it was issued.
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
                {/* What the document says */}
                <section className="paper mt-6 overflow-hidden" data-testid="verify-invoice">
                  <div className="px-4 py-3 flex items-center justify-between border-b border-rule">
                    <span className="eyebrow">The document</span>
                    <span className="section-num">i.</span>
                  </div>
                  {/* The reference is the longest field on the page, so it gets
                      the wider column rather than breaking across two lines. */}
                  <dl className="grid grid-cols-2 sm:grid-cols-[1.35fr_1fr_1fr_1fr] divide-x divide-y sm:divide-y-0 divide-rule">
                    <Field label="Reference" value={data.invoice.reference} mono />
                    <Field label={data.invoice.kind === "contractor" ? "Contractor" : "Customer"} value={data.invoice.contractorOrCustomer || "—"} />
                    <Field label="Period" value={data.invoice.period.label} />
                    <Field label="Issued" value={new Date(data.invoice.issuedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} />
                  </dl>
                  <dl className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-rule border-t border-rule">
                    <Field label="Billed to" value={data.invoice.org} />
                    <Field label="Recorded" value={hm(data.invoice.totals.minutes)} mono />
                    <Field label="Hours" value={data.invoice.totals.hours.toFixed(2)} mono />
                    <Field label="Amount" value={money(data.invoice.totals.amountCents, data.invoice.currency)} mono accent />
                  </dl>
                  {data.invoice.voided ? (
                    <p className="px-4 py-3 border-t border-rule font-serif text-sm text-vermilion" data-testid="verify-voided">
                      Withdrawn by the issuer on{" "}
                      {new Date(data.invoice.voidedAt ?? data.invoice.issuedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}. The
                      record itself is intact — it simply no longer stands as a claim for payment.
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
                        detail={`sha-256 · ${data.integrity.contentHash}`}
                      />
                      <CheckRow
                        ok={data.integrity.signatureValid}
                        title={`The signature verifies against this deployment's published key`}
                        detail={`${data.integrity.algorithm ?? "ed25519"} · key #${data.integrity.keyId ?? "?"}`}
                      />
                      <CheckRow
                        ok={data.integrity.entriesUnchanged}
                        title={`All ${data.integrity.entriesChecked} time ${data.integrity.entriesChecked === 1 ? "entry is" : "entries are"} unchanged in the ledger`}
                        detail={
                          data.integrity.entriesUnchanged
                            ? "Each entry's times, attribution and attachments re-hash to the values frozen at issue"
                            : [
                                data.integrity.changedEntryIds.length ? `altered: ${data.integrity.changedEntryIds.join(", ")}` : "",
                                data.integrity.missingEntryIds.length ? `deleted: ${data.integrity.missingEntryIds.join(", ")}` : "",
                              ]
                                .filter(Boolean)
                                .join(" · ")
                        }
                      />
                    </ul>
                    <div className="px-4 py-3 border-t border-rule flex flex-wrap items-center gap-4">
                      <a
                        href={data.integrity.publicKeyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="eyebrow text-[9px] inline-flex items-center gap-1.5 hover:text-vermilion focus-ink"
                        data-testid="verify-key-link"
                      >
                        the public key <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                      <button
                        onClick={() => {
                          void navigator.clipboard?.writeText(JSON.stringify(data, null, 2));
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

                {/* The hours themselves */}
                {data.lines?.length ? (
                  <section className="paper mt-6 overflow-hidden" data-testid="verify-lines">
                    <div className="px-4 py-3 flex items-center justify-between border-b border-rule">
                      <span className="eyebrow">The hours on this invoice</span>
                      <span className="section-num">iii.</span>
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
                          {data.lines.map((l, i) => (
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
                      Only dates, durations and what the work was booked against are shown. Session notes, email addresses and
                      anything else private to the organization are never exposed here.
                    </p>
                  </section>
                ) : null}
              </>
            ) : null}

            <footer className="mt-8 pt-4 border-t border-rule">
              <p className="font-display italic text-sm text-ink-muted">
                Hours on a PTD invoice are recorded as the work happens — by a person at a timer or by an agent over the API — and
                frozen into a signed record when the invoice is issued. That is what this page checks.
              </p>
            </footer>
          </>
        )}
      </div>
    </div>
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
