import { cn } from "@/lib/utils";
import { formatUsd } from "./format";
import type { OrgStats } from "./types";

/**
 * The ledger header: seven figures, hairline-separated, tabular so the digits
 * line up column to column the way a printed balance sheet does.
 */
export default function KpiStrip({ stats, loading }: { stats?: OrgStats; loading?: boolean }) {
  const cells: { label: string; value: string; tone?: string; title?: string }[] = stats
    ? [
        { label: "apps", value: String(stats.apps) },
        { label: "open", value: String(stats.tasks.open), title: "backlog + triaged + in progress" },
        { label: "critical", value: String(stats.byPriorityBand.critical), tone: "text-vermilion", title: "open tasks scoring 75-100" },
        { label: "high", value: String(stats.byPriorityBand.high), tone: "text-[#9a6a12] dark:text-[#d6a243]", title: "open tasks scoring 50-74" },
        { label: "in progress", value: String(stats.tasks.inProgress) },
        { label: "completed", value: String(stats.tasks.completed), tone: "text-sage" },
        { label: "agent · 7d", value: formatUsd(stats.agentCost.last7d.costUsd), title: `${stats.agentCost.last7d.tokens.toLocaleString()} tokens over ${stats.agentCost.last7d.entries} entries` },
      ]
    : [];

  if (loading || !stats) {
    return (
      <div className="paper-flat grid grid-cols-3 sm:grid-cols-7 divide-x divide-rule" data-testid="kpi-strip-loading">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="px-3 py-3">
            <div className="h-6 w-10 bg-ink/10 rounded-sm animate-pulse" />
            <div className="h-2 w-12 bg-ink/10 rounded-sm mt-2 animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="paper-flat grid grid-cols-3 sm:grid-cols-7 divide-x divide-y sm:divide-y-0 divide-rule" data-testid="kpi-strip">
      {cells.map((c) => (
        <div key={c.label} className="px-3 py-2.5" title={c.title}>
          <div className={cn("font-numeric text-2xl leading-none", c.tone ?? "text-ink")}>{c.value}</div>
          <div className="eyebrow text-[9px] mt-1.5 truncate">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

/** Two secondary figures that do not deserve a KPI cell but are worth stating. */
export function KpiFootnote({ stats }: { stats?: OrgStats }) {
  if (!stats) return null;
  return (
    <p className="eyebrow text-[10px] mt-2 text-ink-muted">
      {stats.overdue > 0 ? (
        <>
          <span className="text-vermilion">{stats.overdue} overdue</span>
          <span className="mx-2">·</span>
        </>
      ) : null}
      {stats.streams} streams<span className="mx-2">·</span>
      {stats.members.humans} humans, {stats.members.agents} agents
      <span className="mx-2">·</span>
      agent spend all time {formatUsd(stats.agentCost.costUsd)}
    </p>
  );
}
