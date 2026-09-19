import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Inbox, Plus } from "lucide-react";
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
}

/**
 * The unscheduled column. Cards are draggable onto the timeline (which
 * schedules them) and the column itself is a drop target for bars dragged off
 * the timeline (which unschedules them).
 */
export function Backlog({ tasks, streams, apps, members, onOpen, onComplete, onSchedule, onDraft, draggingTaskId }: BacklogProps) {
  const { setNodeRef, isOver } = useDroppable({ id: BACKLOG_DROP_ID, data: { kind: "backlog" } });

  return (
    <div ref={setNodeRef} className={cn("flex h-full flex-col transition-colors", isOver && "bg-vermilion/5")}>
      <div className="px-4 pb-3 pt-4 rule-b">
        <div className="mb-1 flex items-baseline justify-between">
          <h3 className="font-display text-xl tracking-tight">Backlog</h3>
          <span className="font-mono text-xs tabular-nums text-ink-muted">{String(tasks.length).padStart(2, "0")}</span>
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
