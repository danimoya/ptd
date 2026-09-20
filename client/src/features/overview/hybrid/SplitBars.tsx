import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMinutes, formatTokens, formatUsd } from "../format";
import type { HybridBucket } from "./api";
import { CHART_LEGEND, CHART_TICK, CHART_TOOLTIP, GRID, INK, VERMILION } from "./bits";

/**
 * The page's main chart: worked minutes per bucket, human under agent, with the
 * agent's dollars drawn over the top as a line.
 *
 * Stacked rather than grouped because the question is "how much work landed, and
 * how much of it was the machines" — one column read top to bottom, not two
 * columns compared. Ink sits at the bottom and vermilion on top, so the agent's
 * share is the part that visibly grows.
 *
 * The cost line shares the frame rather than sitting in its own chart because the
 * interesting reading is the *divergence*: agent hours flat while dollars climb is
 * a different story from both climbing together, and two charts stacked vertically
 * hide it.
 */

interface Datum {
  label: string;
  human: number;
  agent: number;
  costUsd: number;
  tokens: number;
  sessions: number;
  sharePct: number;
}

export function toChartData(series: HybridBucket[]): Datum[] {
  return series.map((b) => ({
    label: b.label,
    human: b.human.minutes,
    agent: b.agent.minutes,
    costUsd: b.agent.costUsd,
    tokens: b.agent.tokens,
    sessions: b.sessions,
    sharePct: b.agentSharePct,
  }));
}

/**
 * Hour-aligned ticks. The axis is in minutes — a tick reading "480" means nothing
 * to a reader — but rounding minute ticks to hours prints "2h" twice, so the ticks
 * are chosen on the hour and the domain is stretched to the top one.
 */
export function hourTicks(maxMinutes: number): number[] {
  const hours = Math.max(1, Math.ceil(maxMinutes / 60));
  const step = hours <= 4 ? 1 : hours <= 8 ? 2 : hours <= 24 ? 4 : hours <= 60 ? 10 : Math.ceil(hours / 6);
  const top = Math.ceil(hours / step) * step;
  return Array.from({ length: top / step + 1 }, (_, i) => i * step * 60);
}

const hourTick = (minutes: number) => (minutes === 0 ? "0" : `${minutes / 60}h`);
const moneyTick = (value: number) => (value === 0 ? "" : value < 1 ? `$${value.toFixed(2)}` : `$${Math.round(value)}`);

function HybridTooltip({ active, payload, label }: { active?: boolean; payload?: { payload: Datum }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const total = d.human + d.agent;
  return (
    <div style={CHART_TOOLTIP} className="px-3 py-2">
      <div className="font-display mb-1 text-sm">{label}</div>
      <div className="tabular-nums">{formatMinutes(total)} worked</div>
      <div className="tabular-nums text-ink-muted">human {formatMinutes(d.human)}</div>
      <div className="tabular-nums text-vermilion">
        agent {formatMinutes(d.agent)}
        {d.agent > 0 ? ` · ${d.sharePct}%` : ""}
      </div>
      {d.costUsd > 0 || d.tokens > 0 ? (
        <div className="tabular-nums text-vermilion">
          {formatUsd(d.costUsd)} · {formatTokens(d.tokens)} tok
        </div>
      ) : null}
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-ink-muted">
        {d.sessions} {d.sessions === 1 ? "session" : "sessions"}
      </div>
    </div>
  );
}

export default function SplitBars({ series }: { series: HybridBucket[] }) {
  const data = toChartData(series);
  const tallest = data.reduce((max, d) => Math.max(max, d.human + d.agent), 0);
  const ticks = hourTicks(tallest);
  const dearest = data.reduce((max, d) => Math.max(max, d.costUsd), 0);
  const showCost = dearest > 0;

  return (
    <div className="-ml-2 h-60 sm:h-72" data-testid="hybrid-split-bars">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} barCategoryGap="22%" margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="2 4" />
          <XAxis
            dataKey="label"
            tick={CHART_TICK}
            axisLine={{ stroke: GRID }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={18}
          />
          <YAxis
            yAxisId="minutes"
            tick={CHART_TICK}
            axisLine={false}
            tickLine={false}
            ticks={ticks}
            domain={[0, ticks[ticks.length - 1]]}
            tickFormatter={hourTick}
            width={34}
          />
          {showCost && (
            <YAxis
              yAxisId="cost"
              orientation="right"
              tick={CHART_TICK}
              axisLine={false}
              tickLine={false}
              tickFormatter={moneyTick}
              width={44}
              domain={[0, Math.max(dearest * 1.2, 0.05)]}
            />
          )}
          <Tooltip content={<HybridTooltip />} cursor={{ fill: "hsl(var(--ink) / 0.05)" }} />
          <Legend wrapperStyle={CHART_LEGEND} />
          <Bar yAxisId="minutes" name="Human hours" dataKey="human" stackId="work" fill={INK} />
          <Bar yAxisId="minutes" name="Agent hours" dataKey="agent" stackId="work" fill={VERMILION} />
          {showCost && (
            <Line
              yAxisId="cost"
              name="Agent cost"
              type="monotone"
              dataKey="costUsd"
              stroke={VERMILION}
              strokeWidth={1.5}
              strokeDasharray="3 3"
              dot={{ r: 2, fill: VERMILION, strokeWidth: 0 }}
              activeDot={{ r: 3 }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
