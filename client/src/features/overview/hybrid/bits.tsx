import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The small printed pieces the Hybrid tab is set from.
 *
 * Kept in one file so a figure in a tile, a figure in a tooltip and a figure in a
 * table are typeset identically — the surface is meant to read as one page of a
 * printed ledger, and that only holds if the tabular numerals, the hairlines and
 * the eyebrows come from one place.
 *
 * The palette rule, which the whole tab obeys without exception: **human is ink,
 * agent is vermilion.** Nothing else on this page is allowed to be vermilion,
 * except a budget that has been exceeded — which is the one other thing a manager
 * needs to see from across the room.
 */

export const INK = "hsl(var(--ink))";
export const VERMILION = "hsl(var(--vermilion))";
export const SAGE = "hsl(var(--sage))";
export const GRID = "hsl(var(--rule))";

export const CHART_TICK = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 10,
  fill: "hsl(var(--ink-muted))",
} as const;

export const CHART_TOOLTIP = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--rule))",
  borderRadius: "2px",
  fontFamily: "JetBrains Mono, monospace",
  fontSize: "12px",
  color: "hsl(var(--ink))",
} as const;

export const CHART_LEGEND = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: "10px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.12em",
};

/** A section of the page: eyebrow, title, an aside for the count, hairline under. */
export function Panel({
  eyebrow,
  title,
  aside,
  children,
  className,
  testId,
}: {
  eyebrow: string;
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={cn("paper-flat", className)} data-testid={testId}>
      <header className="flex items-baseline justify-between gap-3 border-b border-rule px-3 py-2">
        <div className="min-w-0">
          <div className="eyebrow text-[9px]">{eyebrow}</div>
          <h3 className="font-display mt-0.5 truncate text-base tracking-tight sm:text-lg">{title}</h3>
        </div>
        {aside ? <div className="eyebrow shrink-0 text-[9px]">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** One figure, big, with its label under it and an optional second line. */
export function Tile({
  label,
  value,
  hint,
  accent,
  title,
  testId,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  accent?: boolean;
  title?: string;
  testId?: string;
}) {
  return (
    <div className="px-3 py-2.5" title={title} data-testid={testId}>
      <div className={cn("font-numeric text-xl leading-none tabular-nums sm:text-2xl", accent ? "text-vermilion" : "text-ink")}>{value}</div>
      <div className="eyebrow mt-1.5 text-[9px] truncate">{label}</div>
      {hint ? <div className="mt-1 font-serif text-[0.72rem] leading-snug text-ink-muted">{hint}</div> : null}
    </div>
  );
}

/**
 * A hairline meter for one stream's budget burn.
 *
 * Over budget it fills vermilion and the bar keeps its 100% width — an overspend
 * is not "more than full", it is full and wrong, and the figure beside it says by
 * how much.
 */
export function BurnMeter({ pct, over, label }: { pct: number; over: boolean; label: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      className="relative h-[6px] overflow-hidden rounded-sm bg-parchment-deep"
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={cn("absolute inset-y-0 left-0 transition-[width] duration-700 ease-out", over ? "bg-vermilion" : "bg-sage")}
        style={{ width: `${Math.max(over ? 100 : clamped, pct > 0 ? 2 : 0)}%` }}
      />
      {[25, 50, 75].map((p) => (
        <span key={p} className="absolute inset-y-0 w-px bg-parchment/90" style={{ left: `${p}%` }} />
      ))}
    </div>
  );
}

/** The two-column human/agent pair, printed the same way in every panel. */
export function SplitPair({ human, agent, extra }: { human: string; agent: string; extra?: ReactNode }) {
  return (
    // `whitespace-nowrap` per item, wrapping between them: at 390px a label must
    // never be orphaned from the figure it labels.
    <div className="font-numeric flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[0.72rem] tabular-nums">
      <span className="whitespace-nowrap text-ink-muted">
        <span className="eyebrow text-[9px]">human</span> {human}
      </span>
      <span className="whitespace-nowrap text-vermilion">
        <span className="eyebrow text-[9px] !text-vermilion">agent</span> {agent}
      </span>
      {extra}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <div className="fleuron w-full max-w-[200px]">❧</div>
      <p className="font-display italic text-sm text-ink-muted">{children}</p>
    </div>
  );
}
