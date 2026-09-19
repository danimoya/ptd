import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A working, reduced chronograph for the landing sheet.
 *
 * It is the real timer's dial and vocabulary at a quarter of the size, but it
 * talks to nobody: every line lives in this browser under STORAGE_KEY, so a
 * visitor can start the clock without an account and find their ledger still
 * standing when they come back. A running session is stored as the instant it
 * began rather than as a tally, so it keeps counting across a reload exactly
 * as the real one does.
 *
 * Storage is localStorage rather than a cookie: it is per-browser and survives
 * between visits the same way, but it is never attached to a request, so a
 * visitor's trial ledger never reaches the server.
 */

const STORAGE_KEY = "ttm.demo.chronograph.v1";
const MAX_ENTRIES = 24;

interface LedgerEntry {
  id: string;
  /** Epoch ms the session opened. */
  startedAt: number;
  /** Closed duration in whole seconds. */
  seconds: number;
}

interface DemoState {
  entries: LedgerEntry[];
  /** Epoch ms of the open session, or null when the clock is at rest. */
  runningSince: number | null;
}

const EMPTY: DemoState = { entries: [], runningSince: null };

/* ── Persistence ─────────────────────────────────────────────────────── */

function readState(): DemoState {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<DemoState>;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter(
          (e): e is LedgerEntry =>
            !!e &&
            typeof e.id === "string" &&
            Number.isFinite(e.startedAt) &&
            Number.isFinite(e.seconds)
        )
      : [];
    const runningSince =
      typeof parsed.runningSince === "number" && Number.isFinite(parsed.runningSince)
        ? parsed.runningSince
        : null;
    return { entries: entries.slice(0, MAX_ENTRIES), runningSince };
  } catch {
    // Private browsing, blocked site data, or corrupt JSON. The demo still
    // works, it just starts from nothing.
    return EMPTY;
  }
}

function writeState(state: DemoState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* nothing to do — the in-memory state stays correct for this visit */
  }
}

/* ── Formatting ──────────────────────────────────────────────────────── */

function split(totalSec: number) {
  const s = Math.max(0, Math.floor(totalSec));
  return {
    h: String(Math.floor(s / 3600)).padStart(2, "0"),
    m: String(Math.floor((s % 3600) / 60)).padStart(2, "0"),
    s: String(s % 60).padStart(2, "0"),
  };
}

