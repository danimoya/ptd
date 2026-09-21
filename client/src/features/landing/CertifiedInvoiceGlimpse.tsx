// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { Form, QuietButton, SourceStamp } from "./chrome";

/* ─────────────────────────────────────────────────────────────────────────
 * The certified invoice.
 *
 * The one instrument on this page that argues rather than demonstrates. An
 * external contractor's September, issued as an invoice whose lines were
 * frozen, hashed and signed at issue — and the verification slip anyone
 * holding the link sees, with no account and no login.
 *
 * The slip is what the link proves, not what the link shows. The real page
 * names the reference, the issue date and the three checks and stops there;
 * the lines and the figures on the left are released only to an address the
 * issuer named, after a six-digit code emailed to it. That is why the panel
 * says "what the link proves" — a link printed on a document that gets
 * forwarded has to be safe to forward.
 *
 * Press "Pad the hours" and one line grows by an hour, the way a padded
 * timesheet grows. Nothing on the invoice complains; the slip does, because
 * the digest it recomputes no longer matches the one that was signed. That
 * is the whole argument for proof of work over proof of presence, in one
 * button.
 *
 * The fingerprint below is FNV-1a, computed in the browser so a visitor can
 * watch it move. The real ledger hashes each line with SHA-256 and signs the
 * digest with Ed25519 on the server; the footnote says so, because a section
 * about proof cannot be vague about what it is proving.
 * ───────────────────────────────────────────────────────────────────────── */

export type LineSource = "human" | "agent";

export interface InvoiceLine {
  n: number;
  task: string;
  taskRef: string;
  source: LineSource;
  minutes: number;
  tokens?: number;
  /** Dollars. Human lines bill the rate; agent lines pass the API cost through. */
  amount: number;
}

export const HOURLY_RATE = 90;

/** Nadia's September, as the ledger recorded it. */
export const LINES: InvoiceLine[] = [
  { n: 1, task: "Rotate the leaked API keys", taskRef: "SEC-1", source: "human", minutes: 200, amount: 300 },
  { n: 2, task: "Pin TLS 1.3 + PQC hybrid on the API edge", taskRef: "SEC-2", source: "human", minutes: 345, amount: 517.5 },
  {
    n: 3,
    task: "Overnight failure triage",
    taskRef: "SEC-2",
    source: "agent",
    minutes: 95,
    tokens: 152000,
    amount: 12.87,
  },
  { n: 4, task: "Generate the OpenAPI spec from routes", taskRef: "API-1", source: "human", minutes: 95, amount: 142.5 },
];

/** The padding: line 1 quietly grows by an hour after the invoice was signed. */
export const PADDED_MINUTES = 260;

