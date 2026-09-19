/**
 * The small editorial pieces the reports and insights pages are set from.
 *
 * Kept together so a figure printed on the reports page and the same figure on
 * the insights page are typeset identically — the whole surface is meant to read
 * as one printed volume, and that only holds if the tabular numerals, the rules
 * and the eyebrows come from one place.
 */

import type { ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMinutes, formatTokens, formatUsd } from "../format";
import type { Trend } from "./api";

/** Human is ink; agent is vermilion. The one rule the whole palette follows. */
export const INK = "hsl(var(--ink))";
export const VERMILION = "hsl(var(--vermilion))";
export const RECESS = "hsl(var(--ink) / 0.18)";

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

export function Panel({
  eyebrow,
  title,
  numeral,
  aside,
  children,
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  numeral?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("paper p-5 sm:p-7", className)}>
      <header className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <div className="eyebrow">{eyebrow}</div>
          <h2 className="font-display text-lg sm:text-xl mt-1 tracking-tight">{title}</h2>
        </div>
        <div className="flex items-baseline gap-3 shrink-0">
          {aside}
          {numeral && <span className="section-num">{numeral}</span>}
        </div>
      </header>
      {children}
    </section>
  );
}

export function MetricCell({
  label,
  value,
  hint,
  glyph,
  accent,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  glyph?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col py-3 px-4">
      <div className="flex items-start justify-between gap-2">
        <span className="eyebrow">{label}</span>
        {glyph && <span className="section-num">{glyph}</span>}
      </div>
      <span
        className={cn(
          "font-numeric tabular-nums mt-2 text-2xl sm:text-3xl tracking-tight leading-none",
          accent ? "text-vermilion" : "text-ink"
        )}
      >
        {value}
      </span>
      {hint && <span className="eyebrow mt-2 text-[10px] normal-case tracking-normal font-serif">{hint}</span>}
    </div>
  );
}

/**
 * A trend arrow that says two things at once: which way the number moved, and
 * whether that is the direction you wanted. Rising agent cost moves up and reads
 * in vermilion; rising hours move up and read in sage.
 */
export function TrendArrow({ trend, className }: { trend: Trend; className?: string }) {
  const Icon = trend.direction === "flat" ? ArrowRight : trend.direction === "up" ? ArrowUp : ArrowDown;
  return (
    <span
      title={`${trend.direction === "flat" ? "unchanged" : `${trend.direction} ${Math.abs(trend.pct)}%`} — ${trend.better ? "the direction you want" : "watch this"}`}
      className={cn(
        "inline-flex items-center gap-1 font-numeric text-xs tabular-nums",
        trend.direction === "flat" ? "text-ink-muted" : trend.better ? "text-sage" : "text-vermilion",
        className
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      {trend.direction === "flat" ? "—" : `${Math.abs(trend.pct)}%`}
    </span>
  );
}

/** The human/agent pair, printed the same way everywhere on this surface. */
export function SourceSplit({
  human,
  agent,
  tokens,
  costUsd,
  className,
}: {
  human: number;
  agent: number;
  tokens?: number;
  costUsd?: number;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-2 gap-4", className)}>
      <div>
        <div className="eyebrow">Human</div>
        <div className="font-numeric text-lg mt-0.5 tabular-nums">{formatMinutes(human)}</div>
      </div>
      <div className="border-l border-rule pl-4">
        <div className="eyebrow !text-vermilion">Agent</div>
        <div className="font-numeric text-lg mt-0.5 tabular-nums text-vermilion">{formatMinutes(agent)}</div>
        {/* `n && <…>` would print a bare 0 when both are zero — hence the ternary. */}
        {(tokens ?? 0) > 0 || (costUsd ?? 0) > 0 ? (
          <div className="font-numeric text-[10px] mt-0.5 text-ink-muted tabular-nums">
            {formatTokens(tokens ?? 0)} tok · {formatUsd(costUsd ?? 0)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="py-12 flex flex-col items-center gap-3 text-center">
      <div className="fleuron w-full max-w-[220px]">❧</div>
      <div className="font-display italic text-ink-muted">{children}</div>
    </div>
  );
}

export function Loading({ children = "Setting the page…" }: { children?: ReactNode }) {
  return <div className="py-10 text-center eyebrow">{children}</div>;
}

export function Failed({ children = "That page could not be fetched." }: { children?: ReactNode }) {
  return <div className="py-10 text-center text-vermilion font-display italic">{children}</div>;
}

/** A hairline meter, as used for customer goals. */
export function Meter({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="relative h-[6px] bg-rule rounded-full overflow-hidden">
      <div
        className="absolute inset-y-0 left-0 bg-vermilion rounded-full transition-[width] duration-700 ease-out"
        style={{ width: `${clamped}%` }}
      />
      {[25, 50, 75].map((p) => (
        <span key={p} className="absolute top-0 bottom-0 w-px bg-parchment/90" style={{ left: `${p}%` }} />
      ))}
    </div>
  );
}
