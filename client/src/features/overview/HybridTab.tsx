import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMinutes, formatTokens, formatUsd } from "./format";
import { fetchHybrid, type HybridGroupBy, type HybridSummary } from "./hybrid/api";
import { PRESETS, describeRange, presetFor, rangeFor, type PresetKey } from "./hybrid/ranges";
import { Panel, Tile } from "./hybrid/bits";
import SplitBars from "./hybrid/SplitBars";
import StreamBudgets from "./hybrid/StreamBudgets";
import AppSplit from "./hybrid/AppSplit";
import AgentTable from "./hybrid/AgentTable";

/**
 * Overview → Hybrid: what the organization's work cost, split between the people
 * and the machines.
 *
 * The page is arranged as an argument rather than a pile of charts. First the
 * paragraph, which states the finding in words. Then the six figures it is made
 * of. Then the chart that shows the shape over time. Then the two questions a
 * manager asks next — *is any stream burning its budget?* and *which apps is this
 * happening in?* — side by side. Then the seats, and the price of a finished task.
 *
 * The window lives in the query string, so a reading can be linked: the 90-day
 * view of a bad month is a URL you can paste into a meeting invitation.
 */

const isPreset = (value: string | null): value is PresetKey => PRESETS.some((p) => p.key === value);

export default function HybridTab() {
  const [params, setParams] = useSearchParams();
  const preset: PresetKey = isPreset(params.get("range")) ? (params.get("range") as PresetKey) : "30d";
  const byParam = params.get("by");
  const groupBy: HybridGroupBy = byParam === "day" || byParam === "week" ? byParam : presetFor(preset).groupBy;

  // Recomputed per render, but only per day in practice — the range is whole days,
  // so the query key is stable for as long as anyone looks at the page.
  const range = useMemo(() => rangeFor(preset), [preset]);

  const summary = useQuery<HybridSummary>({
    queryKey: ["/api/actions/hybrid.summary", range.from, range.to, groupBy],
    queryFn: () => fetchHybrid({ from: range.from, to: range.to, groupBy }),
    staleTime: 30_000,
  });

  const setPreset = (key: PresetKey) => {
    const next = new URLSearchParams(params);
    next.set("range", key);
    // A preset carries its own default bucket; an explicit choice is dropped so
    // switching to 90 days does not leave 90 daily bars behind.
    next.delete("by");
    setParams(next, { replace: true });
  };

  const setGroupBy = (by: HybridGroupBy) => {
    const next = new URLSearchParams(params);
    next.set("range", preset);
    next.set("by", by);
    setParams(next, { replace: true });
  };

  const d = summary.data;
  const t = d?.totals;
  const perTask = d?.perCompletedTask;

  return (
    <div className="space-y-5" data-testid="hybrid-tab">
      {/* ── the window ─────────────────────────────────────────────── */}
      <div className="paper-flat flex flex-wrap items-end justify-between gap-3 px-3 py-3">
        <div className="min-w-0">
          <div className="eyebrow text-[9px]">Period</div>
          <div className="font-display mt-0.5 text-base tracking-tight sm:text-lg">
            {d ? describeRange(d.range.from.slice(0, 10), d.range.to.slice(0, 10)) : describeRange(range.from, range.to)}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center overflow-hidden rounded-sm border border-rule" role="group" aria-label="Period">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
                aria-pressed={preset === p.key}
                title={p.label}
                data-testid={`hybrid-preset-${p.key}`}
                className={cn(
                  "font-display h-8 border-l border-rule px-3 text-sm tracking-tight transition-colors first:border-l-0 focus-ink",
                  preset === p.key ? "bg-ink text-parchment" : "text-ink-muted hover:text-ink"
                )}
              >
                {p.short}
              </button>
            ))}
          </div>

          <div className="flex items-center overflow-hidden rounded-sm border border-rule" role="group" aria-label="Bucket size">
            {(["day", "week"] as const).map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setGroupBy(b)}
                aria-pressed={groupBy === b}
                data-testid={`hybrid-by-${b}`}
                className={cn(
                  "font-display h-8 border-l border-rule px-3 text-sm tracking-tight transition-colors first:border-l-0 focus-ink",
                  groupBy === b ? "bg-ink text-parchment" : "text-ink-muted hover:text-ink"
                )}
              >
                {b === "day" ? "Day" : "Week"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {summary.isLoading ? (
        <div className="paper-flat py-16 text-center" data-testid="hybrid-loading">
          <Loader2 className="mx-auto h-4 w-4 animate-spin text-ink-muted" />
          <p className="eyebrow mt-3 text-[9px]">Casting off the ledger…</p>
        </div>
      ) : summary.error ? (
        <div className="paper-flat px-3 py-12 text-center" data-testid="hybrid-error">
          <AlertTriangle className="mx-auto h-4 w-4 text-vermilion" />
          <p className="font-display mt-2 italic text-vermilion">{(summary.error as Error).message}</p>
          <p className="eyebrow mt-1 text-[9px]">hybrid.summary — manager or above.</p>
        </div>
      ) : !d || !t || !perTask ? null : (
        <>
          {/* ── the finding, in words ───────────────────────────────── */}
          <section className="paper-flat px-3 py-3 sm:px-5 sm:py-4" data-testid="hybrid-narrative">
            <div className="eyebrow text-[9px]">
              <span className="text-vermilion">§</span> The reading
            </div>
            <p className="mt-1.5 max-w-[68ch] font-serif text-[0.95rem] leading-relaxed text-pretty sm:text-base">{d.narrative}</p>
            {d.truncated ? (
              <p className="eyebrow mt-2 text-[9px] text-vermilion">
                The window hit the read limit — figures below cover part of it only. Narrow the period.
              </p>
            ) : null}
          </section>

          {/* ── the figures it is made of ───────────────────────────── */}
          <div className="paper-flat grid grid-cols-2 divide-x divide-y divide-rule sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0" data-testid="hybrid-tiles">
            <Tile label="hours logged" value={formatMinutes(t.minutes)} hint={`${t.sessions} sessions`} testId="tile-hours" />
            <Tile label="human" value={formatMinutes(t.human.minutes)} hint={`${Math.round(100 - t.agentSharePct)}% of hours`} />
            <Tile
              label="agent"
              value={formatMinutes(t.agent.minutes)}
              hint={`${t.agentSharePct}% of hours`}
              accent
              testId="tile-agent-hours"
            />
            <Tile label="agent spend" value={formatUsd(t.agent.costUsd)} hint={`${formatTokens(t.agent.tokens)} tokens`} accent testId="tile-agent-spend" />
            <Tile
              label="budget authorised"
              value={formatUsd(t.budgetUsd)}
              hint={t.overBudgetStreams > 0 ? <span className="text-vermilion">{t.overBudgetStreams} stream over</span> : "across streams with a budget"}
              title="The sum of the agent budgets set on live streams"
            />
            <Tile label="tasks closed" value={String(t.tasksCompleted)} hint={`${t.agentSeats} agent seats active`} />
          </div>

          {/* ── the shape over time ─────────────────────────────────── */}
          <Panel
            eyebrow={groupBy === "week" ? "Week by week" : "Day by day"}
            title={
              <>
                Hours, stacked &mdash; and <span className="italic text-vermilion">what they cost</span>
              </>
            }
            aside={`${d.range.buckets} ${groupBy === "week" ? "weeks" : "days"}`}
            testId="hybrid-series"
          >
            <div className="px-2 py-3 sm:px-3">
              <SplitBars series={d.series} />
              <p className="eyebrow mt-1 px-1 text-[9px]">
                Bars read left axis (hours); the dashed line reads right axis (agent dollars in the bucket).
              </p>
            </div>
          </Panel>

          {/* ── budget, and where it is being spent ─────────────────── */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel
              eyebrow="Budget burn"
              title="By stream"
              aside={t.overBudgetStreams > 0 ? <span className="text-vermilion">{t.overBudgetStreams} over</span> : "within budget"}
              testId="hybrid-streams"
            >
              <StreamBudgets rows={d.byStream} />
            </Panel>

            <Panel eyebrow="Where the hours went" title="By app" aside={`${d.byApp.length} apps`} testId="hybrid-apps">
              <AppSplit rows={d.byApp} />
            </Panel>
          </div>

          {/* ── the seats, and the price of finishing something ─────── */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel eyebrow="Agent seats" title="Dearest first" aside={`${d.topAgents.length} active`} testId="hybrid-agents">
              <AgentTable rows={d.topAgents} />
            </Panel>

            <Panel
              eyebrow="Cost per completed task"
              title={<>What finishing something costs</>}
              aside={`${perTask.count} closed`}
              testId="hybrid-per-task"
            >
              {perTask.count === 0 ? (
                <p className="px-3 py-8 text-center font-serif text-sm italic text-ink-muted">
                  Nothing was completed in this window, so there is no price to divide.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 divide-x divide-y divide-rule sm:grid-cols-4 sm:divide-y-0">
                    <Tile
                      label="median · all"
                      value={formatUsd(perTask.median.costUsd)}
                      hint={perTask.median.agentMinutes > 0 ? `${formatMinutes(perTask.median.agentMinutes)} agent time` : "no agent time"}
                      title="Median across every task completed in the window, counting the ones no agent touched as zero"
                      testId="tile-median-all"
                    />
                    <Tile
                      label="median · agent"
                      value={formatUsd(perTask.withAgentMedian.costUsd)}
                      hint={
                        perTask.withAgentMedian.agentMinutes > 0
                          ? `${formatMinutes(perTask.withAgentMedian.agentMinutes)} agent time`
                          : "of the ones agents touched"
                      }
                      accent
                      title="Median across only the completed tasks an agent actually worked on"
                      testId="tile-median-agent"
                    />
                    <Tile label="mean · all" value={formatUsd(perTask.mean.costUsd)} hint={`${formatTokens(perTask.mean.tokens)} tokens each`} />
                    <Tile
                      label="with agent help"
                      value={`${perTask.withAgent}/${perTask.count}`}
                      hint={`${formatUsd(perTask.total.costUsd)} in total`}
                    />
                  </div>
                  <p className="border-t border-rule px-3 py-2 font-serif text-[0.8rem] leading-relaxed text-ink-muted">
                    Each task carries the agent time and dollars logged against it over its whole life, not only inside this window —
                    a task finished on Monday is charged for the work that got it there.
                  </p>
                </>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
