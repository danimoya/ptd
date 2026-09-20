import { useEffect, useMemo, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { addDays, differenceInDays, eachDayOfInterval, endOfMonth, format, isSameDay, isWeekend, startOfMonth } from "date-fns";
import { CalendarDays, ChevronLeft, ChevronRight, GanttChartSquare, Layers, Route, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MemberRow } from "@/lib/api";
import { TaskCard } from "./TaskCard";
import { buildLanes, dayOf, packSlots, tasksInWindow } from "./logic";
import { buildCpIndex, floatExplainer, type CpIndex } from "./criticalPath";
import { useCriticalPath } from "./api";
import { usePersistentFlag } from "./usePersistentState";
import type { GroupBy, PlanApp, PlanStream, PlanTask } from "./types";

/** The narrowest a day column is ever drawn — the base unit drags snap to. */
export const DAY_WIDTH = 34;
const ROW_HEIGHT = 44;
const ROW_GAP = 6;
const LANE_LABEL_WIDTH = 168;

export interface BarDrag {
  taskId: number;
  days: number;
}

export interface DropHint {
  laneKey: string;
  dayIndex: number;
  date: Date;
}

interface TimelineProps {
  /** All org tasks — the lanes filter to the visible month themselves. */
  tasks: PlanTask[];
  streams: PlanStream[];
  apps: PlanApp[];
  members: MemberRow[];
  groupBy: GroupBy;
  onGroupByChange: (groupBy: GroupBy) => void;
  viewDate: Date;
  onViewDateChange: (date: Date) => void;
  onOpen: (task: PlanTask) => void;
  onComplete: (task: PlanTask) => void;
  barDrag: BarDrag | null;
  dropHint: DropHint | null;
  /**
   * Reports the day column's measured width back to the board. The grid widens
   * its columns to fill whatever room the full-bleed shell gives it, and the
   * parent's drag maths has to snap to the same unit it can see.
   */
  onDayWidth?: (width: number) => void;
}

/**
 * The Gantt half of the board: one swim-lane per stream (or per assignee), one
 * bar per scheduled card, a month at a time.
 *
 * Drag mechanics live in the parent (Plan.tsx owns the DndContext) so a card can
 * travel between the backlog and this grid. What lives here is the geometry:
 * `DAY_WIDTH` is the unit the parent snaps to, each lane canvas is a drop target
 * carrying its stream/assignee, and the day index of a drop is derived from the
 * lane's own rectangle.
 */
export function Timeline({
  tasks,
  streams,
  apps,
  members,
  groupBy,
  onGroupByChange,
  viewDate,
  onViewDateChange,
  onOpen,
  onComplete,
  barDrag,
  dropHint,
  onDayWidth,
}: TimelineProps) {
  const monthStart = startOfMonth(viewDate);
  const monthEnd = endOfMonth(viewDate);
  const days = useMemo(() => eachDayOfInterval({ start: monthStart, end: monthEnd }), [monthStart.getTime(), monthEnd.getTime()]);

  /**
   * Day columns stretch to fill the scroll port — the shell is full-bleed now, so
   * a month pinned to 34px a day would leave a dead strip on a wide screen (and
   * a very wide one in full screen). Never narrower than DAY_WIDTH, so a phone
   * still scrolls the month horizontally as before.
   */
  const portRef = useRef<HTMLDivElement>(null);
  const [dayWidth, setDayWidth] = useState(DAY_WIDTH);
  useEffect(() => {
    const port = portRef.current;
    if (!port) return;
    const measure = () => {
      const available = port.clientWidth - LANE_LABEL_WIDTH;
      const next = Math.max(DAY_WIDTH, Math.floor(available / days.length));
      setDayWidth((prev) => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(port);
    return () => observer.disconnect();
  }, [days.length]);
  useEffect(() => onDayWidth?.(dayWidth), [dayWidth, onDayWidth]);

  const totalWidth = days.length * dayWidth;
  const today = new Date();
  const todayIndex = days.findIndex((d) => isSameDay(d, today));

  const visible = useMemo(() => tasksInWindow(tasks.filter((t) => !t.completed), monthStart, monthEnd), [tasks, monthStart.getTime(), monthEnd.getTime()]);
  const lanes = useMemo(() => buildLanes(visible, groupBy, streams, members.map((m) => ({ userId: m.userId, displayName: m.displayName, isAgent: m.isAgent }))), [visible, groupBy, streams, members]);

  /**
   * The critical-path overlay: the chain in vermilion, and the float of every
   * bar at its end. Both come from the server's CPM pass (`critical_path`) —
   * the board must not invent a second set of numbers. Off by default and the
   * query only runs while it is on, so a member who cannot call the action
   * (manager+) never trips over a 403 they did not ask for.
   */
  const [showCriticalPath, setShowCriticalPath] = usePersistentFlag("ptd.plan.timeline.criticalPath", false);
  const criticalQuery = useCriticalPath(showCriticalPath);
  const critical = useMemo(() => buildCpIndex(criticalQuery.data), [criticalQuery.data]);
  const criticalOn = showCriticalPath && critical.ready;

  return (
    <div className="flex h-full min-h-[380px] flex-col">
      {/* ─────────── toolbar ─────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rule-b">
        <div className="flex items-center gap-3">
          <div className="flex items-center border border-rule">
            <button onClick={() => onViewDateChange(addDays(monthStart, -1))} aria-label="Previous month" className="flex h-7 w-7 items-center justify-center transition-colors hover:bg-ink hover:text-parchment focus-ink">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button onClick={() => onViewDateChange(new Date())} className="eyebrow h-7 border-x border-rule px-2.5 transition-colors hover:bg-ink hover:text-parchment focus-ink">
              Today
            </button>
            <button onClick={() => onViewDateChange(addDays(monthEnd, 1))} aria-label="Next month" className="flex h-7 w-7 items-center justify-center transition-colors hover:bg-ink hover:text-parchment focus-ink">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-baseline gap-2">
            <CalendarDays className="h-4 w-4 self-center text-ink-muted" />
            <span className="font-display text-2xl leading-none tracking-tight">{format(viewDate, "MMMM")}</span>
            <span className="font-mono text-xs tabular-nums text-ink-muted">{format(viewDate, "yyyy")}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {showCriticalPath && criticalQuery.isError && (
            <span className="eyebrow !text-vermilion" title={(criticalQuery.error as Error | null)?.message ?? undefined}>
              critical path needs manager access
            </span>
          )}
          {criticalOn && (
            <span className="eyebrow hidden md:inline" title={`Longest chain: ${critical.totalDays} day(s) of work`}>
              {critical.count} on the path
              {critical.projectFinish ? ` · ends ${format(dayOf(critical.projectFinish)!, "dd MMM")}` : ""}
            </span>
          )}
          <button
            onClick={() => setShowCriticalPath(!showCriticalPath)}
            aria-pressed={showCriticalPath}
            data-testid="timeline-critical-path"
            title="Outline the critical path and show every bar's float (slack days)"
            className={cn(
              "eyebrow flex h-7 items-center gap-1.5 border border-rule px-2.5 transition-colors focus-ink",
              showCriticalPath ? "border-vermilion bg-vermilion !text-parchment" : "hover:bg-parchment-deep"
            )}
          >
            <Route className="h-3 w-3" />
            <span className="hidden sm:inline">Critical path</span>
            <span className="sm:hidden">CP</span>
          </button>
          <span className="eyebrow hidden sm:inline">Lanes</span>
          <div className="flex items-center border border-rule">
            <button
              onClick={() => onGroupByChange("stream")}
              className={cn("eyebrow flex h-7 items-center gap-1.5 px-2.5 transition-colors focus-ink", groupBy === "stream" ? "bg-ink !text-parchment" : "hover:bg-parchment-deep")}
            >
              <Layers className="h-3 w-3" />
              Stream
            </button>
            <button
              onClick={() => onGroupByChange("assignee")}
              className={cn("eyebrow flex h-7 items-center gap-1.5 border-l border-rule px-2.5 transition-colors focus-ink", groupBy === "assignee" ? "bg-ink !text-parchment" : "hover:bg-parchment-deep")}
            >
              <Users className="h-3 w-3" />
              Assignee
            </button>
          </div>
        </div>
      </div>

      {/* ─────────── grid ─────────── */}
      <div ref={portRef} className="nice-scroll flex-1 overflow-auto bg-parchment-deep/30">
        <div style={{ width: "100%", minWidth: LANE_LABEL_WIDTH + totalWidth }}>
          {/* day strip */}
          <div className="sticky top-0 z-30 grid border-b border-ink bg-card" style={{ gridTemplateColumns: `${LANE_LABEL_WIDTH}px ${totalWidth}px minmax(0, 1fr)` }}>
            <div className="sticky left-0 z-40 flex items-center justify-between border-r border-ink bg-parchment-deep px-3 py-2">
              <span className="eyebrow">Lane</span>
              <span className="font-mono text-[10px] tabular-nums text-ink-muted">{visible.length}</span>
            </div>
            <div className="grid" style={{ gridTemplateColumns: `repeat(${days.length}, ${dayWidth}px)`, width: totalWidth }}>
              {days.map((day) => (
                <div
                  key={day.getTime()}
                  className={cn(
                    "border-r border-rule text-center last:border-r-0",
                    isWeekend(day) ? "bg-parchment-deep/60" : "bg-card",
                    isSameDay(day, today) && "ring-1 ring-inset ring-vermilion"
                  )}
                >
                  <div className={cn("pt-1.5 font-mono text-[10px] tabular-nums", isSameDay(day, today) ? "font-semibold text-vermilion" : "text-ink-muted")}>{day.getDate()}</div>
                  <div className="pb-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-muted/80">{format(day, "EEEEE")}</div>
                </div>
              ))}
            </div>
          </div>

          {/* lanes */}
          <div className="relative">
            {todayIndex >= 0 && (
              <div
                aria-hidden
                className="pointer-events-none absolute bottom-0 top-0 z-20"
                style={{
                  left: LANE_LABEL_WIDTH + todayIndex * dayWidth + dayWidth / 2,
                  width: 1,
                  background: "repeating-linear-gradient(to bottom, hsl(var(--vermilion)) 0 4px, transparent 4px 8px)",
                }}
              />
            )}

            {lanes.length === 0 ? (
              <EmptyTimeline />
            ) : (
              lanes.map((lane) => {
                const slots = packSlots(lane.tasks);
                const rows = Math.max(1, ...lane.tasks.map((t) => (slots.get(t.id) ?? 0) + 1));
                const laneHeight = rows * (ROW_HEIGHT + ROW_GAP) + 14;
                return (
                  <div key={lane.key} className="grid rule-b" style={{ gridTemplateColumns: `${LANE_LABEL_WIDTH}px ${totalWidth}px minmax(0, 1fr)` }}>
                    <div className="sticky left-0 z-20 flex items-start gap-2 border-r border-ink bg-card px-3 py-2.5">
                      <span className="mt-1 block h-5 w-1 shrink-0" style={{ background: lane.color }} />
                      <div className="min-w-0">
                        <div className="truncate font-display text-sm leading-tight tracking-tight" title={lane.label}>
                          {lane.label}
                        </div>
                        <div className="eyebrow mt-0.5">
                          {lane.tasks.length} card{lane.tasks.length === 1 ? "" : "s"}
                          {lane.isAgent ? " · agent" : ""}
                        </div>
                      </div>
                    </div>

                    <LaneCanvas
                      lane={lane}
                      days={days}
                      dayWidth={dayWidth}
                      monthStart={monthStart}
                      height={laneHeight}
                      slots={slots}
                      streams={streams}
                      apps={apps}
                      members={members}
                      allTasks={tasks}
                      barDrag={barDrag}
                      dropHint={dropHint?.laneKey === lane.key ? dropHint : null}
                      critical={critical}
                      showCriticalPath={criticalOn}
                      onOpen={onOpen}
                      onComplete={onComplete}
                    />
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LaneCanvas({
  lane,
  days,
  dayWidth,
  monthStart,
  height,
  slots,
  streams,
  apps,
  members,
  allTasks,
  barDrag,
  dropHint,
  critical,
  showCriticalPath,
  onOpen,
  onComplete,
}: {
  lane: ReturnType<typeof buildLanes>[number];
  days: Date[];
  dayWidth: number;
  monthStart: Date;
  height: number;
  slots: Map<number, number>;
  streams: PlanStream[];
  apps: PlanApp[];
  members: MemberRow[];
  allTasks: PlanTask[];
  barDrag: BarDrag | null;
  dropHint: DropHint | null;
  critical: CpIndex;
  /** The overlay is on AND the server answered — both, or nothing is drawn. */
  showCriticalPath: boolean;
  onOpen: (task: PlanTask) => void;
  onComplete: (task: PlanTask) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `lane-${lane.key}`,
    data: { kind: "lane", laneKey: lane.key, streamId: lane.streamId, assigneeId: lane.assigneeId },
  });
  const canvasWidth = days.length * dayWidth;

  return (
    <div
      ref={setNodeRef}
      className={cn("relative transition-colors", isOver && "bg-vermilion/5")}
      style={{
        width: canvasWidth,
        minHeight: height,
        backgroundImage: "linear-gradient(to right, hsl(var(--rule)) 1px, transparent 1px)",
        backgroundSize: `${dayWidth}px 100%`,
      }}
    >
      {days.map((day, index) =>
        isWeekend(day) ? (
          <div
            key={`weekend-${index}`}
            aria-hidden
            className="pointer-events-none absolute bottom-0 top-0"
            style={{ left: index * dayWidth, width: dayWidth, background: "hsl(var(--rule) / 0.35)" }}
          />
        ) : null
      )}

      {dropHint && (
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 top-0 border-x border-dashed border-vermilion bg-vermilion/10"
          style={{ left: dropHint.dayIndex * dayWidth, width: dayWidth }}
        />
      )}

      {lane.tasks.map((task) => {
        const start = dayOf(task.startDate);
        if (!start) return null;
        const duration = Math.max(1, task.estimatedDuration ?? 1);
        const startOffset = differenceInDays(start, monthStart);
        const slot = slots.get(task.id) ?? 0;
        const due = dayOf(task.dueDate);
        const dueOffset = due ? differenceInDays(due, monthStart) : null;
        const dueInRange = dueOffset !== null && dueOffset >= 0 && dueOffset < days.length;
        // A dependent that starts exactly when its dependency ends gets a small
        // gutter so the hand-off is legible instead of looking like one bar.
        const abuts = (task.dependencies ?? []).some((depId) => {
          const dep = allTasks.find((t) => t.id === depId);
          const depStart = dayOf(dep?.startDate ?? null);
          if (!depStart) return false;
          return differenceInDays(addDays(depStart, dep?.estimatedDuration ?? 0), start) === 0;
        });
        const indent = abuts ? Math.round(dayWidth / 4) : 0;
        const barLeft = startOffset * dayWidth + 2 + indent;
        const barWidth = Math.max(dayWidth - 4, duration * dayWidth - 4 - indent);
        const barTop = slot * (ROW_HEIGHT + ROW_GAP) + 7;
        const onCriticalPath = showCriticalPath && critical.onPath(task.id);
        const slack = showCriticalPath ? critical.floatOf(task.id) : null;
        // The float number sits in the gutter after the bar — past the due-date
        // diamond when there is one, since a bar that ends on its due date puts
        // the two in the same spot. A bar that runs to the edge of the month
        // keeps its number just inside, so nothing widens the canvas and the
        // month's scroll width stays exactly one month.
        const markerLeft = dueInRange ? dueOffset! * dayWidth + dayWidth / 2 - 6 : null;
        const afterBar = barLeft + barWidth + 4;
        const floatLeft = Math.min(
          markerLeft !== null && afterBar < markerLeft + 14 ? markerLeft + 17 : afterBar,
          canvasWidth - 28
        );

        return (
          <div key={task.id}>
            <DraggableBar
              taskId={task.id}
              liveDays={barDrag?.taskId === task.id ? barDrag.days : 0}
              style={{ left: barLeft, width: barWidth, top: barTop, height: ROW_HEIGHT }}
            >
              <TaskCard
                task={task}
                variant="bar"
                stream={streams.find((s) => s.id === task.streamId) ?? null}
                app={apps.find((a) => a.id === task.appId) ?? null}
                assignee={members.find((m) => m.userId === task.assignedTo) ?? null}
                onOpen={onOpen}
                onComplete={onComplete}
                className={onCriticalPath ? "!border-vermilion" : undefined}
              />
              {onCriticalPath && (
                <>
                  <span aria-hidden className="pointer-events-none absolute bottom-0 left-0 top-0 z-10 w-[3px] bg-vermilion" />
                  <span className="pointer-events-none absolute right-0 top-0 z-10 border-b border-l border-vermilion bg-card px-1 font-mono text-[8px] uppercase leading-[11px] tracking-wider2 text-vermilion">
                    CP
                  </span>
                </>
              )}
            </DraggableBar>
            {showCriticalPath && slack !== null && (
              <div
                className="absolute z-10 flex cursor-default items-center"
                style={{ left: floatLeft, top: barTop, height: ROW_HEIGHT }}
                title={floatExplainer(slack)}
                data-testid={`bar-float-${task.id}`}
              >
                <span
                  className={cn(
                    "font-mono text-[10px] tabular-nums",
                    slack === 0 ? "font-semibold text-vermilion" : "text-ink-muted/90"
                  )}
                >
                  {slack === 0 ? "0d" : `+${slack}d`}
                </span>
              </div>
            )}
            {dueInRange && (
              <div
                aria-hidden
                className="pointer-events-none absolute z-10"
                style={{ left: dueOffset * dayWidth + dayWidth / 2 - 6, top: slot * (ROW_HEIGHT + ROW_GAP) + 7, height: ROW_HEIGHT }}
                title={`Due ${format(due!, "dd MMM")}`}
              >
                <div className="relative flex h-full w-3 flex-col items-center">
                  <span className="block h-2.5 w-2.5 rotate-45 border border-ink bg-vermilion" />
                  <span className="block w-px flex-1 bg-vermilion/70" />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A timeline bar. The parent's PointerSensor needs 6px of travel before a drag
 * starts, so a plain click still reaches the card and opens the editor.
 */
function DraggableBar({ taskId, style, liveDays, children }: { taskId: number; style: React.CSSProperties; liveDays: number; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `bar-${taskId}`, data: { kind: "bar", taskId } });
  const dragStyle: React.CSSProperties = transform
    ? { ...style, transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50 }
    : style;
  return (
    <div
      ref={setNodeRef}
      data-task-id={taskId}
      className={cn("absolute select-none", isDragging ? "cursor-grabbing opacity-95 shadow-stamp" : "cursor-grab")}
      style={dragStyle}
      {...listeners}
      {...attributes}
    >
      {children}
      {isDragging && liveDays !== 0 && (
        <div className="stamp stamp-strong pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap">
          {liveDays > 0 ? "+" : ""}
          {liveDays} day{Math.abs(liveDays) === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

function EmptyTimeline() {
  return (
    <div className="bg-card px-6 py-14 text-center">
      <div className="mx-auto inline-flex max-w-sm flex-col items-center">
        <div className="mb-4 flex h-11 w-11 items-center justify-center border border-ink">
          <GanttChartSquare className="h-5 w-5" />
        </div>
        <h3 className="mb-1.5 font-display text-xl tracking-tight">Nothing scheduled this month.</h3>
        <p className="font-serif text-sm leading-relaxed text-ink-muted">
          Drag a card out of the backlog onto a lane, or open one and give it a start date — it appears here as a bar.
        </p>
      </div>
    </div>
  );
}
