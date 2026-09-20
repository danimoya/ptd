import { useMemo, useState } from "react";
import { ArrowRight, Check, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { MemberRow } from "@/lib/api";
import { RichEditor } from "./RichText";
import { DependencyPicker } from "./DependencyPicker";
import { HistoryPanel } from "./HistoryPanel";
import { TimePanel } from "./TimePanel";
import { AppPicker, AssigneePicker, DatePicker, Field, PriorityScore, ScoreSlider, StreamCombobox, TagEditor } from "./pickers";
import { dayKey, dayOf, formulaScore, pad4, priorityBand, toDayString } from "./logic";
import { useStreamMutations, useTaskMutations } from "./api";
import type { PlanApp, PlanStream, PlanTask } from "./types";

interface TaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null drafts a new card. */
  task: PlanTask | null;
  tasks: PlanTask[];
  streams: PlanStream[];
  apps: PlanApp[];
  members: MemberRow[];
  /** Pre-fills the start date when the card is being drafted from a timeline slot. */
  defaultStartDate?: Date | null;
  defaultStreamId?: number | null;
}

/**
 * The card editor — the original board's Edit Card dialog with PTD's extra columns
 * (app, priority triangle, tags) and two read-only panels: the card's history
 * and the time logged against it by the Track surface.
 *
 * Saving sends a patch, not the whole row: only fields the user actually
 * touched are in the payload, so two people editing different halves of a card
 * do not clobber each other.
 */
