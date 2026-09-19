/**
 * Hour × weekday heat strip: seven rows of twenty-four cells.
 *
 * Intensity is minutes against the busiest cell in the window; the ink is
 * vermilion when most of that cell was agent work and ink otherwise, so the
 * strip answers "when does work happen" and "when do the machines work" in one
 * pass. A plain grid of divs rather than a chart library — 168 cells with a
 * title each is cheaper and more legible than any charted heatmap.
 */

import { formatMinutes } from "../format";
import { cn } from "@/lib/utils";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** Order the strip Monday-first, matching the week buckets everywhere else. */
const ROW_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21];

export default function HeatStrip({ heat, heatAgent, heatMax }: { heat: number[][]; heatAgent: number[][]; heatMax: number }) {
  if (!heat.length || heatMax === 0) {
    return <p className="eyebrow text-[10px] normal-case tracking-normal font-serif text-ink-muted py-4">No work has been logged in this window.</p>;
  }

  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <div className="min-w-[560px]">
        <div className="grid grid-cols-[2.4rem_repeat(24,minmax(0,1fr))] gap-[2px]">
          {ROW_ORDER.map((weekday) => (
            <div key={weekday} className="contents">
              <span className="eyebrow text-[9px] self-center pr-1">{DAY_LABELS[weekday]}</span>
              {Array.from({ length: 24 }, (_, hour) => {
                const minutes = heat[weekday]?.[hour] ?? 0;
                const agent = heatAgent[weekday]?.[hour] ?? 0;
                const intensity = minutes === 0 ? 0 : 0.12 + 0.78 * (minutes / heatMax);
                const agentLed = agent * 2 > minutes;
                return (
                  <span
                    key={hour}
                    title={
                      minutes === 0
                        ? `${DAY_LABELS[weekday]} ${String(hour).padStart(2, "0")}:00 — nothing logged`
                        : `${DAY_LABELS[weekday]} ${String(hour).padStart(2, "0")}:00 — ${formatMinutes(minutes)}${agent > 0 ? ` (${formatMinutes(agent)} agent)` : ""}`
                    }
                    aria-label={`${DAY_LABELS[weekday]} ${hour}:00, ${minutes} minutes`}
                    className={cn("h-5 rounded-[1px] border", minutes === 0 ? "border-rule/60" : "border-transparent")}
                    style={
                      minutes === 0
                        ? undefined
                        : { backgroundColor: agentLed ? `hsl(var(--vermilion) / ${intensity})` : `hsl(var(--ink) / ${intensity})` }
                    }
                  />
                );
              })}
            </div>
          ))}
          <span />
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} className="eyebrow text-[8px] text-center leading-4">
              {HOUR_TICKS.includes(hour) ? String(hour).padStart(2, "0") : ""}
            </span>
          ))}
        </div>

        <div className="flex items-center gap-4 mt-3">
          <span className="flex items-center gap-1.5 eyebrow text-[9px]">
            <span className="h-2.5 w-2.5 rounded-[1px]" style={{ backgroundColor: "hsl(var(--ink) / 0.7)" }} aria-hidden /> mostly human
          </span>
          <span className="flex items-center gap-1.5 eyebrow text-[9px]">
            <span className="h-2.5 w-2.5 rounded-[1px]" style={{ backgroundColor: "hsl(var(--vermilion) / 0.8)" }} aria-hidden /> mostly agent
          </span>
          <span className="eyebrow text-[9px] ml-auto">busiest cell · {formatMinutes(heatMax)}</span>
        </div>
      </div>
    </div>
  );
}
