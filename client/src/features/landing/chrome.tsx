// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * Landing chrome — the shared vocabulary of the public page.
 *
 * The conceit: the page is a ledger book. Sections are folios, marked in a
 * left rail with the same § numbering the app uses on its own surfaces
 * (§ I. THE LEDGER, § IV. THE ROLL). Every interactive glimpse is set as a
 * ruled form, the way a worked example is set in a manual. Nothing floats:
 * no shadows, no rounded cards, no gradient washes — only rules and ink.
 * ───────────────────────────────────────────────────────────────────────── */

/** Band colour for a priority score. Shared by the calculator and the tour. */
export const SCORE_BANDS = [
  { min: 75, label: "critical", className: "text-vermilion", bar: "bg-vermilion" },
  { min: 50, label: "high", className: "text-[#956318] dark:text-[#d9a441]", bar: "bg-[#956318] dark:bg-[#d9a441]" },
  { min: 25, label: "normal", className: "text-ink", bar: "bg-ink" },
  { min: 0, label: "low", className: "text-ink-muted", bar: "bg-ink-muted" },
] as const;

export function bandFor(score: number) {
  return SCORE_BANDS.find((b) => score >= b.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1];
}

/** The book's outer measure. One column, left aligned — a ledger is never centred. */
export function Measure({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("mx-auto w-full min-w-0 max-w-6xl px-5 sm:px-8 lg:px-12", className)}>{children}</div>;
}

/**
 * A folio: one numbered section of the book. The mark lives in a rail on the
 * left at desktop width and folds into the heading line on a phone.
 */
export function Folio({
  id,
  mark,
  children,
  className,
  rule = true,
}: {
  id?: string;
  mark: string;
  children: React.ReactNode;
  className?: string;
  rule?: boolean;
}) {
  return (
    <section id={id} className={cn(rule && "border-t border-ink/70", "scroll-mt-16", className)}>
      <Measure>
        <div className="grid gap-x-8 lg:grid-cols-[4.5rem_minmax(0,1fr)]">
          <div className="hidden lg:block">
            <div className="sticky top-20 pt-12">
              <span className="font-numeric text-[11px] tracking-[0.2em] text-vermilion">§&nbsp;{mark}</span>
              <div className="mt-3 h-24 w-px bg-rule" />
            </div>
          </div>
          <div className="min-w-0 py-12 sm:py-16 lg:py-20">
            <span className="font-numeric mb-6 block text-[11px] tracking-[0.2em] text-vermilion lg:hidden">
              §&nbsp;{mark}
            </span>
            {children}
          </div>
        </div>
      </Measure>
    </section>
  );
}

/** Section heading: Fraunces title, serif lede under it, no eyebrow. */
export function Heading({
  title,
  lede,
  className,
}: {
  title: React.ReactNode;
  lede?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("max-w-[34rem]", className)}>
      <h2 className="font-display text-[2rem] leading-[1.08] tracking-[-0.025em] text-ink sm:text-[2.6rem]">{title}</h2>
      {lede && <p className="mt-4 text-[1.0625rem] leading-[1.65] text-ink-muted text-pretty">{lede}</p>}
    </header>
  );
}

/**
 * A ruled form — the frame every interactive glimpse sits in. The header bar
 * carries the form's name on the left and its state on the right, like the
 * column heads of a real ledger page.
 */
export function Form({
  title,
  meta,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div className={cn("min-w-0 border border-ink/70 bg-card", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-ink/70 px-4 py-2.5 sm:px-5">
        <span className="eyebrow text-ink">{title}</span>
        {meta && <span className="font-numeric text-[11px] text-ink-muted">{meta}</span>}
      </div>
      <div className={cn("p-4 sm:p-5", bodyClassName)}>{children}</div>
    </div>
  );
}

/** Primary call to action — the app's stamped button. */
export function InkButton({
  to,
  href,
  children,
  className,
  onClick,
  type = "button",
  disabled,
  testId,
}: {
  to?: string;
  href?: string;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  testId?: string;
}) {
  const classes = cn(
    "inline-flex items-center justify-center gap-2 border border-ink bg-ink px-5 py-2.5",
    "font-numeric text-[11px] uppercase tracking-[0.18em] text-parchment transition-all duration-150",
    "hover:-translate-x-px hover:-translate-y-px hover:bg-parchment hover:text-ink hover:shadow-stamp focus-ink",
    disabled && "cursor-not-allowed opacity-50 hover:translate-x-0 hover:translate-y-0 hover:bg-ink hover:text-parchment hover:shadow-none",
    className
  );
  if (to) return <Link to={to} data-testid={testId} className={classes}>{children}</Link>;
  if (href) return <a href={href} data-testid={testId} className={classes}>{children}</a>;
  return (
    <button type={type} onClick={onClick} disabled={disabled} data-testid={testId} className={classes}>
      {children}
    </button>
  );
}

/** Secondary action — outline only. */
export function QuietButton({
  children,
  onClick,
  active,
  className,
  disabled,
  ...rest
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  className?: string;
  disabled?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-2 border px-3.5 py-2 font-numeric text-[11px] uppercase tracking-[0.16em] transition-colors focus-ink",
        active
          ? "border-ink bg-ink text-parchment"
          : "border-rule text-ink-muted hover:border-ink hover:text-ink",
        disabled && "cursor-not-allowed opacity-45 hover:border-rule hover:text-ink-muted",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A stamped source badge — the same mark the day ledger puts on every row. */
export function SourceStamp({ agent, children }: { agent?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-block whitespace-nowrap border px-1.5 py-px font-numeric text-[10px] uppercase tracking-[0.12em]",
        agent ? "border-vermilion/70 text-vermilion" : "border-rule text-ink-muted"
      )}
    >
      {children}
    </span>
  );
}

/** A caption set as a footnote under a plate. */
export function Footnote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("mt-3 border-t border-rule pt-2 font-numeric text-[11px] leading-relaxed text-ink-muted", className)}>
      {children}
    </p>
  );
}
