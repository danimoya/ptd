import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, Bot, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchStats, fetchStreamTotals } from "./api";
import { formatAgo, formatMinutes, formatTokens, formatUsd } from "./format";
import type { StreamTotals } from "./types";

const KIND_LABEL: Record<string, string> = {
  created: "created",
  status_changed: "moved",
  claimed: "claimed",
  commented: "noted",
  completed: "completed",
  updated: "edited",
  assigned: "assigned",
  deleted: "deleted",
};

/** A budget bar that only draws when a budget exists; otherwise the row just states the spend. */
function BudgetBar({ row }: { row: StreamTotals }) {
  const spent = row.bySource?.agent?.costUsd ?? 0;
  const budget = row.agentBudgetUsd;
  if (budget === null || budget === undefined || budget <= 0) {
    return <span className="eyebrow text-[9px]">no budget set</span>;
  }
  const pct = Math.min(100, Math.round((spent / budget) * 100));
  return (
    <div>
      <div className="h-1.5 bg-parchment-deep rounded-sm overflow-hidden" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${row.name} agent budget used`}>
        <div className={cn("h-full", row.overBudget ? "bg-vermilion" : "bg-sage")} style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <div className="eyebrow text-[9px] mt-1 font-numeric">
        {formatUsd(spent)} of {formatUsd(budget)} · {pct}%
        {row.overBudget ? <span className="text-vermilion ml-1.5">over</span> : null}
      </div>
    </div>
  );
}

export default function AgentsTab() {
  const stats = useQuery({ queryKey: ["/api/org/stats"], queryFn: fetchStats });
  // stream.totals is the Track surface's action. Not having it yet is an expected
  // state during the build-out, so this panel says so instead of erroring.
  const totals = useQuery({ queryKey: ["/api/actions/stream.totals"], queryFn: fetchStreamTotals, retry: false });

  const activity = stats.data?.agentActivity ?? [];
  const cost = stats.data?.agentCost;
  // stream.totals returns a row per stream including archived ones (zeroed when
  // nothing was logged) plus a trailing streamId:null "(no stream)" bucket. This
  // panel is about live lanes, so archived rows are dropped and a row only earns
  // its space once it has agent spend or a budget to measure that spend against.
  const rows = (Array.isArray(totals.data) ? totals.data : [])
    .filter((r) => !r.archived)
    .filter((r) => (r.bySource?.agent?.minutes ?? 0) > 0 || (r.bySource?.agent?.costUsd ?? 0) > 0 || (r.agentBudgetUsd ?? 0) > 0);

  return (
    <div className="space-y-5">
      {/* ---------- agent spend ---------- */}
      <section className="paper-flat">
        <div className="px-3 py-2 border-b border-rule flex items-center gap-2">
          <Bot className="h-3.5 w-3.5" />
          <span className="microcaps">Agent spend</span>
          <span className="eyebrow text-[9px] ml-auto">{stats.data?.members.agents ?? 0} agent seats</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-rule">
          {[
            { label: "minutes · 7d", value: formatMinutes(cost?.last7d.minutes) },
            { label: "tokens · 7d", value: formatTokens(cost?.last7d.tokens) },
            { label: "cost · 7d", value: formatUsd(cost?.last7d.costUsd) },
            { label: "cost · all time", value: formatUsd(cost?.costUsd) },
          ].map((c) => (
            <div key={c.label} className="px-3 py-2.5">
              <div className="font-numeric text-xl leading-none">{stats.isLoading ? "…" : c.value}</div>
              <div className="eyebrow text-[9px] mt-1.5">{c.label}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ---------- per-stream cost / budget ---------- */}
        <section className="paper-flat" data-testid="stream-totals">
          <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
            <span className="microcaps">Cost by stream</span>
            <span className="eyebrow text-[9px]">from Track</span>
          </div>
          {totals.isLoading ? (
            <div className="py-10 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></div>
          ) : totals.error ? (
            <div className="px-3 py-8 text-center" data-testid="stream-totals-unavailable">
              <AlertTriangle className="h-4 w-4 mx-auto text-ink-muted" />
              <p className="font-serif italic text-ink-muted mt-2 text-sm">Not available yet.</p>
              <p className="eyebrow text-[9px] mt-1">stream.totals — the Track surface owns this figure.</p>
            </div>
          ) : rows.length === 0 ? (
            <p className="px-3 py-8 text-center font-serif italic text-ink-muted text-sm">No agent time logged against a stream yet.</p>
          ) : (
            <ul className="divide-y divide-rule">
              {rows.map((r) => (
                <li key={String(r.streamId)} className="px-3 py-2.5" data-testid={`stream-total-${r.streamId}`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-serif truncate">{r.name}</span>
                    <span className="font-numeric text-sm shrink-0">{formatUsd(r.bySource?.agent?.costUsd)}</span>
                  </div>
                  <div className="eyebrow text-[9px] mt-0.5 font-numeric">
                    agent {formatMinutes(r.bySource?.agent?.minutes)} · {formatTokens(r.bySource?.agent?.tokens)} tok
                    <span className="mx-1.5">·</span>
                    human {formatMinutes(r.bySource?.human?.minutes)}
                  </div>
                  <div className="mt-2">
                    <BudgetBar row={r} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---------- activity feed ---------- */}
        <section className="paper-flat" data-testid="agent-activity">
          <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
            <span className="microcaps">Recent agent activity</span>
            <span className="eyebrow text-[9px] font-numeric">last {activity.length}</span>
          </div>
          {stats.isLoading ? (
            <div className="py-10 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></div>
          ) : activity.length === 0 ? (
            <p className="px-3 py-8 text-center font-serif italic text-ink-muted text-sm">No agent has touched a task yet.</p>
          ) : (
            <ol className="divide-y divide-rule">
              {activity.map((e) => (
                <li key={e.id} className="px-3 py-2.5" data-testid={`activity-${e.id}`}>
                  <div className="flex items-baseline gap-2">
                    <span className="eyebrow text-[9px] shrink-0">{e.actorLabel ?? `user ${e.actorUserId}`}</span>
                    <span className="text-xs text-ink-muted">{KIND_LABEL[e.kind] ?? e.kind}</span>
                    <span className="eyebrow text-[9px] ml-auto shrink-0 font-numeric">{formatAgo(e.createdAt)}</span>
                  </div>
                  <div className="mt-0.5 text-sm font-serif">
                    {e.taskId ? (
                      <Link to={`/plan?task=${e.taskId}`} className="hover:text-vermilion focus-ink rounded-sm">
                        {e.taskTitle ?? `task #${e.taskId}`}
                      </Link>
                    ) : (
                      <span className="text-ink-muted">a deleted task</span>
                    )}
                  </div>
                  {e.note ? <p className="text-xs font-serif italic text-ink-muted mt-0.5">{e.note}</p> : null}
                  <span className="stamp border-rule text-ink-muted mt-1.5 inline-block">via {e.via}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
