import { ArrowRight, Bot, CalendarDays, Check, Clock, GitBranch, Layers, Package } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import type { MemberRow } from "@/lib/api";
import { RichDisplay } from "./RichText";
import { AgentBadge, PriorityScore } from "./pickers";
import { laneColor, pad4 } from "./logic";
import type { PlanApp, PlanStream, PlanTask } from "./types";

export interface TaskCardProps {
  task: PlanTask;
  /** "spec" is the full backlog card, "bar" the compact timeline bar. */
  variant?: "spec" | "bar";
  stream?: PlanStream | null;
  app?: PlanApp | null;
  assignee?: MemberRow | null;
  onOpen: (task: PlanTask) => void;
  onComplete?: (task: PlanTask) => void;
  onSchedule?: (task: PlanTask) => void;
  className?: string;
}

/** Hatching for a completed card — the palette has no utility for it. */
const DONE_HATCH: React.CSSProperties = {
  backgroundImage: "repeating-linear-gradient(45deg, hsl(var(--rule)) 0 1px, transparent 1px 6px)",
};

export function TaskCard({ task, variant = "spec", stream, app, assignee, onOpen, onComplete, onSchedule, className }: TaskCardProps) {
  const deps = task.dependencies?.length ?? 0;

  if (variant === "bar") {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); onOpen(task); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onOpen(task); } }}
        className={cn(
          "group h-full w-full overflow-hidden border border-ink/80 bg-card transition-transform duration-150",
          "hover:-translate-x-px hover:-translate-y-px hover:shadow-stamp focus-ink",
          task.completed && "opacity-60",
          className
        )}
        style={task.completed ? DONE_HATCH : undefined}
        title={`${task.title}${task.estimatedDuration ? ` · ${task.estimatedDuration}d` : ""}`}
      >
        <div className="flex h-full items-stretch">
          <div className="w-1 shrink-0" style={{ background: laneColor(stream?.id ?? "none", stream?.color) }} />
          <div className="flex min-w-0 flex-1 flex-col justify-center px-2 py-1">
            <div className="flex min-w-0 items-baseline gap-1.5">
              {task.externalKey && <span className="shrink-0 font-mono text-[10px] text-ink-muted">{task.externalKey}</span>}
              <span className="truncate text-xs font-medium text-ink">{task.title}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] tabular-nums text-ink-muted">
              {task.estimatedDuration ? <span>{task.estimatedDuration}d</span> : null}
              {assignee && (
                <span className="inline-flex max-w-[90px] items-center gap-0.5 truncate">
                  {assignee.isAgent && <Bot className="h-2.5 w-2.5" />}
                  {assignee.displayName}
                </span>
              )}
              {deps > 0 && (
                <span className="inline-flex items-center gap-0.5 text-vermilion" title={`Depends on ${deps} card(s)`}>
                  <GitBranch className="h-2.5 w-2.5" />
                  {deps}
                </span>
              )}
              <PriorityScore score={task.priorityScore} className="ml-auto !text-[10px]" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <article
      className={cn("paper group relative cursor-pointer p-4 transition-shadow hover:shadow-stamp", task.completed && "opacity-70", className)}
      onClick={() => onOpen(task)}
      style={task.completed ? DONE_HATCH : undefined}
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="font-mono text-[10px] tabular-nums text-ink-muted">№{pad4(task.id)}</span>
          {task.externalKey && <span className="stamp truncate">{task.externalKey}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PriorityScore score={task.priorityScore} source={task.prioritySource} />
        </div>
      </header>

      <h3 className="mb-2 font-display text-lg leading-tight tracking-tight text-balance text-ink">{task.title}</h3>

      {task.description && <RichDisplay html={task.description} clamp={2} className="mb-3 text-xs" />}

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-muted">
        {stream && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-1" style={{ background: laneColor(stream.id, stream.color) }} />
            {stream.name}
          </span>
        )}
        {!stream && (
          <span className="inline-flex items-center gap-1.5 opacity-70">
            <Layers className="h-3 w-3" /> no stream
          </span>
        )}
        {app && (
          <span className="inline-flex items-center gap-1.5">
            <Package className="h-3 w-3" />
            {app.key}
          </span>
        )}
        <span className={cn("inline-flex items-center gap-1.5", !task.estimatedDuration && "opacity-60")}>
          <Clock className="h-3 w-3" />
          {task.estimatedDuration ? `${task.estimatedDuration} days` : "duration —"}
        </span>
        {task.startDate && (
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="h-3 w-3" />
            {format(new Date(task.startDate), "dd MMM")}
          </span>
        )}
        {assignee ? (
          <span className="inline-flex items-center gap-1">
            {assignee.isAgent ? <Bot className="h-3 w-3" /> : null}
            {assignee.displayName}
            {assignee.isAgent && <AgentBadge />}
          </span>
        ) : (
          <span className="opacity-60">unassigned</span>
        )}
        {deps > 0 && (
          <span className="inline-flex items-center gap-1.5 text-vermilion" title={`Depends on ${deps} card(s)`}>
            <GitBranch className="h-3 w-3" />
            {deps} dep{deps > 1 ? "s" : ""}
          </span>
        )}
      </div>

      {task.tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {task.tags.map((tag) => (
            <span key={tag} className="stamp">{tag}</span>
          ))}
        </div>
      )}

      <footer className="flex items-center gap-2 rule-t pt-3" onClick={(e) => e.stopPropagation()}>
        {onSchedule && !task.startDate && !task.completed && (
          <button
            onClick={() => onSchedule(task)}
            className="group/btn flex flex-1 items-center justify-center gap-2 border border-ink bg-ink px-3 py-1.5 text-parchment transition-colors hover:bg-parchment hover:text-ink focus-ink"
          >
            <CalendarDays className="h-3 w-3" />
            <span className="eyebrow !text-current">Schedule</span>
            <ArrowRight className="h-3 w-3 transition-transform group-hover/btn:translate-x-0.5" />
          </button>
        )}
        {onComplete && !task.completed && (
          <button
            onClick={() => onComplete(task)}
            title="Mark complete"
            className="flex items-center gap-1.5 border border-rule px-3 py-1.5 transition-colors hover:border-sage hover:text-sage focus-ink"
          >
            <Check className="h-3 w-3" />
            <span className="eyebrow !text-current">Done</span>
          </button>
        )}
        {task.completed && (
          <span className="stamp ml-auto border-sage/60 !text-sage">
            <Check className="mr-1 -mt-0.5 inline h-3 w-3" />
            Completed
          </span>
        )}
      </footer>
    </article>
  );
}
