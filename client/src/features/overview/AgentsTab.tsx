import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, Bot, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchStats, fetchStreamTotals } from "./api";
import { formatAgo, formatMinutes, formatTokens, formatUsd } from "./format";
import type { StreamTotals } from "./types";
import { fetchBudgets, fetchUsageSummary, type StreamBudget, type StreamUsage } from "./usage/api";
import { VerifiedGlyph } from "./usage/bits";
import BudgetControls from "./usage/BudgetControls";
import VerifiedPanel from "./usage/VerifiedPanel";

const KIND_LABEL: Record<string, string> = {
  created: "created",
  status_changed: "moved",
  claimed: "claimed",
  commented: "noted",
  completed: "completed",
  updated: "edited",
  assigned: "assigned",
  deleted: "deleted",
  time_logged: "logged time",
};

/**
 * A budget bar that only draws when a budget exists; otherwise the row just
 * states the spend. The burn is measured against `budget.check`'s figure when it
 * is available, because that one prefers the *verified* cost of each session over
 * the agent's own — a seat cannot buy runway by under-reporting.
 */
function BudgetBar({ row, budget }: { row: StreamTotals; budget?: StreamBudget }) {
  const spent = budget?.spentUsd ?? row.bySource?.agent?.costUsd ?? 0;
  const ceiling = budget?.budgetUsd ?? row.agentBudgetUsd;
  if (ceiling === null || ceiling === undefined || ceiling <= 0) {
    return <span className="eyebrow text-[9px]">no budget set</span>;
  }
  const over = budget?.overBudget ?? row.overBudget;
  const pct = Math.min(100, Math.round((spent / ceiling) * 100));
  return (
    <div>
      <div
        className="h-1.5 overflow-hidden rounded-sm bg-parchment-deep"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${row.name} agent budget used`}
      >
        <div className={cn("h-full", over ? "bg-vermilion" : "bg-sage")} style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <div className="eyebrow font-numeric mt-1 text-[9px]">
        {formatUsd(spent)} of {formatUsd(ceiling)} · {pct}%
        {over ? <span className="ml-1.5 text-vermilion">over</span> : null}
        {budget?.mode === "enforce" ? <span className="ml-1.5">· enforced</span> : null}
      </div>
    </div>
  );
}

export default function AgentsTab() {
  const stats = useQuery({ queryKey: ["/api/org/stats"], queryFn: fetchStats });
  // stream.totals is the Track surface's action. Not having it yet is an expected
  // state during the build-out, so this panel says so instead of erroring.
  const totals = useQuery({ queryKey: ["/api/actions/stream.totals"], queryFn: fetchStreamTotals, retry: false });
  // Both of these are this phase's own reads. Either failing (a member who can see
  // the tab but not the roll-up, say) degrades one panel rather than the page.
  const budgets = useQuery({ queryKey: ["/api/actions/budget.check"], queryFn: fetchBudgets, retry: false });
  const usage = useQuery({ queryKey: ["/api/actions/usage.summary"], queryFn: () => fetchUsageSummary(), retry: false });

  const activity = stats.data?.agentActivity ?? [];
  const cost = stats.data?.agentCost;
  const byStreamBudget = new Map<number, StreamBudget>((budgets.data?.streams ?? []).map((b) => [b.streamId, b]));
  const byStreamUsage = new Map<number | null, StreamUsage>((usage.data?.byStream ?? []).map((s) => [s.streamId, s]));
  const verifiedTotals = usage.data?.totals;

  // stream.totals returns a row per stream including archived ones (zeroed when
  // nothing was logged) plus a trailing streamId:null "(no stream)" bucket. This
  // panel is about live lanes, so archived rows are dropped and a row only earns
  // its space once it has agent spend or a budget to measure that spend against.
  const rows = (Array.isArray(totals.data) ? totals.data : [])
    .filter((r) => !r.archived)
    .filter(
      (r) =>
        (r.bySource?.agent?.minutes ?? 0) > 0 ||
        (r.bySource?.agent?.costUsd ?? 0) > 0 ||
        (r.agentBudgetUsd ?? 0) > 0 ||
        (r.streamId !== null && byStreamBudget.get(r.streamId)?.mode === "enforce"),
    );

  return (
    <div className="space-y-5">
      {/* ---------- agent spend ---------- */}
      <section className="paper-flat">
        <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
          <Bot className="h-3.5 w-3.5" />
          <span className="microcaps">Agent spend</span>
          <span className="eyebrow ml-auto text-[9px]">{stats.data?.members.agents ?? 0} agent seats</span>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-rule sm:grid-cols-4 sm:divide-y-0">
          {[
            { label: "minutes · 7d", value: formatMinutes(cost?.last7d.minutes) },
            { label: "tokens · 7d", value: formatTokens(cost?.last7d.tokens) },
            { label: "cost · 7d", value: formatUsd(cost?.last7d.costUsd) },
            { label: "cost · all time", value: formatUsd(cost?.costUsd) },
          ].map((c) => (
            <div key={c.label} className="px-3 py-2.5">
              <div className="font-numeric text-xl leading-none">{stats.isLoading ? "…" : c.value}</div>
              <div className="eyebrow mt-1.5 text-[9px]">{c.label}</div>
            </div>
          ))}
        </div>
        {verifiedTotals ? (
          <div className="border-t border-rule px-3 py-2">
            <p className="eyebrow font-numeric text-[9px] tabular-nums" data-testid="verified-footnote">
              {verifiedTotals.coveragePct}% of the last 30 days' agent sessions carry usage evidence from something other than
              the agent — {formatUsd(verifiedTotals.unverified.costUsd)} of the figures above is still self-reported.
            </p>
          </div>
        ) : null}
      </section>

      {/* ---------- reported vs verified ---------- */}
      <VerifiedPanel />

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ---------- per-stream cost / budget ---------- */}
        <section className="paper-flat" data-testid="stream-totals">
          <div className="flex items-center justify-between border-b border-rule px-3 py-2">
            <span className="microcaps">Cost by stream</span>
            <span className="eyebrow text-[9px]">
              {budgets.data ? `${budgets.data.totals.enforced} enforced` : "from Track"}
            </span>
          </div>
          {totals.isLoading ? (
            <div className="py-10 text-center">
              <Loader2 className="mx-auto h-4 w-4 animate-spin text-ink-muted" />
            </div>
          ) : totals.error ? (
            <div className="px-3 py-8 text-center" data-testid="stream-totals-unavailable">
              <AlertTriangle className="mx-auto h-4 w-4 text-ink-muted" />
              <p className="mt-2 font-serif text-sm italic text-ink-muted">Not available yet.</p>
              <p className="eyebrow mt-1 text-[9px]">stream.totals — the Track surface owns this figure.</p>
            </div>
          ) : rows.length === 0 ? (
            <p className="px-3 py-8 text-center font-serif text-sm italic text-ink-muted">
              No agent time logged against a stream yet.
            </p>
          ) : (
            <ul className="divide-y divide-rule">
              {rows.map((r) => {
                const lane = r.streamId === null ? undefined : byStreamBudget.get(r.streamId);
                const seen = byStreamUsage.get(r.streamId);
                return (
                  <li key={String(r.streamId)} className="px-3 py-2.5" data-testid={`stream-total-${r.streamId}`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate font-serif">{r.name}</span>
                        {seen ? <VerifiedGlyph verified={seen.verifiedEntries} entries={seen.entries} pct={seen.coveragePct} /> : null}
                      </span>
                      <span className="font-numeric shrink-0 text-sm">{formatUsd(r.bySource?.agent?.costUsd)}</span>
                    </div>
                    <div className="eyebrow font-numeric mt-0.5 text-[9px]">
                      agent {formatMinutes(r.bySource?.agent?.minutes)} · {formatTokens(r.bySource?.agent?.tokens)} tok
                      <span className="mx-1.5">·</span>
                      human {formatMinutes(r.bySource?.human?.minutes)}
                      {seen && seen.verifiedEntries > 0 ? (
                        <>
                          <span className="mx-1.5">·</span>
                          verified {formatTokens(seen.verified.tokens)} tok · {formatUsd(seen.verified.costUsd)}
                        </>
                      ) : null}
                    </div>
                    <div className="mt-2">
                      <BudgetBar row={r} budget={lane} />
                    </div>
                    {lane ? <BudgetControls budget={lane} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {budgets.error ? (
            <p className="eyebrow border-t border-rule px-3 py-1.5 text-[9px]" data-testid="budgets-unavailable">
              budget.check could not be read, so the ceilings here are not editable: {(budgets.error as Error).message}
            </p>
          ) : null}
        </section>

        {/* ---------- activity feed ---------- */}
        <section className="paper-flat" data-testid="agent-activity">
          <div className="flex items-center justify-between border-b border-rule px-3 py-2">
            <span className="microcaps">Recent agent activity</span>
            <span className="eyebrow font-numeric text-[9px]">last {activity.length}</span>
          </div>
          {stats.isLoading ? (
            <div className="py-10 text-center">
              <Loader2 className="mx-auto h-4 w-4 animate-spin text-ink-muted" />
            </div>
          ) : activity.length === 0 ? (
            <p className="px-3 py-8 text-center font-serif text-sm italic text-ink-muted">No agent has touched a task yet.</p>
          ) : (
            <ol className="divide-y divide-rule">
              {activity.map((e) => (
                <li key={e.id} className="px-3 py-2.5" data-testid={`activity-${e.id}`}>
                  <div className="flex items-baseline gap-2">
                    <span className="eyebrow shrink-0 text-[9px]">{e.actorLabel ?? `user ${e.actorUserId}`}</span>
                    <span className="text-xs text-ink-muted">{KIND_LABEL[e.kind] ?? e.kind}</span>
                    <span className="eyebrow font-numeric ml-auto shrink-0 text-[9px]">{formatAgo(e.createdAt)}</span>
                  </div>
                  <div className="mt-0.5 font-serif text-sm">
                    {e.taskId ? (
                      <Link to={`/plan?task=${e.taskId}`} className="rounded-sm hover:text-vermilion focus-ink">
                        {e.taskTitle ?? `task #${e.taskId}`}
                      </Link>
                    ) : (
                      <span className="text-ink-muted">a deleted task</span>
                    )}
                  </div>
                  {e.note ? <p className="mt-0.5 font-serif text-xs italic text-ink-muted">{e.note}</p> : null}
                  <span className="stamp mt-1.5 inline-block border-rule text-ink-muted">via {e.via}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
