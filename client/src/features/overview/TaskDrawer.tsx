// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React from "react";
import { Link } from "react-router-dom";
import { ExternalLink, GanttChartSquare, Bot, X } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { bandChipClass, formatDay, formatMinutes, isOverdue, prioritySourceChipClass, prioritySourceLabel, prioritySourceTitle, STATUS_LABEL, statusChipClass } from "./format";
import SuggestPriorityPanel from "./ai/SuggestPriorityPanel";
import type { NextTaskResult, TaskRow } from "./types";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3 py-2 border-b border-rule last:border-0">
      <div className="eyebrow text-[9px] pt-0.5">{label}</div>
      <div className="text-sm font-serif break-words">{children}</div>
    </div>
  );
}

/**
 * the original backlog tracker's detail drawer. Read-only on purpose: editing a task is the Plan
 * surface's job, so the drawer ends with a link into it rather than a form that
 * would duplicate Plan's validation.
 */
export default function TaskDrawer({
  task,
  why,
  open,
  onOpenChange,
  onTaskUpdated,
}: {
  task: TaskRow | null;
  why?: NextTaskResult["why"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the fields an accepted AI suggestion changed, so the caller can
   * refresh its own copy of the row. Optional: a caller that does not own a list
   * (or has AI switched off) can leave it out.
   */
  onTaskUpdated?: (patch: Partial<TaskRow>) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto nice-scroll bg-card border-l border-ink/30" data-testid="task-drawer">
        {task ? (
          <>
            <SheetHeader className="text-left space-y-0">
              <div className="eyebrow text-[9px] flex items-center gap-2">
                <span className="section-num">№ {task.id}</span>
                {task.externalKey ? <span className="font-mono text-[10px]">{task.externalKey}</span> : null}
              </div>
              <SheetTitle className="font-display text-2xl font-normal tracking-tight leading-snug pr-6 mt-1">{task.title}</SheetTitle>
            </SheetHeader>

            <div className="flex flex-wrap items-center gap-1.5 mt-3">
              <span className={cn("stamp", bandChipClass(task.priorityScore))}>P {task.priorityScore}</span>
              <span className={cn("stamp", statusChipClass(task.status))}>{STATUS_LABEL[task.status] ?? task.status}</span>
              {task.assigneeIsAgent ? (
                <span className="stamp inline-flex items-center gap-1 border-ink/50">
                  <Bot className="h-3 w-3" /> agent
                </span>
              ) : null}
              {isOverdue(task.dueDate, task.status) ? <span className="stamp border-vermilion/70 text-vermilion">overdue</span> : null}
            </div>

            <div className="mt-4 paper-flat px-3 py-2">
              <div className="eyebrow text-[9px]">Score</div>
              <div className="font-numeric text-sm mt-1">
                urgency <b>{task.urgency}</b> × impact <b>{task.impact}</b> ÷ effort <b>{Math.max(task.effort, 1)}</b> ={" "}
                <b className={cn(bandChipClass(task.priorityScore), "border-0 bg-transparent p-0")}>{task.priorityScore}</b>
              </div>
              {task.prioritySource !== "formula" ? (
                <p className="text-xs font-serif italic text-ink-muted mt-1" title={prioritySourceTitle(task.prioritySource)} data-testid="priority-source-note">
                  <span className={cn("stamp mr-1.5", prioritySourceChipClass(task.prioritySource))}>{prioritySourceLabel(task.prioritySource) ?? task.prioritySource}</span>
                  {task.prioritySource === "ai" ? "Suggested by the model, accepted by a manager" : "Set by hand"}
                  {task.priorityNote ? ` — ${task.priorityNote}` : ""}
                </p>
              ) : null}
              {why ? <p className="text-xs font-serif italic text-ink-muted mt-1">{why.explanation}</p> : null}
            </div>

            {/* Hidden entirely unless this deployment has a provider configured. */}
            <SuggestPriorityPanel task={task} onApplied={(patch) => onTaskUpdated?.(patch)} />

            <div className="mt-4">
              <Field label="Stream">{task.streamName ?? <span className="text-ink-muted">unassigned</span>}</Field>
              <Field label="App">{task.appKey ? <span className="font-mono text-xs">{task.appKey}</span> : <span className="text-ink-muted">none</span>}</Field>
              <Field label="Assignee">
                {task.assigneeName ? (
                  <span className="inline-flex items-center gap-1.5">
                    {task.assigneeName}
                    {task.assigneeIsAgent ? <Bot className="h-3.5 w-3.5 text-ink-muted" /> : null}
                  </span>
                ) : (
                  <span className="text-ink-muted">nobody</span>
                )}
              </Field>
              <Field label="Due">{task.dueDate ? <span className={isOverdue(task.dueDate, task.status) ? "text-vermilion" : undefined}>{formatDay(task.dueDate)}</span> : <span className="text-ink-muted">no date</span>}</Field>
              <Field label="Starts">{task.startDate ? formatDay(task.startDate) : null}</Field>
              <Field label="Estimate">{task.estimatedDuration ? formatMinutes(task.estimatedDuration) : null}</Field>
              <Field label="Depends on">{task.dependencies.length > 0 ? <span className="font-numeric text-xs">{task.dependencies.map((d) => `#${d}`).join(", ")}</span> : null}</Field>
              <Field label="Tags">
                {task.tags.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {task.tags.map((t) => (
                      <span key={t} className="stamp border-rule text-ink-muted normal-case tracking-normal">{t}</span>
                    ))}
                  </span>
                ) : null}
              </Field>
              <Field label="Description">{task.description ? <span className="whitespace-pre-wrap">{task.description}</span> : null}</Field>
              <Field label="Updated">{formatDay(task.updatedAt)}</Field>
            </div>

            <div className="mt-5 flex items-center gap-3">
              <Link
                to={`/plan?task=${task.id}`}
                onClick={() => onOpenChange(false)}
                className="inline-flex items-center gap-2 px-4 py-2 border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors focus-ink rounded-sm"
                data-testid="open-in-plan"
              >
                <GanttChartSquare className="h-3.5 w-3.5" />
                <span className="eyebrow text-[10px] !text-current">Open in Plan</span>
              </Link>
              {task.appId ? (
                <Link to={`/overview/apps?app=${task.appId}`} onClick={() => onOpenChange(false)} className="eyebrow text-[10px] hover:text-ink focus-ink rounded-sm inline-flex items-center gap-1">
                  <ExternalLink className="h-3 w-3" /> app
                </Link>
              ) : null}
            </div>
          </>
        ) : (
          <div className="py-16 text-center">
            <X className="h-6 w-6 mx-auto text-ink-muted" />
            <p className="font-serif italic text-ink-muted mt-3">Nothing to show.</p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