export function TaskDialog({ open, onOpenChange, task, tasks, streams, apps, members, defaultStartDate, defaultStreamId }: TaskDialogProps) {
  const isNew = task === null;
  const { create, update, complete, remove, setPriority } = useTaskMutations();
  const streamMutations = useStreamMutations();

  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [externalKey, setExternalKey] = useState(task?.externalKey ?? "");
  const [duration, setDuration] = useState(task?.estimatedDuration ? String(task.estimatedDuration) : "");
  const [streamId, setStreamId] = useState<number | null>(task ? task.streamId : defaultStreamId ?? null);
  const [appId, setAppId] = useState<number | null>(task?.appId ?? null);
  const [assignedTo, setAssignedTo] = useState<number | null>(task?.assignedTo ?? null);
  // An existing card keeps its own date; `defaultStartDate` fills in for an
  // unscheduled one (clicking "Schedule" on a backlog card, or dropping onto a slot).
  const [startDate, setStartDate] = useState<Date | null>(task ? dayOf(task.startDate) ?? defaultStartDate ?? null : defaultStartDate ?? null);
  const [dueDate, setDueDate] = useState<Date | null>(dayOf(task?.dueDate));
  const [dependencies, setDependencies] = useState<number[]>(task?.dependencies ?? []);
  const [urgency, setUrgency] = useState(task?.urgency ?? 5);
  const [impact, setImpact] = useState(task?.impact ?? 5);
  const [effort, setEffort] = useState(task?.effort ?? 5);
  const [manualScore, setManualScore] = useState(task && task.prioritySource === "manual" ? String(task.priorityScore) : "");
  const [priorityNote, setPriorityNote] = useState(task?.priorityNote ?? "");
  const [tags, setTags] = useState<string[]>(task?.tags ?? []);
  const [confirmingDone, setConfirmingDone] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  const formula = formulaScore(urgency, impact, effort);
  const manual = manualScore.trim() === "" ? null : Math.max(0, Math.min(100, parseInt(manualScore, 10) || 0));
  const effective = manual ?? formula;
  const band = priorityBand(effective);
  const otherTasks = useMemo(() => tasks.filter((t) => !task || t.id !== task.id), [tasks, task]);

  const close = (next: boolean) => {
    if (!next) {
      setConfirmingDone(false);
      setConfirmingDelete(false);
    }
    onOpenChange(next);
  };

  /** Open a brand-new lane straight from the combobox. */
  const createStream = async (name: string): Promise<number | null> => {
    const result = (await streamMutations.create.mutateAsync({ name })) as { stream?: { id: number } };
    return result?.stream?.id ?? null;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      if (isNew) {
        const payload: Record<string, unknown> = { title: title.trim(), urgency, impact, effort, tags };
        if (description) payload.description = description;
        if (externalKey.trim()) payload.externalKey = externalKey.trim();
        if (duration.trim()) payload.estimatedDuration = parseInt(duration, 10);
        if (streamId !== null) payload.streamId = streamId;
        if (appId !== null) payload.appId = appId;
        if (assignedTo !== null) payload.assignedTo = assignedTo;
        if (startDate) payload.startDate = toDayString(startDate);
        if (dueDate) payload.dueDate = toDayString(dueDate);
        if (dependencies.length) payload.dependencies = dependencies;
        const created = (await create.mutateAsync(payload)) as { task: PlanTask };
        if (manual !== null || priorityNote.trim()) {
          await setPriority.mutateAsync({ taskId: created.task.id, urgency, impact, effort, manualScore: manual, note: priorityNote.trim() || undefined });
        }
      } else {
        const patch: Record<string, unknown> = { taskId: task!.id };
        if (title.trim() !== task!.title) patch.title = title.trim();
        if ((description || "") !== (task!.description ?? "")) patch.description = description || null;
        if (externalKey.trim() !== (task!.externalKey ?? "")) patch.externalKey = externalKey.trim() || null;
        const nextDuration = duration.trim() ? parseInt(duration, 10) : null;
        if (nextDuration !== (task!.estimatedDuration ?? null)) patch.estimatedDuration = nextDuration;
        if (streamId !== task!.streamId) patch.streamId = streamId;
        if (appId !== task!.appId) patch.appId = appId;
        if (assignedTo !== task!.assignedTo) patch.assignedTo = assignedTo;
        const nextStart = startDate ? toDayString(startDate) : null;
        if (nextStart !== dayKey(task!.startDate)) patch.startDate = nextStart;
        const nextDue = dueDate ? toDayString(dueDate) : null;
        if (nextDue !== dayKey(task!.dueDate)) patch.dueDate = nextDue;
        if (!sameIds(dependencies, task!.dependencies)) patch.dependencies = dependencies;
        if (urgency !== task!.urgency) patch.urgency = urgency;
        if (impact !== task!.impact) patch.impact = impact;
        if (effort !== task!.effort) patch.effort = effort;
        if (!sameTags(tags, task!.tags)) patch.tags = tags;
        if (Object.keys(patch).length > 1) await update.mutateAsync(patch);

        const hadManual = task!.prioritySource === "manual";
        const manualChanged = manual !== (hadManual ? task!.priorityScore : null);
        const noteChanged = priorityNote.trim() !== (task!.priorityNote ?? "");
        if (manualChanged || noteChanged) {
          await setPriority.mutateAsync({
            taskId: task!.id,
            urgency,
            impact,
            effort,
            manualScore: manual,
            note: priorityNote.trim() || undefined,
          });
        }
      }
      close(false);
    } catch {
      // usePlanAction already surfaced the error as a toast.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-auto nice-scroll border-rule">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle asChild>
              <h2 className="font-display text-2xl tracking-tight">{isNew ? "Draft a card" : "Edit card"}</h2>
            </DialogTitle>
            <div className="flex items-center gap-2">
              {!isNew && <span className="stamp font-mono">№{pad4(task!.id)}</span>}
              {!isNew && task!.completed && <span className="stamp border-sage/60 !text-sage">done</span>}
            </div>
          </div>
          <p className="eyebrow">{isNew ? "A start date puts it straight on the timeline" : "Only the fields you change are sent"}</p>
        </DialogHeader>

        <form onSubmit={submit} className="mt-2 space-y-4">
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="Specify the work" className="draft-input w-full" />
          </Field>

          <Field label="Description">
            <RichEditor value={description} onChange={setDescription} placeholder="Details, links, acceptance, sub-tasks…" />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Duration · days">
              <input
                type="number"
                min={1}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder="—"
                className="draft-input w-full font-mono tabular-nums"
              />
            </Field>
            <Field label="Stream">
              <StreamCombobox
                value={streamId}
                streams={streams}
                onCreate={createStream}
                onChange={(next) => {
                  setStreamId(next);
                  // An app only exists on its own lane; moving lanes drops it.
                  if (appId !== null && next !== null && !apps.find((a) => a.id === appId)?.streamIds.includes(next)) setAppId(null);
                }}
              />
            </Field>
          </div>

          <Field label="App" hint={streamId === null ? "all org apps" : "apps on this stream"}>
            <AppPicker value={appId} streamId={streamId} apps={apps} streams={streams} onChange={setAppId} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="External key">
              <input value={externalKey} onChange={(e) => setExternalKey(e.target.value)} placeholder="JIRA-1234" className="draft-input w-full font-mono" />
            </Field>
            <Field label="Assignee">
              <AssigneePicker value={assignedTo} members={members} onChange={setAssignedTo} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start date" hint={startDate ? "on the timeline" : "in the backlog"}>
              <DatePicker value={startDate} onChange={setStartDate} placeholder="Unscheduled" />
            </Field>
            <Field label="Due date · optional">
              <DatePicker value={dueDate} onChange={setDueDate} placeholder="Derived from duration" />
            </Field>
          </div>

          <Field label="Depends on">
            <DependencyPicker value={dependencies} tasks={otherTasks} excludeId={task?.id} onChange={setDependencies} />
          </Field>

          <div className="paper-flat p-3">
            <div className="flex items-baseline justify-between">
              <span className="eyebrow">Priority</span>
              <span className="flex items-baseline gap-2">
                <span className={cn("font-mono text-2xl font-semibold tabular-nums", band.text)}>{effective}</span>
                <span className="eyebrow">{manual !== null ? "manual" : "formula"} · {band.label}</span>
              </span>
            </div>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <ScoreSlider label="Urgency" value={urgency} onChange={setUrgency} />
              <ScoreSlider label="Impact" value={impact} onChange={setImpact} />
              <ScoreSlider label="Effort" value={effort} onChange={setEffort} />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-[120px_1fr]">
              <Field label="Override">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={manualScore}
                  onChange={(e) => setManualScore(e.target.value)}
                  placeholder={String(formula)}
                  className="draft-input w-full font-mono tabular-nums"
                />
              </Field>
              <Field label="Why" hint={`formula ${urgency}×${impact}/${effort} = ${formula}`}>
                <input value={priorityNote} onChange={(e) => setPriorityNote(e.target.value)} placeholder="Reason for the score" className="draft-input w-full" />
              </Field>
            </div>
          </div>

          <Field label="Tags">
            <TagEditor value={tags} onChange={setTags} />
          </Field>

          {!isNew && <TimePanel taskId={task!.id} open={open} />}
          {!isNew && <HistoryPanel taskId={task!.id} open={open} />}

          <div className="flex flex-wrap items-center gap-2 rule-t pt-3">
            {!isNew && !task!.completed && (
              confirmingDelete ? (
                <span className="flex items-center gap-1.5 border border-vermilion bg-vermilion/10 px-2 py-1.5">
                  <span className="eyebrow !text-vermilion">Delete for good?</span>
                  <button type="button" onClick={async () => { await remove.mutateAsync({ taskId: task!.id }); close(false); }} className="eyebrow border border-vermilion bg-vermilion px-2 py-1 !text-parchment">
                    Yes
                  </button>
                  <button type="button" onClick={() => setConfirmingDelete(false)} className="eyebrow border border-vermilion/40 px-2 py-1 !text-vermilion">
                    No
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => setConfirmingDelete(true)} title="Delete this card" className="flex items-center gap-1.5 border border-rule px-3 py-2 text-ink-muted transition-colors hover:border-vermilion hover:text-vermilion focus-ink">
                  <Trash2 className="h-3 w-3" />
                  <span className="eyebrow !text-current">Delete</span>
                </button>
              )
            )}

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => close(false)} className="border border-rule px-4 py-2 text-sm transition-colors hover:border-ink focus-ink">
                Cancel
              </button>
              <button type="submit" disabled={saving} className="flex items-center gap-2 border border-ink bg-ink px-5 py-2 text-sm text-parchment transition-colors hover:bg-parchment hover:text-ink focus-ink disabled:opacity-60">
                <span className="eyebrow !text-current">{isNew ? (startDate ? "Schedule it" : "Add to backlog") : "Save changes"}</span>
                <ArrowRight className="h-3 w-3" />
              </button>
              {!isNew && !task!.completed && (
                confirmingDone ? (
                  <span role="alertdialog" aria-label="Confirm mark as done" className="flex items-center gap-1.5 border border-sage bg-sage/10 px-2 py-1.5">
                    <span className="eyebrow whitespace-nowrap !text-sage">Mark as done?</span>
                    <button
                      type="button"
                      autoFocus
                      onClick={async () => { await complete.mutateAsync({ taskId: task!.id }); close(false); }}
                      className="eyebrow border border-sage bg-sage px-2 py-1 !text-parchment"
                    >
                      Yes
                    </button>
                    <button type="button" onClick={() => setConfirmingDone(false)} className="eyebrow border border-sage/40 px-2 py-1 !text-sage">
                      No
                    </button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirmingDone(true)} className="flex items-center gap-2 border border-sage bg-sage px-4 py-2 text-sm text-parchment transition-colors hover:bg-parchment hover:text-sage focus-ink">
                    <Check className="h-3 w-3" />
                    <span className="eyebrow !text-current">Done</span>
                  </button>
                )
              )}
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function sameIds(a: number[], b: number[] | undefined): boolean {
  const left = [...a].sort((x, y) => x - y);
  const right = [...(b ?? [])].sort((x, y) => x - y);
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

function sameTags(a: string[], b: string[] | undefined): boolean {
  const left = [...a].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}
