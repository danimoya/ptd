/**
 * This period against the one before it.
 *
 * Eight rows, each with the current figure, the prior figure beneath it in small
 * caps, and an arrow that is coloured by whether the movement is welcome —
 * more hours is sage, more agent dollars is vermilion. TTM's card did the same
 * for work and recess; the agent columns are the new part, and the reason a
 * manager opens this page at all.
 */

import { useQuery } from "@tanstack/react-query";
import { formatMinutes, formatTokens, formatUsd } from "../format";
import { getComparison, type Comparison, type GroupBy, type MetricName } from "./api";
import { Failed, Loading, Panel, TrendArrow } from "./bits";
import { describeRange, type Range } from "./ranges";

type Fmt = (n: number) => string;

const ROWS: { metric: MetricName; label: string; format: Fmt; accent?: boolean }[] = [
  { metric: "minutes", label: "Recorded", format: formatMinutes },
  { metric: "humanMinutes", label: "Human", format: formatMinutes },
  { metric: "agentMinutes", label: "Agent", format: formatMinutes, accent: true },
  { metric: "agentCostUsd", label: "Agent cost", format: formatUsd, accent: true },
  { metric: "agentTokens", label: "Tokens", format: formatTokens, accent: true },
  { metric: "sessions", label: "Sessions", format: String },
  { metric: "activeDays", label: "Active days", format: String },
  { metric: "breakMinutes", label: "Recess", format: formatMinutes },
];

const valueOf = (report: Comparison["current"], metric: MetricName): number => {
  switch (metric) {
    case "minutes":
      return report.minutes;
    case "humanMinutes":
      return report.human.minutes;
    case "agentMinutes":
      return report.agent.minutes;
    case "agentTokens":
      return report.agent.tokens;
    case "agentCostUsd":
      return report.agent.costUsd;
    case "sessions":
      return report.sessions;
    case "activeDays":
      return report.activeDays;
    case "breakMinutes":
      return report.breakMinutes;
  }
};

export default function ComparisonCard({
  current,
  previous,
  groupBy,
  scope,
  numeral,
}: {
  current: Range;
  previous: Range;
  groupBy: GroupBy;
  scope: "mine" | "all";
  numeral?: string;
}) {
  const args = {
    current: { from: current.from, to: current.to },
    previous: { from: previous.from, to: previous.to },
    groupBy,
    ...(scope === "all" ? { userId: "all" as const } : {}),
  };
  const q = useQuery({ queryKey: ["track", "reports", "compare", args], queryFn: () => getComparison(args) });

  return (
    <Panel
      eyebrow="Against the prior period"
      title={
        <>
          <span className="italic">In</span> review
        </>
      }
      numeral={numeral}
      aside={<span className="eyebrow text-[9px] hidden sm:inline">prior · {describeRange(previous)}</span>}
    >
      {q.isLoading ? (
        <Loading>Consulting prior pages…</Loading>
      ) : q.isError || !q.data ? (
        <Failed>The comparison could not be drawn.</Failed>
      ) : (
        <div className="divide-y divide-rule">
          {ROWS.map(({ metric, label, format, accent }) => (
            <div key={metric} className="grid grid-cols-[1fr_auto_3.5rem] gap-4 items-baseline py-2.5">
              <span className={`font-display text-sm ${accent ? "text-vermilion" : ""}`}>{label}</span>
              <div className="text-right">
                <div className="font-numeric text-base sm:text-lg tabular-nums">{format(valueOf(q.data.current, metric))}</div>
                <div className="eyebrow text-[9px] mt-0.5">prior · {format(valueOf(q.data.previous, metric))}</div>
              </div>
              <div className="text-right">
                <TrendArrow trend={q.data.trend[metric]} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
