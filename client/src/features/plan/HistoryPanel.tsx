import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { useTaskHistory } from "./api";
import type { TaskHistoryEvent } from "./types";

const KIND_LABELS: Record<string, string> = {
  created: "created",
  updated: "edited",
  completed: "marked done",
  scheduled: "scheduled",
  unscheduled: "unscheduled",
  cascade_shifted: "shifted by cascade",
  assigned: "reassigned",
  priority_changed: "re-prioritised",
  deleted: "deleted",
  stream_moved: "moved stream",
  stream_renamed: "stream renamed",
};

/** The card's own audit trail, straight from `task.history`. */
export function HistoryPanel({ taskId, open }: { taskId: number; open: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const { data: events = [], isLoading } = useTaskHistory(taskId, open);
  const visible = expanded ? events : events.slice(0, 5);

  return (
    <details className="rule-t pt-3">
      <summary className="flex cursor-pointer items-center justify-between text-sm">
        <span className="eyebrow">History</span>
        <span className="font-mono text-xs tabular-nums text-ink-muted">{isLoading ? "…" : events.length}</span>
      </summary>
      <div className="mt-3 space-y-2 text-xs">
        {isLoading && <div className="eyebrow">Loading…</div>}
        {!isLoading && events.length === 0 && <div className="eyebrow">No history yet</div>}
        {visible.map((event) => (
          <HistoryRow key={event.id} event={event} />
        ))}
        {events.length > 5 && (
          <button type="button" onClick={() => setExpanded((x) => !x)} className="eyebrow py-1 transition-colors hover:text-ink focus-ink">
            {expanded ? "Show fewer" : `Show all ${events.length}`}
          </button>
        )}
      </div>
    </details>
  );
}

function HistoryRow({ event }: { event: TaskHistoryEvent }) {
  const actor = event.actorLabel ?? "system";
  const isAgent = actor.endsWith("(agent)");
  const isSystem = actor === "system";
  const when = (() => {
    try {
      return formatDistanceToNow(new Date(event.createdAt), { addSuffix: true });
    } catch {
      return event.createdAt;
    }
  })();
  const keys = event.changes ? Object.keys(event.changes) : [];

  return (
    <div className="flex items-start gap-2 border-l-2 border-rule pl-2.5">
      <span
        className={cn(
          "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
          event.kind === "completed" && "bg-sage",
          event.kind === "created" && "bg-vermilion",
          event.kind === "cascade_shifted" && "bg-ink/40",
          !["completed", "created", "cascade_shifted"].includes(event.kind) && "bg-ink"
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="leading-snug">
          <span className={cn("font-mono text-[11px]", isAgent && "text-vermilion", isSystem && "italic text-ink-muted")}>{actor}</span>{" "}
          <span className="text-ink-muted">{KIND_LABELS[event.kind] ?? event.kind}</span>
          {event.note && <span className="text-ink-muted"> · {event.note}</span>}
        </div>
        {keys.length > 0 && keys.length <= 3 && (
          <div className="mt-0.5 truncate font-mono text-[10px] text-ink-muted">
            {keys.map((k) => `${k}: ${formatDelta(event.changes![k])}`).join("  ·  ")}
          </div>
        )}
        <div className="mt-0.5 font-mono text-[10px] text-ink-muted/80">
          {when} · via {event.via}
        </div>
      </div>
    </div>
  );
}

function formatDelta(delta: { old: unknown; new: unknown }): string {
  const before = formatVal(delta.old);
  const after = formatVal(delta.new);
  if (before.length + after.length > 60) return `${before.slice(0, 25)}… → ${after.slice(0, 25)}…`;
  return `${before} → ${after}`;
}

function formatVal(value: unknown): string {
  if (value == null) return "∅";
  if (Array.isArray(value)) return `[${value.join(",")}]`;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
  if (typeof value === "string" && value.length > 40) return `${value.slice(0, 37)}…`;
  return String(value);
}
