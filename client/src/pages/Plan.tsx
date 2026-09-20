import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { addDays, differenceInDays, endOfMonth, format, startOfMonth } from "date-fns";
import {
  Check,
  ChevronRight,
  GanttChartSquare,
  GitBranch,
  LayoutList,
  Maximize,
  Minimize,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import PoweredBy from "@/components/PoweredBy";
import { Backlog, BacklogHandle, BACKLOG_DROP_ID } from "@/features/plan/Backlog";
import { CascadeView } from "@/features/plan/CascadeView";
import { Timeline, DAY_WIDTH, type BarDrag, type DropHint } from "@/features/plan/Timeline";
import { TaskCard } from "@/features/plan/TaskCard";
import { TaskDialog } from "@/features/plan/TaskDialog";
import { usePlanApps, usePlanMembers, usePlanStreams, usePlanTasks, useTaskMutations } from "@/features/plan/api";
import { dayOf, isBlockedNow, pad4, toDayString } from "@/features/plan/logic";
import { usePersistentFlag, usePersistentState } from "@/features/plan/usePersistentState";
import type { CascadeGroup, CascadeOrder, GroupBy, PlanTask, ViewMode } from "@/features/plan/types";

const VIEWS = ["board", "timeline", "cascade"] as const;
const GROUP_BYS = ["stream", "assignee"] as const;
const CASCADE_ORDERS = ["priority_score", "due_date", "start_date", "float"] as const;
const CASCADE_GROUPS = ["stream", "app", "assignee", "source"] as const;

interface DialogState {
  open: boolean;
  task: PlanTask | null;
  defaultStartDate: Date | null;
  defaultStreamId: number | null;
}

const CLOSED: DialogState = { open: false, task: null, defaultStartDate: null, defaultStreamId: null };

/**
 * The Plan surface: Kanttban's backlog ⇄ Gantt board, plus a Cascade mode that
 * reads the same data as a dependency tree.
 *
 * This component owns the one DndContext the whole surface shares — that is what
 * lets a card be dragged out of the backlog onto a lane (schedule) and a bar be
 * dragged back into the backlog (unschedule). Everything it writes goes through
 * the action registry, so a drag and an MCP call take exactly the same path.
 */
export default function Plan() {
  const tasksQuery = usePlanTasks();
  const streamsQuery = usePlanStreams();
  const appsQuery = usePlanApps();
  const membersQuery = usePlanMembers();
  const { update, schedule, unschedule, complete, drag } = useTaskMutations();

  const [view, setView] = usePersistentState<ViewMode>("ptd.plan.view", "board", VIEWS);
  const [groupBy, setGroupBy] = usePersistentState<GroupBy>("ptd.plan.groupBy", "stream", GROUP_BYS);
  const [cascadeOrder, setCascadeOrder] = usePersistentState<CascadeOrder>("ptd.plan.cascade.order", "priority_score", CASCADE_ORDERS);
  const [cascadeGroup, setCascadeGroup] = usePersistentState<CascadeGroup>("ptd.plan.cascade.group", "stream", CASCADE_GROUPS);
  const [sidebarHidden, setSidebarHidden] = usePersistentFlag("ptd.plan.sidebarHidden", false);
  const [fullscreen, setFullscreen] = useState(false);

  const [viewDate, setViewDate] = useState(() => new Date());
  const [dialog, setDialog] = useState<DialogState>(CLOSED);
  const [barDrag, setBarDrag] = useState<BarDrag | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const [activeCard, setActiveCard] = useState<PlanTask | null>(null);
  const [archiveQuery, setArchiveQuery] = useState("");

  const tasks = tasksQuery.data ?? [];
  const streams = streamsQuery.data?.streams ?? [];
  const apps = appsQuery.data ?? [];
  const members = membersQuery.data ?? [];

  const open = useMemo(() => tasks.filter((t) => !t.completed), [tasks]);
  const backlog = useMemo(() => open.filter((t) => !t.startDate), [open]);
  const scheduled = useMemo(() => open.filter((t) => !!t.startDate), [open]);
  const done = useMemo(() => tasks.filter((t) => t.completed), [tasks]);
  const blocked = useMemo(() => open.filter((t) => isBlockedNow(t, tasks)).length, [open, tasks]);

  const monthStart = startOfMonth(viewDate);
  const daysInMonth = differenceInDays(endOfMonth(viewDate), monthStart) + 1;

  /* ─────────── drag and drop ─────────── */

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  /**
   * The timeline stretches its day columns to fill the room the full-bleed shell
   * (or full screen) gives it, and reports the width it settled on. A ref, not
   * state: the snap modifier and the drop handler read it mid-drag, and a
   * re-render there would fight dnd-kit's own measurements.
   */
  const dayWidthRef = useRef(DAY_WIDTH);
  const handleDayWidth = useCallback((width: number) => {
    dayWidthRef.current = width;
  }, []);

  /** Bars snap to whole days and stay in their lane; a backlog card moves freely. */
  const snapBars: Modifier = ({ transform, active }) => {
    if (typeof active?.id === "string" && active.id.startsWith("bar-")) {
      const unit = dayWidthRef.current;
      return { ...transform, x: Math.round(transform.x / unit) * unit, y: 0, scaleX: 1, scaleY: 1 };
    }
    return transform;
  };

  /**
   * Day column under the cursor.
   *
   * Derived from the pointer rather than the dragged node's box: with a
   * DragOverlay the measured box belongs to the floating ghost, which sits
   * wherever dnd-kit parks it, so pointer + delta is the only reading that
   * matches what the user is aiming at. `pointerWithin` above picks the lane on
   * the same basis.
   */
  const dayIndexFrom = (event: DragMoveEvent | DragEndEvent): number | null => {
    const laneRect = event.over?.rect;
    if (!laneRect) return null;
    const activator = event.activatorEvent as { clientX?: number } | undefined;
    const pointerX = typeof activator?.clientX === "number" ? activator.clientX + event.delta.x : event.active.rect.current.translated?.left;
    if (typeof pointerX !== "number") return null;
    // The lane canvas is exactly one month wide, so its own rect gives the day
    // unit whatever width the grid settled on.
    const unit = laneRect.width > 0 ? laneRect.width / daysInMonth : dayWidthRef.current;
    const index = Math.floor((pointerX - laneRect.left) / unit);
    return Math.max(0, Math.min(daysInMonth - 1, index));
  };

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as { kind?: string; taskId?: number } | undefined;
    if (data?.kind === "bar" && data.taskId) setBarDrag({ taskId: data.taskId, days: 0 });
    if (data?.kind === "card" && data.taskId) setActiveCard(tasks.find((t) => t.id === data.taskId) ?? null);
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const data = event.active.data.current as { kind?: string; taskId?: number } | undefined;
    if (data?.kind === "bar" && data.taskId) {
      const days = Math.round(event.delta.x / dayWidthRef.current);
      setBarDrag((prev) => (prev && prev.days === days ? prev : { taskId: data.taskId!, days }));
      return;
    }
    const over = event.over?.data.current as { kind?: string; laneKey?: string } | undefined;
    if (data?.kind === "card" && over?.kind === "lane" && over.laneKey) {
      const index = dayIndexFrom(event);
      if (index === null) return setDropHint(null);
      setDropHint({ laneKey: over.laneKey, dayIndex: index, date: addDays(monthStart, index) });
    } else if (dropHint) {
      setDropHint(null);
    }
  };

  const resetDrag = () => {
    setBarDrag(null);
    setDropHint(null);
    setActiveCard(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const data = event.active.data.current as { kind?: string; taskId?: number } | undefined;
    const overData = event.over?.data.current as { kind?: string; laneKey?: string; streamId?: number | null; assigneeId?: number | null } | undefined;
    const index = dayIndexFrom(event);
    const taskId = data?.taskId;
    resetDrag();
    if (!taskId) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    if (data?.kind === "bar") {
      // Dropped back on the backlog column → off the timeline.
      if (event.over?.id === BACKLOG_DROP_ID) {
        unschedule.mutate({ taskId });
        return;
      }
      const days = Math.round(event.delta.x / dayWidthRef.current);
      const current = dayOf(task.startDate);
      if (days === 0 || !current) return;
      drag.mutate({ taskId, startDate: toDayString(addDays(current, days)) });
      return;
    }

    if (data?.kind === "card" && overData?.kind === "lane" && index !== null) {
      const startDate = toDayString(addDays(monthStart, index));
      const payload: Record<string, unknown> = { taskId, startDate };
      // Dropping into a lane also files the card into that lane's stream (or
      // onto that person) — the lane is the statement the user just made.
      if (groupBy === "stream" && (overData.streamId ?? null) !== task.streamId) payload.streamId = overData.streamId ?? null;
      if (groupBy === "assignee" && (overData.assigneeId ?? null) !== task.assignedTo) payload.assignedTo = overData.assigneeId ?? null;
      if (Object.keys(payload).length > 2) update.mutate(payload);
      else schedule.mutate({ taskId, startDate });
    }
  };

  /* ─────────── full screen ─────────── */

  /**
   * Full screen is a real overlay (fixed inset-0), not the Fullscreen API: it has
   * to work in an iframe, in a browser that refuses the request, and on iOS. The
   * native request is a bonus on top, so the chrome goes away too when the
   * browser allows it.
   */
  const enterFullscreen = useCallback(() => {
    setFullscreen(true);
    try {
      void document.documentElement.requestFullscreen?.()?.catch(() => {});
    } catch {
      /* the overlay is the real mechanism; the API is decoration */
    }
  }, []);

  const exitFullscreen = useCallback(() => {
    setFullscreen(false);
    try {
      if (document.fullscreenElement) void document.exitFullscreen?.()?.catch(() => {});
    } catch {
      /* ignore */
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (fullscreen) exitFullscreen();
    else enterFullscreen();
  }, [fullscreen, enterFullscreen, exitFullscreen]);

  // The page behind the overlay must not scroll under it.
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [fullscreen]);

  // Leaving the surface while full screen must not strand the browser in it.
  useEffect(
    () => () => {
      try {
        if (document.fullscreenElement) void document.exitFullscreen?.()?.catch(() => {});
      } catch {
        /* ignore */
      }
    },
    []
  );

  // Esc inside native full screen is swallowed by the browser, which exits the
  // API without telling the keyboard — so follow the API's own event too.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // `f` toggles, `Esc` leaves — unless the caret is in a field or a dialog owns
  // the keyboard.
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || typeof el.tagName !== "string") return false;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (dialog.open) return;
      if (event.key === "Escape") {
        if (fullscreen) exitFullscreen();
        return;
      }
      if ((event.key === "f" || event.key === "F") && !isTyping(event.target)) {
        event.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog.open, fullscreen, exitFullscreen, toggleFullscreen]);

  /* ─────────── render ─────────── */

  const openCard = (task: PlanTask) => setDialog({ open: true, task, defaultStartDate: null, defaultStreamId: null });
  const draftCard = () => setDialog({ open: true, task: null, defaultStartDate: null, defaultStreamId: null });
  const scheduleCard = (task: PlanTask) => setDialog({ open: true, task, defaultStartDate: new Date(), defaultStreamId: null });
  const completeCard = (task: PlanTask) => complete.mutate({ taskId: task.id });

  const loading = tasksQuery.isLoading || streamsQuery.isLoading;
  const error = tasksQuery.error || streamsQuery.error;

  const timeline = (
    <Timeline
      tasks={tasks}
      streams={streams}
      apps={apps}
      members={members}
      groupBy={groupBy}
      onGroupByChange={setGroupBy}
      viewDate={viewDate}
      onViewDateChange={setViewDate}
      onOpen={openCard}
      onComplete={completeCard}
      barDrag={barDrag}
      dropHint={dropHint}
      onDayWidth={handleDayWidth}
    />
  );

  /**
   * The working area — what full screen puts under glass. In full screen it is a
   * flex child that has to fill the overlay, so the box gets `flex-1 min-h-0`
   * and the inner panes keep their own scrolling.
   */
  const workArea = (
    <div
      className={cn(
        fullscreen
          ? // Below lg the board stacks, so the overlay scrolls the way the page
            // does; from lg the panes fill the glass and scroll inside themselves.
            "nice-scroll flex min-h-0 flex-1 flex-col overflow-auto lg:overflow-visible"
          : "mt-5"
      )}
    >
      {view === "board" && (
        <div
          className={cn(
            "paper grid grid-cols-1 overflow-hidden",
            sidebarHidden ? "lg:grid-cols-[28px_minmax(0,1fr)]" : "lg:grid-cols-[320px_minmax(0,1fr)]",
            fullscreen && "max-lg:shrink-0 lg:min-h-0 lg:flex-1"
          )}
        >
          {sidebarHidden ? (
            <BacklogHandle
              count={backlog.length}
              onShow={() => setSidebarHidden(false)}
              onExitFullscreen={fullscreen ? exitFullscreen : undefined}
            />
          ) : (
            <aside className="min-w-0 border-b border-rule bg-parchment-deep/30 lg:border-b-0 lg:border-r">
              <Backlog
                tasks={backlog}
                streams={streams}
                apps={apps}
                members={members}
                onOpen={openCard}
                onComplete={completeCard}
                onSchedule={scheduleCard}
                onDraft={draftCard}
                draggingTaskId={activeCard?.id ?? null}
                onHide={() => setSidebarHidden(true)}
                onExitFullscreen={fullscreen ? exitFullscreen : undefined}
              />
            </aside>
          )}
          <div className="min-w-0">{timeline}</div>
        </div>
      )}

      {view === "timeline" && <div className={cn("paper overflow-hidden", fullscreen && "max-lg:shrink-0 lg:min-h-0 lg:flex-1")}>{timeline}</div>}

      {view === "cascade" && (
        <div className={cn("paper overflow-hidden", fullscreen && "max-lg:shrink-0 lg:min-h-0 lg:flex-1")}>
          <CascadeView
            tasks={tasks}
            streams={streams}
            apps={apps}
            members={members}
            order={cascadeOrder}
            onOrderChange={setCascadeOrder}
            group={cascadeGroup}
            onGroupChange={setCascadeGroup}
            onOpen={openCard}
          />
        </div>
      )}
    </div>
  );

  /**
   * The drag ghost travels with the working area: inside full screen it has to be
   * rendered in the overlay's stacking context, or dnd-kit's z-index lands under
   * the overlay and the card disappears mid-drag.
   */
  const dragGhost = (
    <DragOverlay dropAnimation={null}>
      {activeCard && (
        <div className="w-[280px] rotate-[-0.6deg] opacity-95">
          <div className="paper px-3 py-2 shadow-stamp">
            <div className="font-mono text-[10px] text-ink-muted">№{pad4(activeCard.id)}</div>
            <div className="truncate font-display text-sm tracking-tight">{activeCard.title}</div>
            <div className="eyebrow mt-0.5">
              {dropHint ? `starts ${format(dropHint.date, "EEE dd MMM")}` : "drop on a lane to schedule"}
            </div>
          </div>
        </div>
      )}
    </DragOverlay>
  );

  return (
    <section className="animate-ink-fade-in pb-10">
      <header className="rule-b pb-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="eyebrow">II. Plan</span>
            <h2 className="mt-1 font-display text-3xl tracking-tight">The drafting board</h2>
            <p className="mt-1 max-w-xl font-serif text-sm text-ink-muted">
              Backlog on the left, the month on the right. Drag a card onto a lane to schedule it; dependants shift themselves.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <nav className="flex items-center border border-rule" aria-label="Plan view">
              <ViewTab icon={LayoutList} label="Board" active={view === "board"} onClick={() => setView("board")} />
              <ViewTab icon={GanttChartSquare} label="Timeline" active={view === "timeline"} onClick={() => setView("timeline")} />
              <ViewTab icon={GitBranch} label="Cascade" active={view === "cascade"} onClick={() => setView("cascade")} />
            </nav>
            {view === "board" && (
              <button
                onClick={() => setSidebarHidden(!sidebarHidden)}
                title={sidebarHidden ? "Show the backlog" : "Hide the backlog"}
                aria-pressed={sidebarHidden}
                data-testid="plan-sidebar-toggle"
                className="eyebrow flex h-8 items-center gap-1.5 border border-rule px-3 transition-colors hover:bg-parchment-deep focus-ink"
              >
                {sidebarHidden ? <PanelLeftOpen className="h-3 w-3" /> : <PanelLeftClose className="h-3 w-3" />}
                <span className="hidden sm:inline">Backlog</span>
              </button>
            )}
            <button
              onClick={toggleFullscreen}
              title="Full screen (f)"
              data-testid="plan-fullscreen-toggle"
              className="eyebrow flex h-8 items-center gap-1.5 border border-rule px-3 transition-colors hover:bg-ink hover:!text-parchment focus-ink"
            >
              {fullscreen ? <Minimize className="h-3 w-3" /> : <Maximize className="h-3 w-3" />}
              {fullscreen ? "Exit" : "Full screen"}
            </button>
          </div>
        </div>

        <dl className="mt-4 flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <Stat label="In backlog" value={backlog.length} />
          <Stat label="Scheduled" value={scheduled.length} />
          <Stat label="Blocked" value={blocked} accent={blocked > 0} />
          <Stat label="Completed" value={done.length} />
          <Stat label="Streams" value={streams.filter((s) => !s.archived).length} />
        </dl>
      </header>

      {loading && <p className="eyebrow mt-6">Opening the folio…</p>}
      {error && (
        <p className="mt-6 border border-vermilion/40 bg-vermilion/5 p-3 font-serif text-sm text-vermilion">
          Could not load the board: {(error as Error).message}
        </p>
      )}

      {!loading && !error && (
        <DndContext sensors={sensors} collisionDetection={pointerWithin} modifiers={[snapBars]} onDragStart={handleDragStart} onDragMove={handleDragMove} onDragEnd={handleDragEnd} onDragCancel={resetDrag}>
          {fullscreen
            ? createPortal(
                /* Portaled to <body>: the surface's own fade-in animation leaves a
                   transform behind, which would make `fixed` resolve against the
                   section instead of the viewport, and the shell's masthead and
                   mobile bar sit in stacking contexts of their own. z-40 clears
                   both while staying under Radix's z-50 dialogs. */
                <div
                  className="fixed inset-0 z-40 flex flex-col gap-2 bg-parchment p-2 sm:p-3"
                  data-testid="plan-fullscreen"
                  role="region"
                  aria-label="Plan, full screen"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="eyebrow text-[10px] text-vermilion/90">II. Plan</span>
                      <span className="hidden font-display text-sm italic text-ink-muted sm:inline">the drafting board, uncropped</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <nav className="flex items-center border border-rule" aria-label="Plan view">
                        <ViewTab icon={LayoutList} label="Board" active={view === "board"} onClick={() => setView("board")} />
                        <ViewTab icon={GanttChartSquare} label="Timeline" active={view === "timeline"} onClick={() => setView("timeline")} />
                        <ViewTab icon={GitBranch} label="Cascade" active={view === "cascade"} onClick={() => setView("cascade")} />
                      </nav>
                      {view === "board" && (
                        <button
                          onClick={() => setSidebarHidden(!sidebarHidden)}
                          title={sidebarHidden ? "Show the backlog" : "Hide the backlog"}
                          aria-pressed={sidebarHidden}
                          data-testid="plan-fs-sidebar-toggle"
                          className="eyebrow flex h-8 items-center gap-1.5 border border-rule px-3 transition-colors hover:bg-parchment-deep focus-ink"
                        >
                          {sidebarHidden ? <PanelLeftOpen className="h-3 w-3" /> : <PanelLeftClose className="h-3 w-3" />}
                          <span className="hidden sm:inline">Backlog</span>
                        </button>
                      )}
                      <button
                        onClick={exitFullscreen}
                        title="Exit full screen (Esc)"
                        data-testid="plan-fullscreen-exit"
                        className="eyebrow flex h-8 items-center gap-1.5 border border-ink bg-ink px-3 !text-parchment transition-colors hover:bg-parchment hover:!text-ink focus-ink"
                      >
                        <Minimize className="h-3 w-3" />
                        Exit
                      </button>
                    </div>
                  </div>

                  {workArea}

                  <div className="flex items-center justify-between gap-3 px-0.5">
                    <span className="eyebrow text-[9px]">Esc or F to leave full screen</span>
                    <PoweredBy className="text-[9px]" />
                  </div>

                  {dragGhost}
                </div>,
                document.body
              )
            : (
                <>
                  {workArea}
                  {dragGhost}
                </>
              )}
        </DndContext>
      )}

      {view !== "cascade" && !loading && !error && (
        <Collapsible className="mt-4">
          <CollapsibleTrigger asChild>
            <button className="paper flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-parchment-deep/40 focus-ink">
              <span className="flex items-center gap-3">
                <span className="stamp">{done.length} done</span>
                <span className="eyebrow">the completed drawer</span>
              </span>
              <ChevronRight className="h-4 w-4" />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="paper mt-2 p-4">
              <div className="mb-3 flex items-center gap-2 border border-rule bg-card px-3 py-2">
                <Search className="h-4 w-4 text-ink-muted" />
                <input
                  value={archiveQuery}
                  onChange={(e) => setArchiveQuery(e.target.value)}
                  placeholder="Search the archive…"
                  className="flex-1 bg-transparent font-serif text-sm outline-none placeholder:text-ink-muted/70"
                />
                <span className="font-mono text-[10px] tabular-nums text-ink-muted">{done.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {done
                  .filter((task) => task.title.toLowerCase().includes(archiveQuery.trim().toLowerCase()))
                  .map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      stream={streams.find((s) => s.id === task.streamId) ?? null}
                      app={apps.find((a) => a.id === task.appId) ?? null}
                      assignee={members.find((m) => m.userId === task.assignedTo) ?? null}
                      onOpen={openCard}
                    />
                  ))}
                {done.length === 0 && (
                  <p className="col-span-full py-6 text-center font-serif text-sm text-ink-muted">
                    <Check className="mr-1.5 -mt-0.5 inline h-3.5 w-3.5" />
                    Nothing struck off yet.
                  </p>
                )}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      <TaskDialog
        key={dialog.task?.id ?? (dialog.open ? "new" : "closed")}
        open={dialog.open}
        onOpenChange={(next) => (next ? undefined : setDialog(CLOSED))}
        task={dialog.task}
        tasks={tasks}
        streams={streams}
        apps={apps}
        members={members}
        defaultStartDate={dialog.defaultStartDate}
        defaultStreamId={dialog.defaultStreamId}
      />
    </section>
  );
}

function ViewTab({ icon: Icon, label, active, onClick }: { icon: typeof GanttChartSquare; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "eyebrow flex h-8 items-center gap-1.5 px-3 transition-colors focus-ink first:border-l-0 border-l border-rule",
        active ? "bg-ink !text-parchment" : "hover:bg-parchment-deep"
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className={cn("font-display text-2xl leading-none tabular-nums tracking-tight", accent && "text-vermilion")}>
        {String(value).padStart(2, "0")}
      </dd>
    </div>
  );
}
