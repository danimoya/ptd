// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React from "react";
import { cn } from "@/lib/utils";
import type { Interval } from "./api";

/* ─────────────────────────────────────────────────────────────────────────
 * The printed furniture of the billing page: banners, meters, statement rows
 * and the one switch. Nothing here knows about Stripe — they are shapes on
 * paper, kept out of BillingTab so the tab reads as the argument it makes.
 * ───────────────────────────────────────────────────────────────────────── */

export const INK_BUTTON =
  "inline-flex items-center justify-center gap-2 px-4 h-[38px] border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-45 disabled:hover:bg-ink disabled:hover:text-parchment disabled:cursor-not-allowed";

export const OUTLINE_BUTTON =
  "inline-flex items-center justify-center gap-2 px-4 h-[38px] border border-ink/40 hover:border-ink transition-colors rounded-sm focus-ink disabled:opacity-60";

export const QUIET_BUTTON =
  "inline-flex items-center gap-1.5 px-2 h-[38px] text-ink-muted hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60";

export function Banner({
  tone, children, icon, testId,
}: {
  tone: "ok" | "warn" | "muted";
  children: React.ReactNode;
  icon?: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className={cn(
        "paper-flat px-3 py-2.5 flex items-start gap-2 text-sm font-serif",
        tone === "ok" && "border-l-2 border-l-ink",
        tone === "warn" && "border-l-2 border-l-vermilion text-vermilion",
        tone === "muted" && "border-l-2 border-l-rule text-ink-muted",
      )}
      data-testid={testId}
      role="status"
    >
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <span>{children}</span>
    </div>
  );
}

/**
 * One seat meter: a ruled track with quarter marks, the figure stated beside its
 * own label rather than inside the bar.
 *
 * Past the mark the fill goes vermilion and stays full width — being over an
 * allowance is not "more than full", it is full and something to answer for, and
 * the note says which of the two kinds it is: billed, or refused.
 */
export function Meter({
  label, value, limit, note, over, testId,
}: {
  label: string;
  value: number;
  limit: number | null;
  note?: React.ReactNode;
  over?: boolean;
  testId: string;
}) {
  const pct = limit && limit > 0 ? Math.round((value / limit) * 100) : 0;
  const filled = Math.max(0, Math.min(100, pct));
  // `over` is the caller's verdict, because a full bar is not always a problem:
  // on Business the seats past the allowance are billed, not refused.
  const hot = over ?? (limit !== null && value >= limit);

  return (
    <div data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="microcaps">{label}</span>
        <span className={cn("eyebrow text-[9px] font-numeric", hot && "!text-vermilion")}>
          {value}
          {limit !== null ? ` / ${limit}` : " · unlimited"}
        </span>
      </div>
      {limit !== null ? (
        <div
          className="relative mt-1.5 h-[6px] overflow-hidden rounded-sm bg-parchment-deep"
          role="meter"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={Math.max(limit, value)}
          aria-valuetext={`${value} of ${limit}`}
          aria-label={label}
        >
          <div
            className={cn("absolute inset-y-0 left-0 transition-[width] duration-700 ease-out", hot ? "bg-vermilion" : "bg-ink")}
            style={{ width: `${Math.max(filled, value > 0 ? 2 : 0)}%` }}
          />
          {[25, 50, 75].map((p) => (
            <span key={p} className="absolute inset-y-0 w-px bg-parchment/90" style={{ left: `${p}%` }} />
          ))}
        </div>
      ) : null}
      {note ? <p className={cn("mt-1 text-[13px] font-serif leading-snug", hot ? "text-vermilion" : "text-ink-muted")}>{note}</p> : null}
    </div>
  );
}

/** A line of a statement: what it is, the arithmetic, and the amount. */
export function StatementRow({
  label, detail, amount, testId,
}: {
  label: string;
  detail?: React.ReactNode;
  amount: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-0.5 px-3 py-2.5 sm:grid-cols-[1fr_auto_5.5rem]" data-testid={testId}>
      <span className="font-serif text-sm">{label}</span>
      <span className="order-3 font-numeric text-[11px] text-ink-muted sm:order-none sm:text-right">{detail}</span>
      <span className="font-numeric text-sm text-right">{amount}</span>
    </div>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2 grid grid-cols-[110px_1fr] gap-3">
      <dt className="eyebrow text-[9px] pt-0.5">{label}</dt>
      <dd className="text-sm font-serif">{children}</dd>
    </div>
  );
}

/** Monthly or yearly, as two stamps in the masthead. */
export function IntervalSwitch({ value, onChange }: { value: Interval; onChange: (next: Interval) => void }) {
  return (
    <div className="flex items-center gap-px border border-rule" role="radiogroup" aria-label="Billing period" data-testid="billing-interval">
      {(["month", "year"] as Interval[]).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          data-testid={`billing-interval-${option}`}
          className={cn(
            "px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors focus-ink",
            value === option ? "bg-ink text-parchment" : "text-ink-muted hover:text-ink",
          )}
        >
          {option === "month" ? "monthly" : "yearly"}
        </button>
      ))}
    </div>
  );
}
