import { useState } from "react";
import { GitBranch, Check, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { wouldCreateCycle } from "./cascade";
import { pad4 } from "./logic";
import type { PlanTask } from "./types";

/**
 * Picks the cards that must finish first. The same `wouldCreateCycle` the
 * server enforces runs here too, so a choice that would be rejected is greyed
 * out with the reason rather than failing on save.
 */
export function DependencyPicker({
  value,
  tasks,
  excludeId,
  onChange,
}: {
  value: number[];
  tasks: PlanTask[];
  /** Id of the card being edited; 0/undefined while drafting a new one. */
  excludeId?: number;
  onChange: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const candidates = tasks.filter((t) => !excludeId || t.id !== excludeId);
  const selected = value.map((id) => tasks.find((t) => t.id === id)).filter((t): t is PlanTask => !!t);

  const toggle = (id: number) => {
    if (value.includes(id)) return onChange(value.filter((v) => v !== id));
    onChange([...value, id]);
  };

  const wouldLoop = (id: number) => !!excludeId && !value.includes(id) && wouldCreateCycle(tasks, excludeId, [...value, id]);

  return (
    <div>
      <div className="mb-2 flex min-h-[26px] flex-wrap gap-1.5">
        {selected.length === 0 && <span className="font-mono text-xs italic text-ink-muted">(no dependencies — this card can start any time)</span>}
        {selected.map((task) => (
          <span key={task.id} className="inline-flex items-center gap-1.5 border border-ink bg-card px-2 py-0.5 text-xs">
            <span className="font-mono text-[10px] text-ink-muted">№{pad4(task.id)}</span>
            <span className="max-w-[160px] truncate">{task.title}</span>
            <button type="button" aria-label={`Remove dependency on ${task.title}`} onClick={() => toggle(task.id)} className="-mr-0.5 text-ink-muted transition-colors hover:text-vermilion">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="draft-input flex w-full items-center justify-between gap-2 text-left text-sm">
            <span className="flex items-center gap-2 text-ink-muted">
              <GitBranch className="h-3.5 w-3.5" />
              {selected.length ? "Add another dependency" : "Add a dependency…"}
            </span>
            <span className="font-mono text-[10px] text-ink-muted">{candidates.length} cards</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[340px] p-0 border-rule">
          <Command className="bg-card">
            <div className="px-3 pt-3 pb-2 rule-b">
              <div className="eyebrow mb-1.5">Pick a card</div>
              <CommandInput placeholder="Search title or number…" className="font-mono text-xs" />
            </div>
            <CommandList className="max-h-64">
              <CommandEmpty>
                <div className="py-3 text-center eyebrow">No matching cards</div>
              </CommandEmpty>
              <CommandGroup heading={`${candidates.length} cards`}>
                {candidates.map((task) => {
                  const isSelected = value.includes(task.id);
                  const loops = wouldLoop(task.id);
                  return (
                    <CommandItem
                      key={task.id}
                      value={`${pad4(task.id)} ${task.title}`}
                      disabled={loops}
                      onSelect={() => !loops && toggle(task.id)}
                      className={cn("text-sm", loops && "opacity-40")}
                      title={loops ? "Would create a dependency cycle" : undefined}
                    >
                      <Check className={cn("mr-2 h-3 w-3 shrink-0", isSelected ? "opacity-100 text-vermilion" : "opacity-0")} />
                      <span className="mr-2 shrink-0 font-mono text-[10px] text-ink-muted">№{pad4(task.id)}</span>
                      <span className="truncate">{task.title}</span>
                      {loops && <span className="ml-auto shrink-0 eyebrow">cycle</span>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
