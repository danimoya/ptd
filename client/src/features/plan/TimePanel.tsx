import { Bot, Timer, User as UserIcon } from "lucide-react";
import { useTaskTotals } from "./api";

/**
 * Logged time for the card, from the Track surface's `task.totals` action.
 *
 * Plan does not own that action, so any failure — including the 404 while it is
 * still unimplemented — is rendered as "no time logged yet" rather than an
 * error. Same for a zero total.
 */
export function TimePanel({ taskId, open }: { taskId: number; open: boolean }) {
  const { data, isLoading, isError } = useTaskTotals(taskId, open);

  return (
    <details className="rule-t pt-3">
      <summary className="flex cursor-pointer items-center justify-between text-sm">
        <span className="eyebrow">Time</span>
        <span className="font-mono text-xs tabular-nums text-ink-muted">
          {isLoading ? "…" : isError || !data || !data.minutes ? "—" : hm(data.minutes)}
        </span>
      </summary>
      <div className="mt-3 text-xs">
        {isLoading && <div className="eyebrow">Loading…</div>}
        {!isLoading && (isError || !data || !data.minutes) && (
          <div className="font-serif text-ink-muted">
            <Timer className="mr-1.5 -mt-0.5 inline h-3 w-3" />
            no time logged yet
          </div>
        )}
        {!isLoading && !isError && data && !!data.minutes && (
          <div className="grid grid-cols-2 gap-3">
            <div className="paper-flat p-2.5">
              <div className="eyebrow flex items-center gap-1.5">
                <UserIcon className="h-3 w-3" /> Human
              </div>
              <div className="mt-1 font-mono text-base tabular-nums">{hm(data.bySource?.human?.minutes ?? 0)}</div>
            </div>
            <div className="paper-flat p-2.5">
              <div className="eyebrow flex items-center gap-1.5">
                <Bot className="h-3 w-3" /> Agent
              </div>
              <div className="mt-1 font-mono text-base tabular-nums">{hm(data.bySource?.agent?.minutes ?? 0)}</div>
              <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
                {fmtTokens(data.bySource?.agent?.tokens)} · {fmtCost(data.bySource?.agent?.costUsd)}
              </div>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function fmtTokens(tokens?: number | null): string {
  if (!tokens) return "0 tokens";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

function fmtCost(costUsd?: number | null): string {
  if (!costUsd) return "$0.00";
  return `$${costUsd.toFixed(2)}`;
}