export function padded(lines: InvoiceLine[] = LINES): InvoiceLine[] {
  return lines.map((l) =>
    l.n === 1 ? { ...l, minutes: PADDED_MINUTES, amount: round2((PADDED_MINUTES / 60) * HOURLY_RATE) } : l
  );
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function total(lines: InvoiceLine[]): number {
  return round2(lines.reduce((a, l) => a + l.amount, 0));
}

export function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Dollars, grouped. A four-figure invoice total without a comma reads as a typo. */
export function money(n: number): string {
  const [whole, cents] = n.toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

/**
 * The canonical form of a line — the exact bytes that get hashed. Order and
 * separator are fixed, because a digest over "whatever the UI happened to
 * render" is not a digest of anything.
 */
export function canonical(line: InvoiceLine): string {
  return [line.n, line.taskRef, line.source, line.minutes, line.tokens ?? 0, line.amount.toFixed(2)].join("|");
}

/** FNV-1a, 32-bit, as eight hex digits. A stand-in for SHA-256, and labelled as one. */
export function fingerprint(lines: InvoiceLine[]): string {
  let h = 0x811c9dc5;
  const input = lines.map(canonical).join("\n");
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The digest that was signed on 30 September, before anyone touched anything. */
export const SIGNED_DIGEST = fingerprint(LINES);
export const SIGNED_TOTAL = total(LINES);
export const VERIFY_TOKEN = "inv_2026_09_014_7f2ad3c1";
export const VERIFY_URL = `https://ptd.example.com/verify/${VERIFY_TOKEN}`;

export interface Verdict {
  ok: boolean;
  headline: string;
  reason: string;
}

export function verdictFor(lines: InvoiceLine[]): Verdict {
  const digest = fingerprint(lines);
  if (digest === SIGNED_DIGEST) {
    return {
      ok: true,
      headline: "Verified",
      reason: "Every line matches the version signed at issue. The signature checks out against PTD's public key.",
    };
  }
  const changed = lines.find((l, i) => canonical(l) !== canonical(LINES[i]));
  const was = changed ? LINES[changed.n - 1] : null;
  return {
    ok: false,
    headline: "Not verified",
    reason: changed && was
      ? `Line ${changed.n} changed after signing: ${hours(was.minutes)} became ${hours(changed.minutes)}, ${money(
          was.amount
        )} became ${money(changed.amount)}. The recomputed digest does not match the signed one.`
      : "The recomputed digest does not match the signed one.",
  };
}

export default function CertifiedInvoiceGlimpse({ className }: { className?: string }) {
  const [tampered, setTampered] = useState(false);
  const lines = tampered ? padded() : LINES;
  const verdict = verdictFor(lines);
  const digest = fingerprint(lines);
  const sum = total(lines);

  return (
    <Form
      title="Certified invoice"
      meta="frozen · hashed · signed at issue"
      className={className}
      bodyClassName="p-0"
    >
      <div className="grid lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* ── The document ───────────────────────────────────────────── */}
        <article className="min-w-0 p-4 sm:p-5">
          <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <div>
              <h3 className="font-display text-[1.25rem] tracking-[-0.02em] text-ink">Nadia Feldbaum</h3>
              <p className="font-numeric text-[10px] text-ink-muted">
                external · Atelier 14 · September 2026
              </p>
            </div>
            <span className="font-numeric text-[10px] tabular-nums text-ink-muted">INV-2026-09-014</span>
          </header>

          <ul className="mt-4 divide-y divide-rule border-y border-rule">
            {lines.map((line) => {
              const moved = tampered && canonical(line) !== canonical(LINES[line.n - 1]);
              return (
                <li
                  key={line.n}
                  data-testid={`invoice-line-${line.n}`}
                  className={cn(
                    "grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2.5",
                    moved && "bg-vermilion/5"
                  )}
                >
                  <span className="font-numeric text-[11px] tabular-nums text-ink-muted">
                    {String(line.n).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[0.95rem] text-ink">{line.task}</span>
                    <span className="font-numeric mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
                      <span className="tabular-nums">{line.taskRef}</span>
                      <SourceStamp agent={line.source === "agent"}>
                        {line.source === "agent"
                          ? `agent · ${(line.tokens ?? 0) / 1000}k tok`
                          : `human · ${hours(line.minutes)}`}
                      </SourceStamp>
                      {moved && <span className="text-vermilion">edited after signing</span>}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "font-numeric self-center text-sm tabular-nums",
                      moved ? "text-vermilion" : "text-ink"
                    )}
                  >
                    {money(line.amount)}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 flex items-baseline justify-between gap-4">
            <span className="font-numeric text-[10px] uppercase tracking-[0.14em] text-ink-muted">
              {lines.length} lines · {hours(lines.reduce((a, l) => a + l.minutes, 0))} · rate {money(HOURLY_RATE)}/h
            </span>
            <span
              data-testid="invoice-total"
              className={cn("font-display text-[1.6rem] tabular-nums tracking-[-0.03em]", tampered ? "text-vermilion" : "text-ink")}
            >
              {money(sum)}
            </span>
          </div>

          <p className="mt-3 border-t border-rule pt-2.5 text-[0.9rem] leading-relaxed text-ink-muted text-pretty">
            Each line links to the task, its cascade history and the event log behind it. Nobody was watched.
            Nothing was screenshotted.
          </p>
        </article>

        {/* ── The slip anyone with the link sees ─────────────────────── */}
        <aside
          className={cn(
            "min-w-0 border-t border-ink/70 p-4 sm:p-5 lg:border-l lg:border-t-0",
            verdict.ok ? "bg-sage/[0.07]" : "bg-vermilion/[0.07]"
          )}
          aria-live="polite"
        >
          <p className="font-numeric text-[10px] uppercase tracking-[0.14em] text-ink-muted">
            What the link proves
          </p>
          <p
            data-testid="verify-headline"
            className={cn(
              "font-display mt-1 text-[1.75rem] leading-none tracking-[-0.03em]",
              verdict.ok ? "text-sage" : "text-vermilion"
            )}
          >
            {verdict.headline}
          </p>
          <p data-testid="verify-reason" className="mt-2.5 text-[0.9rem] leading-relaxed text-ink text-pretty">
            {verdict.reason}
          </p>

          <dl className="mt-4 space-y-2 border-t border-rule pt-3">
            <Slip term="Signed digest" value={`sha256:${SIGNED_DIGEST}…`} />
            <Slip
              term="Recomputed now"
              value={`sha256:${digest}…`}
              testId="verify-digest"
              alarm={!verdict.ok}
            />
            <Slip term="Signature" value="ed25519 · key ptd-sig-2026-09" />
            <Slip term="Signed total" value={money(SIGNED_TOTAL)} />
          </dl>

          <p className="font-numeric mt-4 break-all border-t border-rule pt-3 text-[10px] leading-relaxed text-ink-muted">
            {VERIFY_URL}
          </p>
          <p className="mt-2 text-[0.85rem] leading-relaxed text-ink-muted text-pretty" data-testid="verify-disclosure">
            A private link. Whoever holds it can confirm the invoice is genuine — a client, an accountant, an
            auditor — with no account and no login, and sees no names, no figures and no line items. The details
            go only to the people the issuer named, each after a six-digit code emailed to their own address.
          </p>
        </aside>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-ink/70 p-4 sm:px-5">
        <QuietButton
          data-testid="tamper-toggle"
          active={tampered}
          onClick={() => setTampered((t) => !t)}
        >
          {tampered ? "Put line 1 back" : "Pad line 1 by an hour"}
        </QuietButton>
        <span className="font-numeric text-[11px] leading-relaxed text-ink-muted">
          Proof of work, not proof of presence.
        </span>
      </div>
    </Form>
  );
}

function Slip({
  term,
  value,
  alarm,
  testId,
}: {
  term: string;
  value: string;
  alarm?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-numeric shrink-0 text-[10px] uppercase tracking-[0.12em] text-ink-muted">{term}</dt>
      <dd
        data-testid={testId}
        className={cn(
          "font-numeric min-w-0 truncate text-right text-[11px] tabular-nums",
          alarm ? "text-vermilion line-through decoration-vermilion/50" : "text-ink"
        )}
      >
        {value}
      </dd>
    </div>
  );
}
