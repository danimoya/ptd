import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { Crosshair, Network, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MemberRow } from "@/lib/api";
import { dayOf, pad4, priorityBand, sourceOf, type SlipRow } from "./logic";
import { NODE_H, NODE_W, edgePath, ellipsize, layoutGraph, type GraphNode } from "./graphLayout";
import { floatExplainer, type CpIndex } from "./criticalPath";
import type { CascadeGroup, CascadeOrder, PlanApp, PlanStream, PlanTask } from "./types";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.4;
const FIT_ZOOM_CAP = 1.15;
const PAN_STEP = 56;

interface DependencyGraphProps {
  /** The cards to draw — the Cascade view passes the open ones. */
  tasks: PlanTask[];
  streams: PlanStream[];
  apps: PlanApp[];
  members: MemberRow[];
  order: CascadeOrder;
  /** null draws the plain DAG; a group turns the sub-order into horizontal bands. */
  group: CascadeGroup | null;
  /** Rows the slip preview would move, keyed by task id. */
  slip: Map<number, SlipRow>;
  critical: CpIndex;
  onOpen: (task: PlanTask) => void;
}

interface View {
  x: number;
  y: number;
  k: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** True while the OS asks for less motion. Read once per mount, then followed live. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let query: MediaQueryList | undefined;
    try {
      query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    if (!query?.addEventListener) return;
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query?.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** The status a card is in, as a stroke around its box. */
function statusStroke(status: string): { className: string; width: number; dash?: string; opacity: number } {
  switch (status) {
    case "in-progress":
      return { className: "text-ink", width: 1.7, opacity: 1 };
    case "triaged":
      return { className: "text-ink", width: 1, opacity: 0.75 };
    case "wontfix":
      return { className: "text-ink-muted", width: 1, dash: "2 3", opacity: 0.9 };
    case "completed":
      return { className: "text-ink-muted", width: 1, dash: "1 3", opacity: 0.8 };
    default:
      return { className: "text-ink-muted", width: 1, opacity: 0.9 };
  }
}

/**
 * Cascade mode's second rendering: the dependency graph as a layered DAG,
 * drawn straight into SVG.
 *
 * The layout is `graphLayout.ts` (longest-path layering, barycentre ordering);
 * everything here is the drawing and the handling — pan by dragging the paper,
 * zoom on the wheel or the buttons, arrows/±/0 from the keyboard, hover to light
 * up a card's upstream and downstream cones, click to open the card's dialog.
 * The critical path comes from the server via `critical`, never from a second
 * local computation, and the slip preview is the same `SlipRow` map the tree
 * rendering uses, so the two agree card for card.
 */
export function DependencyGraph({ tasks, streams, apps, members, order, group, slip, critical, onOpen }: DependencyGraphProps) {
  const rawId = useId();
  const uid = useMemo(() => rawId.replace(/[^a-zA-Z0-9_-]/g, ""), [rawId]);
  const reducedMotion = usePrefersReducedMotion();

  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<number | null>(null);

  const ctx = useMemo(() => ({ streams, apps, members }), [streams, apps, members]);
  const layout = useMemo(() => layoutGraph(tasks, { order, group, ctx }), [tasks, order, group, ctx]);

  /* ─────────── measuring ─────────── */

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setSize((prev) => {
      const next = { width: host.clientWidth, height: host.clientHeight };
      return prev.width === next.width && prev.height === next.height ? prev : next;
    });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  /* ─────────── pan and zoom ─────────── */

  const fit = useCallback(() => {
    if (!size.width || !size.height || !layout.width || !layout.height) return;
    const k = clamp(Math.min(size.width / layout.width, size.height / layout.height), MIN_ZOOM, FIT_ZOOM_CAP);
    setView({ k, x: (size.width - layout.width * k) / 2, y: (size.height - layout.height * k) / 2 });
  }, [size.width, size.height, layout.width, layout.height]);

  // Re-fit when the drawing or the room it has changes — a new grouping is a new
  // picture, and the user has not panned it yet.
  useEffect(() => fit(), [fit]);

  const zoomAbout = useCallback((factor: number, cx: number, cy: number) => {
    setView((prev) => {
      const k = clamp(prev.k * factor, MIN_ZOOM, MAX_ZOOM);
      if (k === prev.k) return prev;
      const ratio = k / prev.k;
      return { k, x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio };
    });
  }, []);

  const zoomFromCentre = useCallback((factor: number) => zoomAbout(factor, size.width / 2, size.height / 2), [zoomAbout, size.width, size.height]);

  // Wheel has to be a non-passive listener or the browser keeps scrolling the
  // page underneath; React's onWheel cannot promise that.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0016);
      zoomAbout(factor, event.clientX - rect.left, event.clientY - rect.top);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [zoomAbout]);

  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const startPan = (event: React.PointerEvent<SVGRectElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const movePan = (event: React.PointerEvent<SVGRectElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    drag.current = { ...state, x: event.clientX, y: event.clientY };
    setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  };

  const endPan = (event: React.PointerEvent<SVGRectElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const pan = (dx: number, dy: number) => {
      event.preventDefault();
      setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    };
    switch (event.key) {
      case "ArrowLeft":
        return pan(PAN_STEP, 0);
      case "ArrowRight":
        return pan(-PAN_STEP, 0);
      case "ArrowUp":
        return pan(0, PAN_STEP);
      case "ArrowDown":
        return pan(0, -PAN_STEP);
      case "+":
      case "=":
        event.preventDefault();
        return zoomFromCentre(1.2);
      case "-":
      case "_":
        event.preventDefault();
        return zoomFromCentre(1 / 1.2);
      case "0":
        event.preventDefault();
        return fit();
      default:
        return;
    }
  };

  /* ─────────── hover cones ─────────── */

  const related = useMemo(() => {
    if (hover === null) return null;
    const up = layout.upstream.get(hover) ?? new Set<number>();
    const down = layout.downstream.get(hover) ?? new Set<number>();
    return { up, down, all: new Set<number>([hover, ...up, ...down]) };
  }, [hover, layout]);

  const dim = (id: number) => (related ? !related.all.has(id) : false);

  const empty = layout.nodes.length === 0;

  return (
    <div className="relative flex min-h-[460px] flex-1 flex-col sm:min-h-[580px] lg:min-h-[660px]">
      {/* ─────────── canvas ─────────── */}
      <div
        ref={hostRef}
        tabIndex={0}
        role="application"
        aria-label="Dependency graph. Drag to pan, wheel or plus and minus to zoom, 0 to fit, click a card to open it."
        onKeyDown={onKeyDown}
        data-testid="cascade-graph"
        className="nice-scroll relative flex-1 overflow-hidden bg-parchment-deep/30 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vermilion"
        style={{ touchAction: "none", cursor: "grab" }}
      >
        {empty ? (
          <div className="flex h-full items-center justify-center px-6 py-12 text-center">
            <div>
              <Network className="mx-auto mb-3 h-7 w-7 text-ink-muted/60" />
              <div className="font-display text-xl tracking-tight">Nothing to draw.</div>
              <p className="mt-1 font-serif text-sm text-ink-muted">Open cards with dependencies appear here as a graph.</p>
            </div>
          </div>
        ) : (
          <svg width={size.width || "100%"} height={size.height || "100%"} className="block select-none" role="presentation">
            <defs>
              <marker id={`${uid}-arrow`} viewBox="0 0 8 8" refX="7.4" refY="4" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
                <path d="M0.5,0.8 L7.6,4 L0.5,7.2 z" className="text-ink-muted" fill="currentColor" />
              </marker>
              <marker id={`${uid}-arrow-cp`} viewBox="0 0 8 8" refX="7.4" refY="4" markerWidth="4.4" markerHeight="4.4" orient="auto-start-reverse">
                <path d="M0.5,0.8 L7.6,4 L0.5,7.2 z" className="text-vermilion" fill="currentColor" />
              </marker>
            </defs>

            {/* The paper itself: the pan surface. */}
            <rect
              x={0}
              y={0}
              width={size.width || 1}
              height={size.height || 1}
              fill="transparent"
              onPointerDown={startPan}
              onPointerMove={movePan}
              onPointerUp={endPan}
              onPointerCancel={endPan}
            />

            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {/* bands */}
              {group &&
                layout.bands.map((band) => (
                  <g key={band.key}>
                    <rect
                      x={6}
                      y={band.top + 28}
                      width={Math.max(layout.width - 12, NODE_W)}
                      height={band.height}
                      className="text-ink-muted"
                      fill="currentColor"
                      fillOpacity={band.index % 2 === 0 ? 0.05 : 0.02}
                      stroke="currentColor"
                      strokeOpacity={0.18}
                      strokeWidth={0.75}
                    />
                    <text x={18} y={band.top + 47} className="fill-ink font-mono" fontSize={10.5} letterSpacing="0.14em">
                      {band.label.toUpperCase()}
                    </text>
                    <text x={18} y={band.top + 47} dx={band.label.length * 7.6 + 14} className="fill-ink-muted font-mono" fontSize={9.5}>
                      {band.count}
                    </text>
                  </g>
                ))}

              {/* edges under the cards, so a long edge reads as passing behind them */}
              {layout.edges.map((edge) => {
                const isCritical = critical.isCriticalEdge(edge.fromId, edge.toId);
                const inCone =
                  related !== null &&
                  ((edge.fromId === hover && related.down.has(edge.toId)) ||
                    (edge.toId === hover && related.up.has(edge.fromId)) ||
                    (related.up.has(edge.fromId) && (related.up.has(edge.toId) || edge.toId === hover)) ||
                    (related.down.has(edge.toId) && (related.down.has(edge.fromId) || edge.fromId === hover)));
                const faded = related !== null && !inCone;
                return (
                  <path
                    key={edge.key}
                    d={edgePath(edge)}
                    fill="none"
                    className={cn(isCritical ? "text-vermilion" : "text-ink-muted", !reducedMotion && "transition-opacity duration-150")}
                    stroke="currentColor"
                    strokeWidth={isCritical ? 2.4 : inCone ? 1.6 : 1.1}
                    strokeOpacity={faded ? 0.12 : isCritical ? 0.95 : inCone ? 0.85 : 0.5}
                    strokeDasharray={edge.span > 1 && !isCritical ? "6 3" : undefined}
                    markerEnd={`url(#${uid}-arrow${isCritical ? "-cp" : ""})`}
                  />
                );
              })}

              {/* cards */}
              {layout.nodes.map((node) => (
                <GraphCard
                  key={node.task.id}
                  node={node}
                  members={members}
                  onCriticalPath={critical.onPath(node.task.id)}
                  floatDays={critical.floatOf(node.task.id)}
                  slip={slip.get(node.task.id)}
                  dimmed={dim(node.task.id)}
                  focused={hover === node.task.id}
                  reducedMotion={reducedMotion}
                  onHover={setHover}
                  onOpen={onOpen}
                />
              ))}
            </g>
          </svg>
        )}

        {/* ─────────── zoom controls ─────────── */}
        {!empty && (
          <div className="absolute right-2 top-2 flex items-center gap-1 border border-rule bg-card/95 px-1 py-1 shadow-stamp">
            <button
              type="button"
              onClick={() => zoomFromCentre(1 / 1.2)}
              title="Zoom out (−)"
              aria-label="Zoom out"
              className="flex h-6 w-6 items-center justify-center transition-colors hover:bg-ink hover:!text-parchment focus-ink"
            >
              <ZoomOut className="h-3 w-3" />
            </button>
            <span className="w-10 text-center font-mono text-[10px] tabular-nums text-ink-muted" data-testid="cascade-graph-zoom">
              {Math.round(view.k * 100)}%
            </span>
            <button
              type="button"
              onClick={() => zoomFromCentre(1.2)}
              title="Zoom in (+)"
              aria-label="Zoom in"
              className="flex h-6 w-6 items-center justify-center transition-colors hover:bg-ink hover:!text-parchment focus-ink"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={fit}
              title="Fit the whole graph (0)"
              data-testid="cascade-graph-fit"
              className="eyebrow flex h-6 items-center gap-1 border-l border-rule pl-1.5 pr-1 transition-colors hover:bg-ink hover:!text-parchment focus-ink"
            >
              <Crosshair className="h-3 w-3" />
              Fit
            </button>
          </div>
        )}

        {/* ─────────── legend ─────────── */}
        {!empty && (
          <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap items-center gap-x-3 gap-y-1 border border-rule bg-card/90 px-2 py-1">
            <span className="eyebrow">
              {layout.nodes.length} card{layout.nodes.length === 1 ? "" : "s"} · {layout.layerCount} deep · {layout.edges.length} link
              {layout.edges.length === 1 ? "" : "s"}
            </span>
            {critical.ready && (
              <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider2 text-vermilion">
                <span className="inline-block h-0.5 w-4 bg-vermilion" />
                critical path
              </span>
            )}
            {slip.size > 0 && <span className="eyebrow !text-vermilion">{slip.size} card(s) would move</span>}
            <span className="hidden font-mono text-[9px] text-ink-muted sm:inline">drag to pan · wheel to zoom · 0 fits</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One card. Everything is drawn rather than laid out, which is why the geometry
 * is spelled out in numbers: SVG has no box model and no text overflow, so the
 * title is clipped by `ellipsize` against the card's own width.
 */
function GraphCard({
  node,
  members,
  onCriticalPath,
  floatDays,
  slip,
  dimmed,
  focused,
  reducedMotion,
  onHover,
  onOpen,
}: {
  node: GraphNode;
  members: MemberRow[];
  onCriticalPath: boolean;
  floatDays: number | null;
  slip?: SlipRow;
  dimmed: boolean;
  focused: boolean;
  reducedMotion: boolean;
  onHover: (id: number | null) => void;
  onOpen: (task: PlanTask) => void;
}) {
  const task = node.task;
  const band = priorityBand(task.priorityScore);
  const stroke = statusStroke(String(task.status));
  const assignee = members.find((m) => m.userId === task.assignedTo) ?? null;
  const isAgent = assignee ? sourceOf(task, members) === "agent" : false;
  const start = dayOf(task.startDate);
  const end = dayOf(task.end);
  const shifted = slip ? dayOf(slip.startDate) : null;

  const key = task.externalKey ?? `№${pad4(task.id)}`;
  const assigneeLabel = assignee ? assignee.displayName : "unassigned";
  const dates = shifted
    ? `${start ? format(start, "dd MMM") : "—"} → ${format(shifted, "dd MMM")}`
    : start
      ? `${format(start, "dd MMM")}${end ? `–${format(end, "dd MMM")}` : ""}`
      : "unscheduled";

  const tooltip = [
    `${key} · ${task.title}`,
    `${band.label} ${task.priorityScore} · ${task.status}`,
    `${assigneeLabel}${isAgent ? " (agent)" : ""}`,
    shifted ? `Slip preview: starts ${format(shifted, "dd MMM yyyy")}` : dates,
    floatExplainer(floatDays),
  ].join("\n");

  // The date range is right-aligned and the name grows towards it, so the name's
  // room is whatever the dates leave — measured from the string, not guessed.
  const datesRoom = dates.length * 9 * 0.56 + 14;
  const nameRoom = Math.max(30, NODE_W - 20 - (isAgent ? 36 : 0) - datesRoom);

  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${key}: ${task.title}. Priority ${task.priorityScore}. ${onCriticalPath ? "On the critical path. " : ""}Open card`}
      className={cn("cursor-pointer outline-none", !reducedMotion && "transition-opacity duration-150")}
      opacity={dimmed ? 0.22 : 1}
      onClick={() => onOpen(task)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(task);
        }
      }}
      onPointerEnter={() => onHover(task.id)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(task.id)}
      onBlur={() => onHover(null)}
    >
      <title>{tooltip}</title>

      {/* the card */}
      <rect
        width={NODE_W}
        height={NODE_H}
        fill="hsl(var(--card))"
        className={stroke.className}
        stroke="currentColor"
        strokeWidth={focused ? stroke.width + 0.8 : stroke.width}
        strokeOpacity={stroke.opacity}
      />
      {/* the slip preview's dashed outline sits outside the card's own stroke */}
      {slip && (
        <rect
          x={-3}
          y={-3}
          width={NODE_W + 6}
          height={NODE_H + 6}
          fill="none"
          className="text-vermilion"
          stroke="currentColor"
          strokeWidth={1.2}
          strokeDasharray="5 3"
        />
      )}
      {/* on the critical path: the ledger's vermilion rule down the left edge */}
      {onCriticalPath && <rect x={0} y={0} width={3} height={NODE_H} className="text-vermilion" fill="currentColor" />}

      {/* key, CP tag, score chip */}
      <text x={10} y={16} className="fill-ink-muted font-mono" fontSize={9.5} letterSpacing="0.04em">
        {key}
      </text>
      {onCriticalPath && (
        <text x={10} y={16} dx={key.length * 6.2 + 8} className="fill-vermilion font-mono" fontSize={8.5} letterSpacing="0.12em">
          CP
        </text>
      )}
      <g className={band.text}>
        <rect x={NODE_W - 40} y={5} width={31} height={15} fill="none" stroke="currentColor" strokeOpacity={0.7} strokeWidth={0.9} />
        <text x={NODE_W - 24.5} y={16} textAnchor="middle" fill="currentColor" className="font-mono" fontSize={10} fontWeight={600}>
          {task.priorityScore}
        </text>
      </g>

      {/* title */}
      <text x={10} y={35} className="fill-ink font-serif" fontSize={12.5}>
        {ellipsize(task.title, NODE_W - 20, 12.5, 0.48)}
      </text>

      {/* assignee, dates */}
      {isAgent && (
        <g className="text-ink-muted">
          <rect x={10} y={43} width={32} height={11} fill="none" stroke="currentColor" strokeOpacity={0.5} strokeWidth={0.75} />
          <text x={26} y={51.5} textAnchor="middle" fill="currentColor" className="font-mono" fontSize={7} letterSpacing="0.1em">
            AGENT
          </text>
        </g>
      )}
      <text x={isAgent ? 46 : 10} y={52} className="fill-ink-muted font-mono" fontSize={9}>
        {ellipsize(assigneeLabel, nameRoom, 9, 0.56)}
      </text>
      <text
        x={NODE_W - 10}
        y={52}
        textAnchor="end"
        className={cn("font-mono", shifted ? "fill-vermilion" : "fill-ink-muted")}
        fontSize={9}
      >
        {dates}
      </text>
    </g>
  );
}
