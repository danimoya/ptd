// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { Form, QuietButton } from "./chrome";

/* ─────────────────────────────────────────────────────────────────────────
 * Glimpse III — the cascade.
 *
 * Push the first card later and watch everything that waits on it move with
 * it. Same arithmetic the timeline runs when a bar is dragged: a card starts
 * on its own date, or the day its last dependency ends — whichever is later.
 * ───────────────────────────────────────────────────────────────────────── */

export interface CascadeTask {
  id: string;
  title: string;
  stream: string;
  base: number; // baseline start, in days from the left edge of the window
  days: number;
  score: number;
  deps: string[];
}

export const TASKS: CascadeTask[] = [
  { id: "SEC-1", title: "Rotate the leaked API keys", stream: "Security audit", base: 0, days: 2, score: 100, deps: [] },
  { id: "SEC-2", title: "Pin TLS 1.3 + PQC hybrid", stream: "Security audit", base: 2, days: 3, score: 32, deps: ["SEC-1"] },
  { id: "API-1", title: "Generate the OpenAPI spec", stream: "API v2", base: 5, days: 2, score: 28, deps: ["SEC-2"] },
  { id: "API-2", title: "Deprecation headers on v1", stream: "API v2", base: 5, days: 3, score: 24, deps: ["SEC-2"] },
  { id: "WEB-1", title: "CSRF tokens on every form", stream: "Web", base: 7, days: 2, score: 21, deps: ["API-1"] },
  { id: "REL-1", title: "v2 launch checklist", stream: "Release", base: 10, days: 1, score: 23, deps: ["API-2", "WEB-1"] },
];

export const ROOT_ID = TASKS[0].id;
export const WINDOW_DAYS = 16;
export const MAX_SLIP = 5;

/** Day 0 of the window. Labels are rendered from this. */
const DAY_ZERO = new Date(2026, 8, 14); // 14 September 2026

