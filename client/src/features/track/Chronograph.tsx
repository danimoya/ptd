import { useEffect, useState } from "react";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { BUILTIN_BREAKS, iconFor } from "@/components/break-icons";
import { splitElapsed, elapsedSeconds } from "./format";
import type { OpenEntry, TemplateRow } from "./api";
import BreakDialog from "./BreakDialog";

/**
 * The chronograph: a 60-second sweep hand, a mono HH:MM:SS read-out, and one
 * line underneath saying what is being timed.
 *
 * The elapsed time is always derived from the entry's `checkIn` rather than
 * counted up locally, so a reload, a sleeping laptop or a session started from
 * an editor over MCP all show the true figure instead of resuming from zero.
 */
export function Chronograph({
  current,
  templates,
  busy,
  onStart,
  onStop,
  onBreak,
}: {
  current: OpenEntry | null;
  templates: TemplateRow[];
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onBreak: (args: { templateId?: number; label?: string }) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [showQuickBreaks, setShowQuickBreaks] = useState(false);
  const running = !!current;
  const isBreak = !!current?.isBreak;

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, current?.id]);

  const elapsed = current ? elapsedSeconds(current.checkIn, now) : 0;
  const { h, m, s } = splitElapsed(elapsed);
  const sweepDeg = (elapsed % 60) * 6;

  // What the running entry is against, most specific first.
  const subject = current
    ? current.notes || current.taskTitle || current.streamName || (isBreak ? "recess chronograph" : "work chronograph")
    : "work chronograph";

  // The member's own tiles first; a built-in of the same name would just be a
  // duplicate of the tile they already saved, so it drops out.
  const saved = templates.filter((t) => t.isBreak);
  const savedNames = new Set(saved.map((t) => t.name.trim().toLowerCase()));
  const breakTiles = [
    ...saved.map((t) => ({ key: `t${t.id}`, icon: t.icon ?? "coffee", name: t.name, run: () => onBreak({ templateId: t.id }) })),
    ...BUILTIN_BREAKS.filter((b) => !savedNames.has(b.name.toLowerCase())).map((b) => ({ key: `b-${b.icon}`, icon: b.icon, name: b.name, run: () => onBreak({ label: b.note }) })),
  ].slice(0, 10);

  return (
    <section className="relative">
      <div className="flex flex-col items-center">
        <span className={cn("eyebrow text-[10px] mb-3", running ? "!text-vermilion" : "!text-ink-muted")}>
          {running ? (isBreak ? "On recess" : "In progress") : "Ready to commence"}
        </span>

        <div className="relative w-[260px] h-[260px] sm:w-[300px] sm:h-[300px] flex items-center justify-center animate-ink-fade-in">
          <div className="absolute inset-0 rounded-full border border-ink/90" />
          <div className="absolute inset-[6px] rounded-full border border-rule" />
          <div
            aria-hidden
            className="absolute inset-[14px] rounded-full"
            style={{
              // repeating-conic-gradient, not the shared .chrono-ticks class:
              // that one's plain conic-gradient stops at 6deg and holds its last
              // colour, which draws a single tick and a wash instead of a ring
              // of sixty.
              backgroundImage: "repeating-conic-gradient(from 0deg, hsl(var(--ink) / 0.4) 0 1.2deg, transparent 1.2deg 6deg)",
              maskImage: "radial-gradient(closest-side, transparent 0 calc(100% - 14px), #000 calc(100% - 14px) calc(100% - 2px), transparent calc(100% - 2px))",
              WebkitMaskImage: "radial-gradient(closest-side, transparent 0 calc(100% - 14px), #000 calc(100% - 14px) calc(100% - 2px), transparent calc(100% - 2px))",
            }}
          />

          {running && (
            <div
              className="absolute inset-0 pointer-events-none motion-safe:transition-transform motion-safe:duration-[950ms]"
              style={{ transform: `rotate(${sweepDeg}deg)`, transitionTimingFunction: "cubic-bezier(0.4, 2, 0.6, 1)" }}
            >
              <div className="absolute left-1/2 top-[14px] -translate-x-1/2 w-[1.5px] h-[22px] bg-vermilion" />
            </div>
          )}

          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-vermilion shadow-[0_0_0_3px_hsl(var(--parchment))]" />

          <div className="relative z-10 text-center pb-6 sm:pb-10">
            <div
              role="timer"
              aria-live="off"
              aria-label={`Elapsed ${h} hours ${m} minutes ${s} seconds`}
              className="flex items-baseline justify-center"
            >
              <span className="font-numeric text-[42px] sm:text-[52px] font-medium tabular-nums leading-none">{h}</span>
              <span className={cn("font-numeric text-[42px] sm:text-[52px] font-medium leading-none px-0.5", running ? "motion-safe:animate-tick-pulse text-vermilion" : "text-ink/40")}>:</span>
              <span className="font-numeric text-[42px] sm:text-[52px] font-medium tabular-nums leading-none">{m}</span>
              <span className={cn("font-numeric text-[42px] sm:text-[52px] font-medium leading-none px-0.5", running ? "motion-safe:animate-tick-pulse text-vermilion" : "text-ink/40")}>:</span>
              <span className="font-numeric text-[42px] sm:text-[52px] font-medium tabular-nums leading-none">{s}</span>
            </div>
            <div className="mt-2 text-[10px] eyebrow text-ink-muted">HRS &nbsp;·&nbsp; MIN &nbsp;·&nbsp; SEC</div>
          </div>

          <div className="absolute bottom-[20%] left-0 right-0 text-center px-10">
            <div className={cn("font-display italic text-[11px] tracking-wide truncate", running ? "text-ink" : "text-ink-muted")}>
              {running ? `— ${subject} —` : subject}
            </div>
            {running && current?.streamName && (
              <div className="mt-0.5 eyebrow text-[9px] truncate">{current.streamName}</div>
            )}
          </div>
        </div>

        <div className="mt-6 sm:mt-8 w-full max-w-md">
          {!running ? (
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Button
                size="lg"
                onClick={onStart}
                disabled={busy}
                className="h-14 rounded-sm font-display text-base tracking-tight uppercase bg-ink text-parchment hover:bg-vermilion hover:text-parchment transition-colors"
              >
                <Play className="h-4 w-4 mr-2" strokeWidth={2.5} />
                Begin Session
              </Button>
              <BreakDialog templates={templates} busy={busy} onBreak={onBreak} />
            </div>
          ) : (
            <Button
              size="lg"
              onClick={onStop}
              disabled={busy}
              className="w-full h-14 rounded-sm font-display text-base tracking-tight uppercase bg-vermilion text-parchment hover:bg-ink hover:text-parchment transition-colors"
            >
              <Square className="h-4 w-4 mr-2" strokeWidth={2.5} />
              Close Entry
            </Button>
          )}

          {/* ── Quick switch to break ── */}
          <div className="mt-4 pt-4 border-t border-rule">
            <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
              <div>
                <div className="eyebrow">Quick switch to break</div>
                <div className="font-display italic text-[11px] text-ink-muted mt-0.5">
                  {running && !isBreak
                    ? "Clicking a tile closes this work session and starts a break."
                    : isBreak
                      ? "Clicking a tile swaps the running break for another."
                      : "Clicking a tile starts a break immediately."}
                </div>
              </div>
              <Switch
                checked={showQuickBreaks}
                onCheckedChange={setShowQuickBreaks}
                className="data-[state=checked]:bg-vermilion data-[state=unchecked]:bg-ink/20 shrink-0"
                aria-label="Toggle quick-break tiles"
              />
            </label>

            <div
              className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-out", showQuickBreaks ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
              aria-hidden={!showQuickBreaks}
            >
              <div className="overflow-hidden">
                <div className="grid grid-cols-5 gap-2 mt-3">
                  {breakTiles.map((tile) => {
                    const Icon = iconFor(tile.icon);
                    return (
                      <button
                        key={tile.key}
                        type="button"
                        onClick={tile.run}
                        disabled={busy || !showQuickBreaks}
                        tabIndex={showQuickBreaks ? 0 : -1}
                        className="paper-flat flex flex-col items-center gap-1 py-3 px-1 hover:border-ink/50 hover:bg-parchment-deep focus-ink transition-colors disabled:opacity-50"
                      >
                        <Icon className="h-5 w-5 text-ink" strokeWidth={1.5} />
                        <span className="font-display italic text-[11px] text-ink leading-tight truncate max-w-full">{tile.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default Chronograph;
