import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Play, Square } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createTimeEntry, updateTimeEntry } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import BreakMenu from "./BreakMenu";
import { BUILTIN_BREAKS, iconFor } from "./break-icons";

interface ActiveTimerProps {
  activeEntry?: {
    id: number;
    checkIn: string;
    isBreak: boolean;
    notes?: string | null;
  };
  selectedCustomerId?: string;
  selectedProjectId?: string;
  onCustomerChange: (customerId: string) => void;
}

function splitElapsed(totalSec: number) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return {
    h: String(h).padStart(2, "0"),
    m: String(m).padStart(2, "0"),
    s: String(s).padStart(2, "0"),
  };
}

export default function ActiveTimer({
  activeEntry,
  selectedCustomerId,
  selectedProjectId,
}: ActiveTimerProps) {
  const [elapsed, setElapsed] = useState(0);
  const [showQuickBreaks, setShowQuickBreaks] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const startTimer = useMutation({
    mutationFn: createTimeEntry,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/time-entries"] });
      toast({ title: "Timer started", description: "A new line has been entered." });
    },
  });

  const stopTimer = useMutation({
    mutationFn: updateTimeEntry,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/time-entries"] });
      toast({ title: "Timer stopped", description: "Entry closed in the ledger." });
    },
  });

  useEffect(() => {
    if (!activeEntry) {
      setElapsed(0);
      return;
    }
    const tick = () => {
      const start = new Date(activeEntry.checkIn).getTime();
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeEntry]);

  const { h, m, s } = splitElapsed(elapsed);

  const handleStart = () =>
    startTimer.mutate({
      isBreak: false,
      customerId: selectedCustomerId ? parseInt(selectedCustomerId) : undefined,
      projectId: selectedProjectId ? parseInt(selectedProjectId) : undefined,
    });
  const handleStop = () =>
    activeEntry &&
    stopTimer.mutate({ id: activeEntry.id, checkOut: new Date().toISOString() });

  /**
   * Click on a quick-break tile.
   * If a timer is running (work or break), close it first, then start the
   * new break. Everything happens on the current ledger — the user never
   * has two overlapping entries.
   */
  const switchToBreak = async (note: string) => {
    try {
      if (activeEntry) {
        await stopTimer.mutateAsync({
          id: activeEntry.id,
          checkOut: new Date().toISOString(),
        });
      }
      await startTimer.mutateAsync({ isBreak: true, notes: note });
    } catch {
      // mutation `onError` fallback — but neither path logs it right now,
      // so surface a single toast here.
      toast({ title: "Could not switch to break", variant: "destructive" });
    }
  };

  const isRunning = !!activeEntry;
  const isBreak = activeEntry?.isBreak;

  // sweeping second hand angle (0-360)
  const sweepDeg = (elapsed % 60) * 6;

  return (
    <section className="relative">
      <div className="flex flex-col items-center">
        <span className="eyebrow text-[10px] mb-3 text-vermilion">
          {isRunning
            ? isBreak
              ? "On recess"
              : "In progress"
            : "Ready to commence"}
        </span>

        {/* Chronograph dial */}
        <div className="relative w-[260px] h-[260px] sm:w-[320px] sm:h-[320px] flex items-center justify-center animate-ink-fade-in">
          <div className="absolute inset-0 rounded-full border border-ink/90" />
          <div className="absolute inset-[6px] rounded-full border border-rule" />
          <div className="absolute inset-[14px] rounded-full chrono-ticks" />

          {isRunning && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                transform: `rotate(${sweepDeg}deg)`,
                transition: "transform 0.95s cubic-bezier(0.4, 2, 0.6, 1)",
              }}
            >
              <div className="absolute left-1/2 top-[14px] -translate-x-1/2 w-[1.5px] h-[22px] bg-vermilion" />
            </div>
          )}

          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-vermilion shadow-[0_0_0_3px_hsl(var(--parchment))]" />

          <div className="relative z-10 text-center pb-6 sm:pb-10">
            <div className="flex items-baseline justify-center gap-0">
              <span className="font-numeric text-[44px] sm:text-[56px] font-medium tabular-nums leading-none">
                {h}
              </span>
              <span
                className={cn(
                  "font-numeric text-[44px] sm:text-[56px] font-medium leading-none px-0.5",
                  isRunning ? "animate-tick-pulse text-vermilion" : "text-ink/40"
                )}
              >
                :
              </span>
              <span className="font-numeric text-[44px] sm:text-[56px] font-medium tabular-nums leading-none">
                {m}
              </span>
              <span
                className={cn(
                  "font-numeric text-[44px] sm:text-[56px] font-medium leading-none px-0.5",
                  isRunning ? "animate-tick-pulse text-vermilion" : "text-ink/40"
                )}
              >
                :
              </span>
              <span className="font-numeric text-[44px] sm:text-[56px] font-medium tabular-nums leading-none">
                {s}
              </span>
            </div>
            <div className="mt-2 text-[10px] eyebrow text-ink-muted">
              HRS &nbsp;·&nbsp; MIN &nbsp;·&nbsp; SEC
            </div>
          </div>

          <div className="absolute bottom-[22%] left-0 right-0 text-center px-10">
            <div className="font-display italic text-[11px] text-ink-muted tracking-wide truncate">
              {isBreak
                ? activeEntry?.notes
                  ? `— ${activeEntry.notes} —`
                  : "recess chronograph"
                : "work chronograph"}
            </div>
          </div>
        </div>

        {/* ACTION ROW */}
        <div className="mt-6 sm:mt-8 w-full max-w-md">
          {!isRunning ? (
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Button
                size="lg"
                onClick={handleStart}
                disabled={startTimer.isPending}
                className="h-14 rounded-sm font-display text-base tracking-tight uppercase bg-ink text-parchment hover:bg-vermilion hover:text-parchment transition-colors"
              >
                <Play className="h-4 w-4 mr-2" strokeWidth={2.5} />
                Begin Session
              </Button>
              <BreakMenu disabled={startTimer.isPending} />
            </div>
          ) : (
            <Button
              size="lg"
              onClick={handleStop}
              disabled={stopTimer.isPending}
              className="w-full h-14 rounded-sm font-display text-base tracking-tight uppercase bg-vermilion text-parchment hover:bg-ink hover:text-parchment transition-colors"
            >
              <Square className="h-4 w-4 mr-2" strokeWidth={2.5} />
              Close Entry
            </Button>
          )}

          {/* ============ QUICK-SWITCH TO BREAK ============ */}
          <div className="mt-4 pt-4 border-t border-rule">
            <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
              <div>
                <div className="eyebrow">Quick switch to break</div>
                <div className="font-display italic text-[11px] text-ink-muted mt-0.5">
                  {isRunning && !isBreak
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

            {/* Tile grid — animated in/out */}
            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
                showQuickBreaks
                  ? "grid-rows-[1fr] opacity-100"
                  : "grid-rows-[0fr] opacity-0"
              )}
              aria-hidden={!showQuickBreaks}
            >
              <div className="overflow-hidden">
                <div className="grid grid-cols-5 sm:grid-cols-5 gap-2 mt-3">
                  {BUILTIN_BREAKS.map((b) => {
                    const Icon = iconFor(b.icon);
                    const busy = startTimer.isPending || stopTimer.isPending;
                    return (
                      <button
                        key={b.icon}
                        onClick={() => switchToBreak(b.note)}
                        disabled={busy}
                        className="paper-flat flex flex-col items-center gap-1 py-3 px-1 hover:border-ink/50 hover:bg-parchment-deep focus-ink transition-colors disabled:opacity-50"
                      >
                        <Icon
                          className="h-5 w-5 text-ink"
                          strokeWidth={1.5}
                        />
                        <span className="font-display italic text-[11px] text-ink leading-tight">
                          {b.name}
                        </span>
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
