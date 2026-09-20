import { formatMinutes, formatUsd } from "../format";
import type { AppHybrid } from "./api";
import { Empty } from "./bits";

/**
 * Which apps the hours went into, and how much of each was the machines.
 *
 * Drawn as proportion bars rather than a chart: the comparison that matters is
 * within each row (how much of *this* app was agent work), and the bars are scaled
 * against the busiest app so the rows also compare to each other at a glance.
 * An app a session reaches through its task, which is why an entry logged against
 * no task lands in "(no app)" rather than being silently dropped.
 */
export default function AppSplit({ rows }: { rows: AppHybrid[] }) {
  if (rows.length === 0) return <Empty>Nothing was logged against an app in this window.</Empty>;
  const busiest = rows.reduce((max, r) => Math.max(max, r.minutes), 0) || 1;

  return (
    <ul className="divide-y divide-rule">
      {rows.map((r) => {
        const width = Math.max(2, Math.round((r.minutes / busiest) * 100));
        const agentShare = r.minutes > 0 ? (r.agent.minutes / r.minutes) * 100 : 0;
        return (
          <li key={String(r.appId)} className="px-3 py-2.5" data-testid={`hybrid-app-${r.appId}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-serif">
                {r.name}
                {r.key ? <span className="eyebrow ml-2 text-[9px]">{r.key}</span> : null}
              </span>
              <span className="font-numeric shrink-0 text-sm tabular-nums">{formatMinutes(r.minutes)}</span>
            </div>

            {/* One bar, split at the agent's share: ink then vermilion. */}
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-sm bg-parchment-deep">
              <div className="flex h-full" style={{ width: `${width}%` }} title={`${r.agentSharePct}% of ${formatMinutes(r.minutes)} was agent work`}>
                <div className="h-full bg-ink" style={{ width: `${100 - agentShare}%` }} />
                <div className="h-full bg-vermilion" style={{ width: `${agentShare}%` }} />
              </div>
            </div>

            <p className="eyebrow font-numeric mt-1 text-[9px] tabular-nums">
              human {formatMinutes(r.human.minutes)}
              <span className="mx-1.5">·</span>
              <span className="text-vermilion">
                agent {formatMinutes(r.agent.minutes)} · {r.agentSharePct}%
                {r.agent.costUsd > 0 ? ` · ${formatUsd(r.agent.costUsd)}` : ""}
              </span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}