export function dayLabel(day: number): string {
  const d = new Date(DAY_ZERO);
  d.setDate(d.getDate() + day);
  return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`;
}

export interface Placed {
  start: number;
  end: number;
  delta: number;
}

/**
 * Forward pass over the dependency graph. The root takes the slip; everything
 * downstream takes whatever it must to stay behind its dependencies.
 */
export function schedule(slip: number, tasks: CascadeTask[] = TASKS): Record<string, Placed> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: Record<string, Placed> = {};

  const place = (id: string): Placed => {
    const cached = out[id];
    if (cached) return cached;
    const task = byId.get(id)!;
    const own = task.base + (id === ROOT_ID ? slip : 0);
    const afterDeps = task.deps.reduce((latest, dep) => Math.max(latest, place(dep).end), 0);
    const start = Math.max(own, afterDeps);
    const placed = { start, end: start + task.days, delta: start - task.base };
    out[id] = placed;
    return placed;
  };

  tasks.forEach((t) => place(t.id));
  return out;
}

/** How many cards move, and by how much the last one lands late. */
export function slipPreview(slip: number, tasks: CascadeTask[] = TASKS) {
  const placed = schedule(slip, tasks);
  const moved = tasks.filter((t) => placed[t.id].delta > 0);
  const last = tasks.reduce((a, b) => (placed[a.id].end >= placed[b.id].end ? a : b));
  return {
    moved: moved.length,
    dependents: moved.filter((t) => t.id !== ROOT_ID).length,
    last,
    lastStart: placed[last.id].start,
    lastDelta: placed[last.id].delta,
  };
}

/** Longest path from a root — the indent level in the tree rendering. */
export function depthOf(id: string, tasks: CascadeTask[] = TASKS): number {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const walk = (cur: string): number => {
    const t = byId.get(cur)!;
    if (!t.deps.length) return 0;
    return 1 + Math.max(...t.deps.map(walk));
  };
  return walk(id);
}

type OrderKey = "start" | "priority" | "stream";
type SubOrderKey = "duration" | "title";

export function orderTasks(
  tasks: CascadeTask[],
  placed: Record<string, Placed>,
  order: OrderKey,
  sub: SubOrderKey
): CascadeTask[] {
  const primary = (t: CascadeTask) =>
    order === "start" ? placed[t.id].start : order === "priority" ? -t.score : 0;
  return [...tasks].sort((a, b) => {
    const depth = depthOf(a.id) - depthOf(b.id);
    if (depth !== 0) return depth;
    if (order === "stream" && a.stream !== b.stream) return a.stream.localeCompare(b.stream);
    const p = primary(a) - primary(b);
    if (p !== 0) return p;
    return sub === "duration" ? a.days - b.days : a.title.localeCompare(b.title);
  });
}

export default function CascadeGlimpse({ className }: { className?: string }) {
  const [slip, setSlip] = useState(0);
  const [view, setView] = useState<"timeline" | "tree">("timeline");
  const [order, setOrder] = useState<OrderKey>("start");
  const [sub, setSub] = useState<SubOrderKey>("duration");

  const placed = schedule(slip);
  const preview = slipPreview(slip);
  const root = TASKS[0];

  return (
    <Form
      title={view === "timeline" ? "Timeline" : "Cascade mode"}
      meta={`${TASKS.length} cards · 4 streams`}
      className={className}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule pb-4">
        <span className="eyebrow">Slip {root.id} by</span>
        <div className="flex items-stretch border border-rule">
          <button
            type="button"
            aria-label="One day less"
            disabled={slip === 0}
            onClick={() => setSlip((s) => Math.max(0, s - 1))}
            className="focus-ink px-2.5 font-numeric text-sm text-ink-muted hover:text-ink disabled:opacity-35"
          >
            −
          </button>
          <span className="font-numeric min-w-[4.5rem] border-x border-rule px-2 py-1.5 text-center text-[11px] tabular-nums text-ink">
            {slip} {slip === 1 ? "day" : "days"}
          </span>
          <button
            type="button"
            aria-label="One day more"
            disabled={slip === MAX_SLIP}
            onClick={() => setSlip((s) => Math.min(MAX_SLIP, s + 1))}
            className="focus-ink px-2.5 font-numeric text-sm text-ink-muted hover:text-ink disabled:opacity-35"
          >
            +
          </button>
        </div>

        <div className="ml-auto flex gap-1">
          <QuietButton active={view === "timeline"} onClick={() => setView("timeline")}>
            Timeline
          </QuietButton>
          <QuietButton active={view === "tree"} onClick={() => setView("tree")}>
            Tree
          </QuietButton>
        </div>
      </div>

      <p
        aria-live="polite"
        className={cn(
          "font-numeric border-b border-rule py-3 text-[11px] leading-relaxed",
          slip ? "text-ink" : "text-ink-muted"
        )}
      >
        {slip === 0 ? (
          <>Nothing has moved. Push the root and the dependants follow.</>
        ) : (
          <>
            {preview.dependents} dependant{preview.dependents === 1 ? "" : "s"} move ·{" "}
            <span className="text-vermilion">{preview.last.title}</span> lands {dayLabel(preview.lastStart)} instead of{" "}
            {dayLabel(preview.last.base)}
            {preview.lastDelta > 0 ? ` · +${preview.lastDelta}d` : " · unchanged"}
          </>
        )}
      </p>

      {view === "timeline" ? (
        <Timeline placed={placed} slip={slip} />
      ) : (
        <Tree placed={placed} order={order} sub={sub} setOrder={setOrder} setSub={setSub} />
      )}
    </Form>
  );
}

function Timeline({ placed, slip }: { placed: Record<string, Placed>; slip: number }) {
  const pct = (n: number) => `${(n / WINDOW_DAYS) * 100}%`;
  return (
    <div className="pt-4">
      <div className="relative mb-2 hidden h-4 sm:ml-[13rem] sm:block">
        {[0, 4, 8, 12].map((d) => (
          <span
            key={d}
            style={{ left: pct(d) }}
            className="font-numeric absolute top-0 text-[10px] tabular-nums text-ink-muted"
          >
            {dayLabel(d)}
          </span>
        ))}
      </div>

      <ul className="space-y-3">
        {TASKS.map((t) => {
          const p = placed[t.id];
          const moved = p.delta > 0;
          return (
            <li key={t.id} className="sm:grid sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-center sm:gap-4">
              <div className="flex items-baseline justify-between gap-2 sm:block">
                <span className="text-[0.9rem] leading-tight text-ink">{t.title}</span>
                <span className="font-numeric block whitespace-nowrap text-[10px] text-ink-muted">
                  {t.id} · {t.stream}
                </span>
              </div>
              <div className="relative mt-1.5 h-7 border border-rule bg-parchment-deep/40 sm:mt-0">
                <div
                  aria-hidden="true"
                  className="absolute inset-0"
                  style={{
                    backgroundImage: `repeating-linear-gradient(to right, hsl(var(--rule)) 0 1px, transparent 1px ${100 / WINDOW_DAYS}%)`,
                  }}
                />
                <div
                  data-testid={`bar-${t.id}`}
                  data-start={p.start}
                  className={cn(
                    "absolute inset-y-0 flex items-center overflow-hidden px-1.5 transition-[left] duration-500 ease-out",
                    moved ? "bg-vermilion text-parchment" : "bg-ink text-parchment"
                  )}
                  style={{ left: pct(p.start), width: pct(t.days) }}
                >
                  <span className="font-numeric truncate text-[10px] tabular-nums">
                    {t.days}d{moved && t.days >= 2 ? ` +${p.delta}` : ""}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="font-numeric mt-4 border-t border-rule pt-2 text-[10px] leading-relaxed text-ink-muted">
        {slip > 0
          ? "Filled vermilion: the card had to move. Dependency dates are recomputed, not redrawn by hand."
          : "Drag a bar in the app and this is what happens to everything behind it."}
      </p>
    </div>
  );
}

function Tree({
  placed,
  order,
  sub,
  setOrder,
  setSub,
}: {
  placed: Record<string, Placed>;
  order: OrderKey;
  sub: SubOrderKey;
  setOrder: (k: OrderKey) => void;
  setSub: (k: SubOrderKey) => void;
}) {
  const ordered = orderTasks(TASKS, placed, order, sub);
  return (
    <div className="pt-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-4">
        <label className="font-numeric flex items-center gap-2 text-[11px] text-ink-muted">
          Order by
          <select
            value={order}
            aria-label="Order by"
            onChange={(e) => setOrder(e.target.value as OrderKey)}
            className="focus-ink border border-rule bg-parchment px-2 py-1 font-numeric text-[11px] text-ink"
          >
            <option value="start">start date</option>
            <option value="priority">priority</option>
            <option value="stream">stream</option>
          </select>
        </label>
        <label className="font-numeric flex items-center gap-2 text-[11px] text-ink-muted">
          Then by
          <select
            value={sub}
            aria-label="Then by"
            onChange={(e) => setSub(e.target.value as SubOrderKey)}
            className="focus-ink border border-rule bg-parchment px-2 py-1 font-numeric text-[11px] text-ink"
          >
            <option value="duration">duration</option>
            <option value="title">title</option>
          </select>
        </label>
      </div>

      <ol className="divide-y divide-rule border-y border-rule">
        {ordered.map((t) => {
          const p = placed[t.id];
          const depth = depthOf(t.id);
          return (
            <li
              key={t.id}
              data-testid={`tree-${t.id}`}
              className="flex items-baseline gap-2 py-2"
              style={{ paddingLeft: `${depth * 1.1}rem` }}
            >
              {depth > 0 && <span className="font-numeric text-[11px] text-rule">└</span>}
              <span className="font-numeric shrink-0 text-[10px] text-ink-muted">{t.id}</span>
              <span className="min-w-0 flex-1 truncate text-[0.9rem] text-ink">{t.title}</span>
              <span className="font-numeric shrink-0 text-[10px] tabular-nums text-ink-muted">
                {dayLabel(p.start)}
              </span>
              <span
                className={cn(
                  "font-numeric w-9 shrink-0 text-right text-[10px] tabular-nums",
                  p.delta > 0 ? "text-vermilion" : "text-ink-muted/60"
                )}
              >
                {p.delta > 0 ? `+${p.delta}d` : "—"}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
