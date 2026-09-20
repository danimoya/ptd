// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { Form, QuietButton, bandFor } from "./chrome";

/* ─────────────────────────────────────────────────────────────────────────
 * Glimpse II — the priority score.
 *
 * Three numbers a person can actually answer, one number the backlog can
 * sort on. Identical to the formula the server keeps, so the figure a
 * visitor lands on here is the figure the backlog would show.
 * ───────────────────────────────────────────────────────────────────────── */

/** urgency × impact ÷ effort, rounded and clamped to 0–100. */
export function scoreOf(urgency: number, impact: number, effort: number): number {
  const raw = (urgency * impact) / Math.max(effort, 1);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export const PRESETS = [
  { label: "Keys are leaking", urgency: 10, impact: 10, effort: 1 },
  { label: "v2 needs docs", urgency: 8, impact: 8, effort: 2 },
  { label: "Tidy the CSS", urgency: 5, impact: 5, effort: 5 },
] as const;

export default function PriorityCalculator({ className }: { className?: string }) {
  const [urgency, setUrgency] = useState(8);
  const [impact, setImpact] = useState(8);
  const [effort, setEffort] = useState(2);
  const score = scoreOf(urgency, impact, effort);
  const band = bandFor(score);

  return (
    <Form title="Score a card" meta="urgency × impact ÷ effort" className={className}>
      <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_11rem] sm:gap-8">
        <div className="space-y-5">
          <Dial label="Urgency" hint="How soon does it hurt?" value={urgency} onChange={setUrgency} />
          <Dial label="Impact" hint="How much does it move?" value={impact} onChange={setImpact} />
          <Dial label="Effort" hint="How much does it cost you?" value={effort} onChange={setEffort} />
        </div>

        <div className="flex flex-col justify-between border-t border-rule pt-5 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
          <div>
            <div className="eyebrow">Priority</div>
            <div
              aria-live="polite"
              data-testid="priority-score"
              className={cn("font-display mt-1 text-[4rem] leading-none tabular-nums tracking-[-0.04em]", band.className)}
            >
              {score}
            </div>
            <div className={cn("font-numeric mt-1 text-[11px] uppercase tracking-[0.16em]", band.className)}>
              {band.label}
            </div>
            <p className="font-numeric mt-4 text-[11px] leading-relaxed text-ink-muted">
              {urgency} × {impact} ÷ {Math.max(effort, 1)} = {score}
            </p>
          </div>

          <div className="mt-5">
            <div className="flex h-1.5 w-full overflow-hidden">
              <Segment width="25%" className="bg-ink-muted/35" lit={score < 25} />
              <Segment width="25%" className="bg-ink/40" lit={score >= 25 && score < 50} />
              <Segment width="25%" className="bg-[#956318]/45 dark:bg-[#d9a441]/45" lit={score >= 50 && score < 75} />
              <Segment width="25%" className="bg-vermilion/45" lit={score >= 75} />
            </div>
            <div className="font-numeric mt-1.5 flex justify-between text-[10px] tabular-nums text-ink-muted">
              <span>0</span>
              <span>25</span>
              <span>50</span>
              <span>75</span>
              <span>100</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-rule pt-4">
        <span className="eyebrow mr-1">Try</span>
        {PRESETS.map((p) => (
          <QuietButton
            key={p.label}
            active={p.urgency === urgency && p.impact === impact && p.effort === effort}
            onClick={() => {
              setUrgency(p.urgency);
              setImpact(p.impact);
              setEffort(p.effort);
            }}
          >
            {p.label}
          </QuietButton>
        ))}
      </div>
    </Form>
  );
}

function Segment({ width, className, lit }: { width: string; className: string; lit: boolean }) {
  return <span style={{ width }} className={cn(className, "transition-opacity", lit ? "opacity-100" : "opacity-30")} />;
}

function Dial({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (n: number) => void;
}) {
  const id = useId();
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[0.95rem] text-ink">
          {label}
          <span className="ml-2 text-[0.8rem] italic text-ink-muted">{hint}</span>
        </label>
        <span className="font-numeric text-sm tabular-nums text-ink">{value}</span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={10}
        step={1}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(
          "focus-ink mt-2 h-1 w-full cursor-pointer appearance-none bg-rule",
          "[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none",
          "[&::-webkit-slider-thumb]:rounded-none [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-ink",
          "[&::-webkit-slider-thumb]:bg-vermilion [&::-webkit-slider-thumb]:cursor-grab",
          "[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:rounded-none",
          "[&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-ink [&::-moz-range-thumb]:bg-vermilion"
        )}
      />
      <div className="mt-1.5 flex justify-between" aria-hidden="true">
        {Array.from({ length: 11 }, (_, i) => (
          <span key={i} className={cn("h-1 w-px", i <= value ? "bg-ink/45" : "bg-rule")} />
        ))}
      </div>
    </div>
  );
}
