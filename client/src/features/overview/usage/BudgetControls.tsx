import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, BellRing, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { formatUsd } from "../format";
import { setStreamBudget, type BudgetMode, type StreamBudget } from "./api";

/**
 * The budget field and the thing that makes it mean something.
 *
 * `alert` is what a budget has always been here: a bar that turns red. `enforce`
 * makes it a wall — `next_task` stops handing an agent work in this lane once the
 * month's spend reaches the ceiling, and a `budget.exhausted` webhook fires. The
 * toggle sits next to the number because the number alone never said which of the
 * two it was, which is exactly the confusion this phase removes.
 *
 * Humans are never blocked, and the panel says so, because "enforce" on a shared
 * lane reads alarming until you know who it applies to.
 */
export default function BudgetControls({ budget }: { budget: StreamBudget }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState(budget.budgetUsd === null ? "" : String(budget.budgetUsd));

  // The row re-renders from a fresh read after every save; keep the field in step
  // unless the person is mid-edit (a differing draft is theirs, not stale).
  useEffect(() => {
    setDraft(budget.budgetUsd === null ? "" : String(budget.budgetUsd));
  }, [budget.budgetUsd]);

  const save = useMutation({
    mutationFn: (input: { agentBudgetUsd?: number | null; budgetMode?: BudgetMode }) =>
      setStreamBudget({ streamId: budget.streamId, ...input }),
    onSuccess: (_data, input) => {
      qc.invalidateQueries({ queryKey: ["/api/actions/budget.check"] });
      qc.invalidateQueries({ queryKey: ["/api/actions/stream.totals"] });
      toast({
        title: input.budgetMode ? `${budget.name}: ${input.budgetMode} mode` : `${budget.name}: budget saved`,
        description:
          input.budgetMode === "enforce"
            ? "Agents will be refused work in this stream once the month's spend reaches the ceiling. People are not affected."
            : input.budgetMode === "alert"
              ? "Over-budget will be reported, not enforced."
              : input.agentBudgetUsd === null
                ? "Ceiling removed."
                : `Ceiling set to ${formatUsd(input.agentBudgetUsd ?? 0)} per month.`,
      });
    },
    onError: (err: Error) => toast({ title: "Could not save the budget", description: err.message, variant: "destructive" }),
  });

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (budget.budgetUsd !== null) save.mutate({ agentBudgetUsd: null });
      return;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) {
      toast({ title: "That is not an amount", description: "Give a number of dollars, or clear the field to remove the ceiling.", variant: "destructive" });
      return;
    }
    if (value !== budget.budgetUsd) save.mutate({ agentBudgetUsd: value });
  };

  const modes: { mode: BudgetMode; label: string; icon: typeof BellRing; hint: string }[] = [
    { mode: "alert", label: "alert", icon: BellRing, hint: "Report it and carry on — the behaviour PTD has always had." },
    { mode: "enforce", label: "enforce", icon: Ban, hint: "Refuse agent work in this stream once the ceiling is reached. People are never blocked." },
  ];

  return (
    <div className="mt-2 flex flex-wrap items-end gap-3" data-testid={`budget-controls-${budget.streamId}`}>
      <label className="block">
        <span className="eyebrow text-[9px]">monthly agent ceiling · USD</span>
        <div className="mt-0.5 flex items-center gap-1">
          <span className="font-numeric text-sm text-ink-muted">$</span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setDraft(budget.budgetUsd === null ? "" : String(budget.budgetUsd));
            }}
            inputMode="decimal"
            placeholder="none"
            aria-label={`${budget.name} monthly agent budget in US dollars`}
            className="draft-input font-numeric w-20 text-sm tabular-nums focus-ink"
            data-testid={`budget-input-${budget.streamId}`}
          />
        </div>
      </label>

      <div>
        <span className="eyebrow text-[9px]">when it is spent</span>
        <div className="mt-0.5 inline-flex overflow-hidden rounded-sm border border-rule" role="group" aria-label={`${budget.name} budget mode`}>
          {modes.map(({ mode, label, icon: Icon, hint }) => {
            const active = budget.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                title={hint}
                aria-pressed={active}
                disabled={save.isPending}
                onClick={() => {
                  if (!active) save.mutate({ budgetMode: mode });
                }}
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-1 transition-colors focus-ink disabled:opacity-60",
                  active ? "bg-ink text-parchment" : "text-ink-muted hover:text-ink",
                )}
                data-testid={`budget-mode-${mode}-${budget.streamId}`}
              >
                {save.isPending && !active ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
                <span className="eyebrow text-[9px] !text-current">{label}</span>
                {active ? <Check className="h-3 w-3" /> : null}
              </button>
            );
          })}
        </div>
      </div>

      {budget.blocked ? (
        <p className="eyebrow text-[9px] text-vermilion" data-testid={`budget-blocked-${budget.streamId}`}>
          agents refused here this month · {formatUsd(budget.spentUsd)} of {formatUsd(budget.budgetUsd ?? 0)}
        </p>
      ) : budget.enforced ? (
        <p className="eyebrow text-[9px]">{formatUsd(budget.remainingUsd ?? 0)} left before agents are refused</p>
      ) : null}
    </div>
  );
}
