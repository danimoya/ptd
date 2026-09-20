import { formatMinutes, formatTokens, formatUsd } from "../format";
import type { StreamHybrid } from "./api";
import { BurnMeter, Empty, SplitPair } from "./bits";

/**
 * Agent spend per stream, against the budget that stream was given.
 *
 * A stream with a budget is listed even at zero spend — an authorised budget
 * nobody has drawn on is a fact about the month, not an empty row. A stream with
 * neither spend nor budget is dropped, because it has nothing to say on this page.
 */
export default function StreamBudgets({ rows }: { rows: StreamHybrid[] }) {
  const shown = rows.filter((r) => r.agent.costUsd > 0 || r.agent.minutes > 0 || r.agentBudgetUsd !== null);
  if (shown.length === 0) return <Empty>No agent has billed a stream in this window.</Empty>;

  return (
    <ul className="divide-y divide-rule">
      {shown.map((r) => (
        <li key={String(r.streamId)} className="px-3 py-2.5" data-testid={`hybrid-stream-${r.streamId}`}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate font-serif">
              {r.name}
              {r.archived ? <span className="eyebrow ml-2 text-[9px]">archived</span> : null}
            </span>
            <span className={`font-numeric shrink-0 text-sm tabular-nums ${r.overBudget ? "text-vermilion" : "text-ink"}`}>
              {formatUsd(r.agent.costUsd)}
            </span>
          </div>

          <div className="mt-1">
            <SplitPair
              human={formatMinutes(r.human.minutes)}
              agent={formatMinutes(r.agent.minutes)}
              extra={
                <span className="text-ink-muted">
                  {r.agentSharePct}% of hours{r.agent.tokens > 0 ? ` · ${formatTokens(r.agent.tokens)} tok` : ""}
                </span>
              }
            />
          </div>

          <div className="mt-2">
            {r.agentBudgetUsd === null ? (
              <p className="eyebrow text-[9px]" title="Set a budget on the stream to measure spend against it.">
                no agent budget set
              </p>
            ) : (
              <>
                <BurnMeter pct={r.burnPct ?? 0} over={r.overBudget} label={`${r.name} agent budget used`} />
                <p className="eyebrow font-numeric mt-1 text-[9px] tabular-nums">
                  {formatUsd(r.agent.costUsd)} of {formatUsd(r.agentBudgetUsd)} · {r.burnPct}%
                  {r.overBudget ? (
                    <span className="ml-1.5 text-vermilion">over by {formatUsd(Math.abs(r.remainingUsd ?? 0))}</span>
                  ) : (
                    <span className="ml-1.5">{formatUsd(r.remainingUsd ?? 0)} left</span>
                  )}
                </p>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
