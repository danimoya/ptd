import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Inbox, Minimize, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MemberRow } from "@/lib/api";
import { TaskCard } from "./TaskCard";
import type { PlanApp, PlanStream, PlanTask } from "./types";

/** Drop target id the board listens for when a timeline bar is dragged back here. */
export const BACKLOG_DROP_ID = "backlog-drop";

interface BacklogProps {
  tasks: PlanTask[];
  streams: PlanStream[];
  apps: PlanApp[];
  members: MemberRow[];
  onOpen: (task: PlanTask) => void;
  onComplete: (task: PlanTask) => void;
  onSchedule: (task: PlanTask) => void;
  onDraft: () => void;
  /** Hidden while its bar is being dragged out onto the timeline. */
  draggingTaskId?: number | null;
  /** Fold the column away — the timeline then takes the whole board. */
  onHide?: () => void;
  /** Only supplied while the board is in full screen, so the icon appears there. */
  onExitFullscreen?: () => void;
}

/**
 * The unscheduled column. Cards are draggable onto the timeline (which
 * schedules them) and the column itself is a drop target for bars dragged off
 * the timeline (which unschedules them).
 */
export function Backlog({ tasks, streams, apps, members, onOpen, onComplete, onSchedule, onDraft, draggingTaskId, onHide, onExitFullscreen }: BacklogProps) {
  const { setNodeRef, isOver } = useDroppable({ id: BACKLOG_DROP_ID, data: { kind: "backlog" } });

  return (
    <div ref={setNodeRef} className={cn("flex h-full flex-col transition-colors", isOver && "bg-vermilion/5")}>
      <div className="px-4 pb-3 pt-4 rule-b">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <h3 className="font-display text-xl tracking-tight">Backlog</h3>
          <div className="flex items-center gap-1 self-center">
            <span className="font-mono text-xs tabular-nums text-ink-muted">{String(tasks.length).padStart(2, "0")}</span>
            {onExitFullscreen && (
              <IconButton icon={Minimize} label="Exit full screen" onClick={onExitFullscreen} testId="backlog-exit-fullscreen" />
            )}
            {onHide && <IconButton icon={PanelLeftClose} label="Hide the backlog" onClick={onHide} testId="backlog-hide" />}
          </div>
        </div>
        <p className="eyebrow">{isOver ? "Drop to unschedule" : "Cards waiting for the timeline"}</p>
        <button
          onClick={onDraft}
          className="mt-3 flex w-full items-center justify-center gap-2 border border-ink bg-ink px-3 py-2 text-parchment transition-colors hover:bg-parchment hover:text-ink focus-ink"
        >
          <Plus className="h-4 w-4" />
          <span className="eyebrow !text-current">Draft new card</span>
        </button>
      </div>

      <div className="nice-scroll flex-1 space-y-3 overflow-auto p-3">
        {tasks.length === 0 ? (
          <div className="border border-dashed border-rule p-6 text-center">
            <Inbox className="mx-auto mb-3 h-7 w-7 text-ink-muted/60" />
            <div className="mb-1 font-display text-lg tracking-tight">Empty folio.</div>
            <p className="font-serif text-sm text-ink-muted">Draft the first card with the button above.</p>
          </div>
        ) : (
          tasks.map((task) => (
            <DraggableCard key={task.id} taskId={task.id} dimmed={draggingTaskId === task.id}>
              <TaskCard
                task={task}
                stream={streams.find((s) => s.id === task.streamId) ?? null}
                app={apps.find((a) => a.id === task.appId) ?? null}
                assignee={members.find((m) => m.userId === task.assignedTo) ?? null}
                onOpen={onOpen}
                onComplete={onComplete}
                onSchedule={onSchedule}
              />
            </DraggableCard>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * A backlog card that can be dragged onto the timeline. The 6px activation
 * distance on the board's PointerSensor keeps a plain click opening the editor.
 */
function DraggableCard({ taskId, dimmed, children }: { taskId: number; dimmed?: boolean; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `card-${taskId}`, data: { kind: "card", taskId } });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn("cursor-grab active:cursor-grabbing", (isDragging || dimmed) && "opacity-40")}
    >
      {children}
    </div>
  );
}

/**
 * What is left of the column when it is folded away: a slim gutter that reopens
 * it — and, crucially, still the BACKLOG_DROP_ID drop target, so a bar can be
 * dragged off the timeline to unschedule it with the column hidden.
 */
export function BacklogHandle({
  count,
  onShow,
  onExitFullscreen,
}: {
  count: number;
  onShow: () => void;
  onExitFullscreen?: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: BACKLOG_DROP_ID, data: { kind: "backlog" } });

  return (
    <div
      ref={setNodeRef}
      data-testid="backlog-handle"
      className={cn(
        "flex items-center gap-2 border-b border-rule bg-parchment-deep/40 px-2 py-1.5 transition-colors",
        "lg:h-full lg:w-7 lg:flex-col lg:border-b-0 lg:border-r lg:px-0 lg:py-3",
        isOver && "bg-vermilion/10"
      )}
      title={isOver ? "Drop to unschedule" : undefined}
    >
      <IconButton icon={PanelLeftOpen} label="Show the backlog" onClick={onShow} testId="backlog-show" />
      <span className="eyebrow text-[9px] lg:[writing-mode:vertical-rl]">
        Backlog {String(count).padStart(2, "0")}
      </span>
      {onExitFullscreen && (
        <IconButton
          icon={Minimize}
          label="Exit full screen"
          onClick={onExitFullscreen}
          testId="backlog-handle-exit-fullscreen"
          className="ml-auto lg:ml-0 lg:mt-auto"
        />
      )}
    </div>
  );
}

/** A 22px ledger-stamp button: hairline box, ink on hover. */
function IconButton({
  icon: Icon,
  label,
  onClick,
  testId,
  className,
}: {
  icon: typeof PanelLeftClose;
  label: string;
  onClick: () => void;
  testId?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      data-testid={testId}
      className={cn(
        "flex h-[22px] w-[22px] shrink-0 items-center justify-center border border-rule text-ink-muted transition-colors hover:border-ink hover:bg-ink hover:text-parchment focus-ink",
        className
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}