/** Compact ledger duration: "42s", "7m 05s", "1h 12m". */
function durationLabel(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

function clockLabel(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayLabel(epochMs: number): string {
  const then = new Date(epochMs);
  const today = new Date();
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  if (sameDay) return "today";
  return then.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

/* ── Component ───────────────────────────────────────────────────────── */

export function DemoChronograph({ className }: { className?: string }) {
  const [state, setState] = useState<DemoState>(EMPTY);
  const [hydrated, setHydrated] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const confirmTimer = useRef<number | null>(null);

  // Read once on mount rather than in useState's initialiser, so the first
  // paint matches for everyone and a blocked localStorage cannot throw during
  // render.
  useEffect(() => {
    setState(readState());
    setHydrated(true);
  }, []);

  const running = state.runningSince !== null;

  // Only tick while something is actually running.
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    };
  }, []);

  const persist = useCallback((next: DemoState) => {
    setState(next);
    writeState(next);
  }, []);

  const elapsed = running
    ? Math.max(0, Math.floor((now - (state.runningSince as number)) / 1000))
    : 0;

  const ledgerSeconds = useMemo(
    () => state.entries.reduce((sum, e) => sum + e.seconds, 0),
    [state.entries]
  );
  const totalSeconds = ledgerSeconds + elapsed;

  const start = () => {
    setConfirmingReset(false);
    const at = Date.now();
    setNow(at);
    persist({ ...state, runningSince: at });
    setAnnouncement("Session started.");
  };

  const stop = () => {
    if (state.runningSince === null) return;
    const startedAt = state.runningSince;
    const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    const entry: LedgerEntry = {
      id: `${startedAt}-${seconds}`,
      startedAt,
      seconds,
    };
    persist({
      entries: [entry, ...state.entries].slice(0, MAX_ENTRIES),
      runningSince: null,
    });
    setAnnouncement(`Entry closed at ${durationLabel(seconds)}.`);
  };

  const requestReset = () => {
    setConfirmingReset(true);
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    // Let the confirmation lapse rather than leaving a destructive control
    // armed on the page indefinitely.
    confirmTimer.current = window.setTimeout(() => setConfirmingReset(false), 6000);
  };

  const confirmReset = () => {
    setConfirmingReset(false);
    persist(EMPTY);
    setAnnouncement("Ledger cleared.");
  };

  const { h, m, s } = split(elapsed);
  const sweepDeg = (elapsed % 60) * 6;
  const lineCount = state.entries.length;

  return (
    <figure className={cn("m-0", className)}>
      <div className="paper-flat">
        <div className="grid sm:grid-cols-[auto_1fr]">
          {/* ── Dial + action ── */}
          <div className="flex flex-col items-center gap-3 p-5 border-b sm:border-b-0 sm:border-r border-rule">
            <span
              className={cn(
                "eyebrow text-[10px]",
                running ? "!text-vermilion" : "!text-ink-muted"
              )}
            >
              {running ? "In progress" : "Ready to commence"}
            </span>

            <div className="relative w-[132px] h-[132px] flex items-center justify-center">
              <div className="absolute inset-0 rounded-full border border-ink/90" />
              <div className="absolute inset-[5px] rounded-full border border-rule" />
              <div
                aria-hidden
                className="absolute inset-[11px] rounded-full chrono-ticks"
                style={{
                  // The shared .chrono-ticks class uses conic-gradient, which
                  // does not repeat: its stops end at 6deg and everything past
                  // that holds the last colour, so exactly one tick is drawn.
                  // repeating-conic-gradient gives the full ring of 60. Also
                  // redrawn in ink, since --rule does not register at this
                  // diameter. (The same bug is in the class itself, which the
                  // full-size timer uses.)
                  backgroundImage:
                    "repeating-conic-gradient(from 0deg, hsl(var(--ink) / 0.42) 0 1.6deg, transparent 1.6deg 6deg)",
                  maskImage:
                    "radial-gradient(closest-side, transparent 0 calc(100% - 7px), #000 calc(100% - 7px) calc(100% - 1px), transparent calc(100% - 1px))",
                  WebkitMaskImage:
                    "radial-gradient(closest-side, transparent 0 calc(100% - 7px), #000 calc(100% - 7px) calc(100% - 1px), transparent calc(100% - 1px))",
                }}
              />

              {running && (
                <div
                  className="absolute inset-0 pointer-events-none motion-safe:transition-transform motion-safe:duration-[950ms]"
                  style={{
                    transform: `rotate(${sweepDeg}deg)`,
                    transitionTimingFunction: "cubic-bezier(0.4, 2, 0.6, 1)",
                  }}
                >
                  <div className="absolute left-1/2 top-[11px] -translate-x-1/2 w-px h-[12px] bg-vermilion" />
                </div>
              )}

              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-vermilion shadow-[0_0_0_2px_hsl(var(--parchment))]" />

              <div
                role="timer"
                aria-live="off"
                aria-label={`Elapsed ${h} hours ${m} minutes ${s} seconds`}
                className="relative z-10 flex items-baseline justify-center"
              >
                <span className="font-numeric text-[17px] font-medium tabular-nums leading-none">
                  {h}
                </span>
                <span
                  className={cn(
                    "font-numeric text-[17px] font-medium leading-none px-px",
                    running
                      ? "motion-safe:animate-tick-pulse text-vermilion"
                      : "text-ink/40"
                  )}
                >
                  :
                </span>
                <span className="font-numeric text-[17px] font-medium tabular-nums leading-none">
                  {m}
                </span>
                <span
                  className={cn(
                    "font-numeric text-[17px] font-medium leading-none px-px",
                    running
                      ? "motion-safe:animate-tick-pulse text-vermilion"
                      : "text-ink/40"
                  )}
                >
                  :
                </span>
                <span className="font-numeric text-[17px] font-medium tabular-nums leading-none">
                  {s}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={running ? stop : start}
              className={cn(
                "w-full max-w-[184px] h-10 rounded-sm font-display text-sm tracking-tight uppercase",
                "inline-flex items-center justify-center gap-2 transition-colors focus-ink",
                running
                  ? "bg-vermilion text-parchment hover:bg-ink"
                  : "bg-ink text-parchment hover:bg-vermilion"
              )}
            >
              {running ? (
                <>
                  <Square className="h-3.5 w-3.5" strokeWidth={2.5} />
                  Close entry
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" strokeWidth={2.5} />
                  Begin session
                </>
              )}
            </button>
          </div>

          {/* ── Ledger ── */}
          <div className="flex flex-col min-w-0">
            <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 border-b border-rule">
              <span className="eyebrow text-[10px]">Your ledger</span>
              <span className="font-numeric text-xs tabular-nums text-ink">
                {durationLabel(totalSeconds)}
              </span>
            </div>

            <div className="flex-1 min-h-[104px] max-h-[148px] overflow-y-auto">
              {!hydrated ? null : lineCount === 0 && !running ? (
                <p className="px-4 py-5 text-[13px] text-ink-muted leading-relaxed">
                  Nothing logged yet. Start the clock and the first line appears
                  here.
                </p>
              ) : (
                <ul>
                  {running && (
                    <li className="flex items-baseline justify-between gap-3 px-4 py-2 border-b border-rule/60">
                      <span className="font-display italic text-[13px] text-vermilion truncate">
                        running since {clockLabel(state.runningSince as number)}
                      </span>
                      <span className="font-numeric text-xs tabular-nums text-vermilion shrink-0">
                        {durationLabel(elapsed)}
                      </span>
                    </li>
                  )}
                  {state.entries.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-baseline justify-between gap-3 px-4 py-2 border-b border-rule/60 last:border-b-0"
                    >
                      <span className="font-display italic text-[13px] text-ink-muted truncate">
                        {dayLabel(e.startedAt)} at {clockLabel(e.startedAt)}
                      </span>
                      <span className="font-numeric text-xs tabular-nums text-ink shrink-0">
                        {durationLabel(e.seconds)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-rule">
              <span className="font-numeric text-[11px] text-ink-muted tabular-nums">
                {lineCount === 0
                  ? running
                    ? "1 open"
                    : "no lines"
                  : `${lineCount} line${lineCount === 1 ? "" : "s"}${
                      running ? " + 1 open" : ""
                    }`}
              </span>

              {lineCount === 0 && !running ? null : confirmingReset ? (
                <span className="flex items-center gap-2 text-[11px]">
                  <span className="text-ink-muted">Clear everything?</span>
                  <button
                    type="button"
                    onClick={confirmReset}
                    className="font-numeric uppercase tracking-wider text-vermilion hover:underline focus-ink"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingReset(false)}
                    className="font-numeric uppercase tracking-wider text-ink-muted hover:underline focus-ink"
                  >
                    No
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={requestReset}
                  className="font-numeric text-[11px] uppercase tracking-wider text-ink-muted hover:text-vermilion transition-colors focus-ink"
                >
                  Clear the ledger
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <figcaption className="mt-3 text-sm text-ink-muted max-w-md text-pretty">
        A working timer, no account needed. It keeps its ledger in this browser
        only, so nothing is sent anywhere and it will still be here when you
        come back.
      </figcaption>
    </figure>
  );
}
