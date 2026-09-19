import { useMemo, useState } from "react";
import { Check, Layers, ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { CustomerPick, StreamPick, TaskPick } from "./api";

/**
 * The cascading picker: stream first, then a task inside it.
 *
 * Choosing a task also adopts that task's stream, since the server derives the
 * stream from the task anyway — picking "Fix the invoice PDF" and then being
 * asked which lane it lives in would be asking the user for something the
 * ledger already knows. The caller's own assignments are listed first, because
 * that is what a member is nearly always about to start work on.
 */
export function StreamTaskPicker({
  streams,
  tasks,
  customers,
  streamId,
  taskId,
  onChange,
  disabled,
}: {
  streams: StreamPick[];
  tasks: TaskPick[];
  customers: CustomerPick[];
  streamId?: number;
  taskId?: number;
  onChange: (next: { streamId?: number; taskId?: number }) => void;
  disabled?: boolean;
}) {
  const [streamOpen, setStreamOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const stream = streams.find((s) => s.id === streamId);
  const task = tasks.find((t) => t.id === taskId);
  const customer = customers.find((c) => c.id === stream?.customerId);

  const visibleTasks = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const inStream = streamId ? tasks.filter((t) => t.streamId === streamId) : tasks;
    const matched = q ? inStream.filter((t) => t.title.toLowerCase().includes(q)) : inStream;
    return {
      mine: matched.filter((t) => t.mine),
      rest: matched.filter((t) => !t.mine),
    };
  }, [tasks, streamId, filter]);

  const rowClass = (active: boolean) =>
    cn(
      "w-full text-left px-3 py-2 flex items-center gap-2 border rounded-sm transition-colors focus-ink",
      active ? "border-ink bg-parchment-deep" : "border-rule hover:border-ink/50 hover:bg-parchment-deep/60"
    );

  return (
    <div className="space-y-3">
      {/* ── Stream ── */}
      <div>
        <span className="eyebrow block mb-2">Stream</span>
        <Dialog open={streamOpen} onOpenChange={setStreamOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              disabled={disabled}
              className="w-full h-12 justify-between rounded-sm border-ink/30 bg-transparent font-serif text-base px-4 hover:bg-parchment-deep hover:border-ink/60"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: stream?.color || "hsl(var(--ink) / 0.2)" }} aria-hidden />
                <span className={cn("italic truncate", stream ? "text-ink" : "text-ink-muted")}>{stream ? stream.name : "Attach a stream (optional)…"}</span>
              </span>
              <span className="eyebrow text-[10px] shrink-0">Select</span>
            </Button>
          </DialogTrigger>
          <DialogContent className="paper w-[95vw] max-w-[480px] max-h-[85vh] overflow-y-auto rounded-sm border-ink/20">
            <DialogTitle className="font-display font-normal italic text-2xl">Choose a stream</DialogTitle>
            <DialogDescription className="font-serif">
              Streams are the swim-lanes on the Plan board. A stream's customer is billed automatically.
            </DialogDescription>
            <div className="mt-3 grid gap-1">
              <button
                type="button"
                onClick={() => {
                  onChange({ streamId: undefined, taskId: undefined });
                  setStreamOpen(false);
                }}
                className={rowClass(!streamId)}
              >
                <Layers className="h-4 w-4 text-ink-muted" strokeWidth={1.5} />
                <span className="font-serif italic text-ink-muted">No stream — unattributed time</span>
                {!streamId && <Check className="h-4 w-4 ml-auto text-vermilion" />}
              </button>
              {streams.length === 0 && (
                <p className="px-3 py-4 font-display italic text-sm text-ink-muted">
                  No streams yet. They are opened on the Plan surface; time logged without one still counts.
                </p>
              )}
              {streams.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    // Moving to a different stream drops a task from the old one.
                    onChange({ streamId: s.id, taskId: task && task.streamId === s.id ? task.id : undefined });
                    setStreamOpen(false);
                  }}
                  className={rowClass(s.id === streamId)}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color || "hsl(var(--vermilion))" }} aria-hidden />
                  <span className="font-serif truncate">{s.name}</span>
                  {s.agentBudgetUsd != null && <span className="eyebrow text-[9px] ml-1">budget ${s.agentBudgetUsd}</span>}
                  {s.id === streamId && <Check className="h-4 w-4 ml-auto text-vermilion" />}
                </button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* ── Task ── */}
      <div>
        <span className="eyebrow block mb-2">Task</span>
        <Dialog open={taskOpen} onOpenChange={setTaskOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              disabled={disabled}
              className="w-full h-12 justify-between rounded-sm border-ink/30 bg-transparent font-serif text-base px-4 hover:bg-parchment-deep hover:border-ink/60"
            >
              <span className="flex items-center gap-2 min-w-0">
                <ListTodo className="h-4 w-4 shrink-0 text-ink-muted" strokeWidth={1.5} />
                <span className={cn("italic truncate", task ? "text-ink" : "text-ink-muted")}>{task ? task.title : "Attach a task (optional)…"}</span>
              </span>
              <span className="eyebrow text-[10px] shrink-0">Select</span>
            </Button>
          </DialogTrigger>
          <DialogContent className="paper w-[95vw] max-w-[520px] max-h-[85vh] overflow-y-auto rounded-sm border-ink/20">
            <DialogTitle className="font-display font-normal italic text-2xl">Choose a task</DialogTitle>
            <DialogDescription className="font-serif">
              Open tasks{stream ? <> in <span className="italic">{stream.name}</span></> : " across the organization"}. Yours first.
            </DialogDescription>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by title…"
              className="h-10 mt-3 rounded-sm border-ink/30 font-serif"
            />
            <ScrollArea className="max-h-[46vh] mt-3">
              <div className="grid gap-1 pr-2">
                <button
                  type="button"
                  onClick={() => {
                    onChange({ streamId, taskId: undefined });
                    setTaskOpen(false);
                  }}
                  className={rowClass(!taskId)}
                >
                  <span className="font-serif italic text-ink-muted">No task — stream only</span>
                  {!taskId && <Check className="h-4 w-4 ml-auto text-vermilion" />}
                </button>

                {(["mine", "rest"] as const).map((group) =>
                  visibleTasks[group].length === 0 ? null : (
                    <div key={group} className="mt-2">
                      <div className="eyebrow text-[9px] mb-1">{group === "mine" ? "Assigned to you" : "Elsewhere in the organization"}</div>
                      <div className="grid gap-1">
                        {visibleTasks[group].map((t) => {
                          const lane = streams.find((s) => s.id === t.streamId);
                          return (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => {
                                // A task carries its own stream — the server would
                                // derive it anyway, so reflect that here.
                                onChange({ streamId: t.streamId ?? undefined, taskId: t.id });
                                setTaskOpen(false);
                              }}
                              className={rowClass(t.id === taskId)}
                            >
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: lane?.color || "hsl(var(--ink) / 0.25)" }} aria-hidden />
                              <span className="font-serif truncate">{t.title}</span>
                              <span className="eyebrow text-[9px] ml-auto shrink-0">{t.status}</span>
                              {t.id === taskId && <Check className="h-4 w-4 text-vermilion shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )
                )}

                {visibleTasks.mine.length === 0 && visibleTasks.rest.length === 0 && (
                  <p className="px-3 py-4 font-display italic text-sm text-ink-muted">
                    No open tasks {stream ? "in this stream" : "yet"}. Time can still be logged to the stream alone.
                  </p>
                )}
              </div>
            </ScrollArea>
          </DialogContent>
        </Dialog>
      </div>

      {customer && (
        <p className="eyebrow text-[10px]">
          Billed to <span className="font-display italic text-[11px] normal-case tracking-normal text-ink">{customer.name}</span>
        </p>
      )}
    </div>
  );
}

export default StreamTaskPicker;
