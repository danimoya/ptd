/**
 * Human vs agent, stacked, one bar per bucket.
 *
 * Stacked rather than grouped because the question the chart answers is "how
 * much work landed, and how much of it was the machines" — which is a reading of
 * one column, not a comparison of two. Ink sits at the bottom, vermilion on top,
 * so the agent's share is the part that visibly grows.
 */

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMinutes, formatTokens, formatUsd } from "../format";
import type { Bucket } from "./api";
import { CHART_TICK, CHART_TOOLTIP, INK, RECESS, VERMILION } from "./bits";

interface Datum {
  label: string;
  human: number;
  agent: number;
  breaks: number;
  tokens: number;
  costUsd: number;
  sessions: number;
}

export function toChartData(buckets: Bucket[]): Datum[] {
  return buckets.map((b) => ({
    label: b.label,
    human: b.human.minutes,
    agent: b.agent.minutes,
    breaks: b.breakMinutes,
    tokens: b.agent.tokens,
    costUsd: b.agent.costUsd,
    sessions: b.sessions,
  }));
}

/**
 * Hour-aligned ticks. The axis is in minutes — a tick reading "480" means
 * nothing to a reader — but rounding minute ticks to hours prints "2h" twice,
 * so the ticks are chosen on the hour and the domain is stretched to the top one.
 */
export function hourTicks(maxMinutes: number): number[] {
  const hours = Math.max(1, Math.ceil(maxMinutes / 60));
  const step = hours <= 4 ? 1 : hours <= 8 ? 2 : hours <= 24 ? 4 : hours <= 60 ? 10 : Math.ceil(hours / 6);
  const top = Math.ceil(hours / step) * step;
  return Array.from({ length: top / step + 1 }, (_, i) => i * step * 60);
}

const hourTick = (minutes: number) => (minutes === 0 ? "0" : `${minutes / 60}h`);

function ReportTooltip({ active, payload, label }: { active?: boolean; payload?: { payload: Datum }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const total = d.human + d.agent;
  return (
    <div style={CHART_TOOLTIP} className="px-3 py-2">
      <div className="font-display italic text-sm mb-1 not-italic">{label}</div>
      <div className="tabular-nums">{formatMinutes(total)} worked</div>
      <div className="tabular-nums text-ink-muted">human {formatMinutes(d.human)}</div>
      <div className="tabular-nums text-vermilion">
        agent {formatMinutes(d.agent)}
        {d.agent > 0 && ` · ${formatTokens(d.tokens)} tok · ${formatUsd(d.costUsd)}`}
      </div>
      {d.breaks > 0 && <div className="tabular-nums text-ink-muted">recess {formatMinutes(d.breaks)}</div>}
    </div>
  );
}

export default function SourceBars({ buckets, showBreaks }: { buckets: Bucket[]; showBreaks: boolean }) {
  const data = toChartData(buckets);
  const tallest = data.reduce((max, d) => Math.max(max, d.human + d.agent + (showBreaks ? d.breaks : 0)), 0);
  const ticks = hourTicks(tallest);
  return (
    <div className="h-64 sm:h-72 -ml-2">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke="hsl(var(--rule))" strokeDasharray="2 4" />
          <XAxis
            dataKey="label"
            tick={CHART_TICK}
            axisLine={{ stroke: "hsl(var(--rule))" }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={14}
          />
          <YAxis
            tick={CHART_TICK}
            axisLine={false}
            tickLine={false}
            ticks={ticks}
            domain={[0, ticks[ticks.length - 1]]}
            tickFormatter={hourTick}
            width={38}
          />
          <Tooltip content={<ReportTooltip />} cursor={{ fill: "hsl(var(--ink) / 0.05)" }} />
          <Legend wrapperStyle={{ fontFamily: "JetBrains Mono, monospace", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.12em" }} />
          <Bar name="Human" dataKey="human" stackId="work" fill={INK} />
          <Bar name="Agent" dataKey="agent" stackId="work" fill={VERMILION} />
          {showBreaks && <Bar name="Recess" dataKey="breaks" stackId="work" fill={RECESS} />}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
