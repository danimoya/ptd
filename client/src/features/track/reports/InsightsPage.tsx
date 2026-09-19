/**
 * Insights — the same ledger read as habits rather than totals.
 *
 * The narrative at the top is written on the server by `insights.summary` from
 * the very figures drawn below it, with no language model anywhere in the path.
 * That is deliberate: a sentence a reader will quote in a standup has to be
 * reproducible, and one of them always accounts for what the agents cost.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Bot, Clock, Coffee, Flame } from "lucide-react";
import { canAccess, useMe } from "@/hooks/use-me";
import { formatMinutes, formatTokens, formatUsd } from "../format";
import { getPatterns, getSummary, reportKeys } from "./api";
import { Empty, Failed, Loading, MetricCell, Panel, SourceSplit } from "./bits";
import HeatStrip from "./HeatStrip";
import RangeBar from "./RangeBar";
import { presetRange, suggestedGroupBy, type PresetKey, type Range } from "./ranges";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export default function InsightsPage() {
  const { role } = useMe();
  const isManager = canAccess(role, "manager");
  const [preset, setPreset] = useState<PresetKey>("last-30");
  const [range, setRange] = useState<Range>(() => presetRange("last-30"));
  const [scope, setScope] = useState<"mine" | "all">("mine");

  const args = useMemo(
    () => ({ from: range.from, to: range.to, ...(scope === "all" && isManager ? { userId: "all" as const } : {}) }),
    [range.from, range.to, scope, isManager]
  );

  const patterns = useQuery({ queryKey: reportKeys.patterns(args), queryFn: () => getPatterns(args) });
  const summary = useQuery({ queryKey: reportKeys.summary(args), queryFn: () => getSummary(args) });
  const p = patterns.data;

  const busiestHours = useMemo(
    () => (p ? [...p.byHour].filter((h) => h.minutes > 0).sort((a, b) => b.minutes - a.minutes).slice(0, 3) : []),
    [p]
  );

  return (
    <div className="animate-ink-fade-in space-y-6 sm:space-y-8">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow">
            <span className="text-vermilion">§ IV.</span> Insights
          </div>
          <h1 className="font-display text-2xl sm:text-4xl font-normal tracking-tight mt-1">
            <span className="italic">The habits of a</span> workshop
          </h1>
        </div>
      </div>

      <RangeBar
        preset={preset}
        range={range}
        groupBy={suggestedGroupBy(range)}
        scope={scope}
        canReadTeam={isManager}
        showGroupBy={false}
        onPreset={(key) => {
          setPreset(key);
          if (key !== "custom") setRange(presetRange(key));
        }}
        onRange={(r) => {
          setPreset("custom");
          setRange(r);
        }}
        // Bucket size does not apply here; patterns are always by hour and weekday.
        onGroupBy={() => undefined}
        onScope={setScope}
      />

      <Panel
        eyebrow="Read back"
        title={
          <>
            <span className="italic">What the</span> window says
          </>
        }
        numeral="i."
        aside={<span className="eyebrow text-[9px] hidden sm:inline">computed, not generated</span>}
      >
        {summary.isLoading ? (
          <Loading>Composing the reading…</Loading>
        ) : summary.isError || !summary.data ? (
          <Failed>The reading could not be composed.</Failed>
        ) : (
          <ol className="space-y-3">
            {summary.data.sentences.map((sentence, i) => (
              <li key={i} className="flex gap-3">
                <span className="section-num shrink-0 pt-1">{["i", "ii", "iii", "iv", "v", "vi"][i] ?? "·"}.</span>
                <p className="font-serif text-[15px] sm:text-base leading-relaxed">{sentence}</p>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      {patterns.isLoading ? (
        <div className="paper p-10">
          <Loading>Reading the grain of the week…</Loading>
        </div>
      ) : patterns.isError || !p ? (
        <div className="paper p-10">
          <Failed>The patterns could not be read.</Failed>
        </div>
      ) : (
        <>
          <div className="paper overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between border-b border-rule">
              <span className="eyebrow">Shape of the window</span>
              <span className="section-num">ii.</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-rule">
              <MetricCell
                label="Peak hour"
                value={p.peakHour === null ? "—" : `${String(p.peakHour).padStart(2, "0")}:00`}
                hint={p.peakHour === null ? undefined : formatMinutes(p.byHour[p.peakHour].minutes)}
                glyph="a"
              />
              <MetricCell
                label="Heaviest day"
                value={p.peakWeekday === null ? "—" : WEEKDAYS[p.peakWeekday].slice(0, 3)}
                hint={p.peakWeekday === null ? undefined : formatMinutes(p.byWeekday[p.peakWeekday].minutes)}
                glyph="b"
              />
              <MetricCell label="Mean session" value={formatMinutes(p.avgSessionMinutes)} hint={`${p.sessions} sessions`} glyph="c" />
              <MetricCell
                label="Breaks / day"
                value={p.breaks.count === 0 ? "—" : p.breaks.perActiveDay.toFixed(1)}
                hint={p.breaks.count === 0 ? "none logged" : `${p.breaks.count} in the window`}
                glyph="d"
              />
            </div>
          </div>

          <Panel
            eyebrow="Hour by hour, day by day"
            title={
              <>
                <span className="italic">When the work</span> lands
              </>
            }
            numeral="iii."
          >
            <HeatStrip heat={p.heat} heatAgent={p.heatAgent} heatMax={p.heatMax} />
          </Panel>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <Panel
              eyebrow="Unbroken attention"
              title={
                <>
                  <span className="italic">Longest</span> focus
                </>
              }
              numeral="iv."
            >
              {p.longestFocus === null ? (
                <Empty>No closed session in this window.</Empty>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-baseline gap-3">
                    <Flame className="h-4 w-4 text-vermilion shrink-0" aria-hidden />
                    <span className="font-numeric text-3xl sm:text-4xl tabular-nums leading-none">{formatMinutes(p.longestFocus.minutes)}</span>
                  </div>
                  <dl className="divide-y divide-rule">
                    {[
                      ["When", `${format(new Date(p.longestFocus.startedAt), "EEE d MMM, HH:mm")} – ${format(new Date(p.longestFocus.endedAt), "HH:mm")}`],
                      ["Who", p.longestFocus.userName ?? "—"],
                      ["Where", p.longestFocus.streamName ?? "across streams"],
                      [
                        "How",
                        p.longestFocus.sessions === 1
                          ? "one unbroken session"
                          : `${p.longestFocus.sessions} back-to-back sessions, no break between`,
                      ],
                      ["Source", p.longestFocus.entrySource],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-4 py-2">
                        <dt className="eyebrow text-[9px]">{k}</dt>
                        <dd className={`font-serif text-sm text-right ${k === "Source" && p.longestFocus!.entrySource !== "human" ? "text-vermilion" : ""}`}>
                          {v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </Panel>

            <Panel
              eyebrow="Rest & recess"
              title={
                <>
                  <span className="italic">How breaks are</span> taken
                </>
              }
              numeral="v."
            >
              <div className="grid grid-cols-2 gap-4 mb-4 pb-4 border-b border-rule">
                <div>
                  <div className="eyebrow flex items-center gap-1.5">
                    <Coffee className="h-3 w-3" aria-hidden /> Breaks
                  </div>
                  <div className="font-numeric text-2xl mt-1 tabular-nums">{p.breaks.count}</div>
                  <div className="eyebrow text-[9px] mt-1">{p.breaks.perActiveDay.toFixed(1)} a day</div>
                </div>
                <div className="border-l border-rule pl-4">
                  <div className="eyebrow flex items-center gap-1.5">
                    <Clock className="h-3 w-3" aria-hidden /> Recess
                  </div>
                  <div className="font-numeric text-2xl mt-1 tabular-nums">{formatMinutes(p.breaks.minutes)}</div>
                  <div className="eyebrow text-[9px] mt-1">
                    mean {formatMinutes(p.breaks.avgMinutes)} · longest {formatMinutes(p.breaks.longestMinutes)}
                  </div>
                </div>
              </div>
              <SourceSplit
                human={p.human.minutes}
                agent={p.agent.minutes}
                tokens={p.agent.tokens}
                costUsd={p.agent.costUsd}
                className="mb-4 pb-4 border-b border-rule"
              />
              <div className="space-y-2">
                <div className="eyebrow flex items-center gap-1.5">
                  <Bot className="h-3 w-3 text-vermilion" aria-hidden /> Busiest hours
                </div>
                {busiestHours.length === 0 ? (
                  <p className="font-display italic text-ink-muted text-sm">Nothing logged.</p>
                ) : (
                  <ul className="divide-y divide-rule">
                    {busiestHours.map((h) => (
                      <li key={h.hour} className="flex items-baseline justify-between gap-3 py-1.5">
                        <span className="font-numeric text-sm tabular-nums">{h.label}</span>
                        <span className="ledger-cell tabular-nums">
                          {formatMinutes(h.minutes)}
                          {h.agent.minutes > 0 && <span className="text-vermilion"> · {formatMinutes(h.agent.minutes)} agent</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Panel>
          </div>

          {p.agentStreams.length > 0 && (
            <Panel
              eyebrow="Machine work"
              title={
                <>
                  <span className="italic">What the agents</span> carried
                </>
              }
              numeral="vi."
              aside={<span className="eyebrow text-[9px] hidden sm:inline">{formatUsd(p.agent.costUsd)} in the window</span>}
            >
              <ul className="divide-y divide-rule">
                {p.agentStreams.map((s) => (
                  <li key={String(s.streamId)} className="py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-display truncate">{s.streamName ?? "(no stream)"}</span>
                      <span className="ledger-cell tabular-nums shrink-0">
                        {formatMinutes(s.minutes)} <span className="text-ink-muted">of {formatMinutes(s.totalMinutes)}</span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-[3px] bg-rule/60 rounded-full overflow-hidden">
                      <span className="block h-full bg-vermilion" style={{ width: `${Math.min(100, s.sharePct)}%` }} />
                    </div>
                    <div className="eyebrow text-[9px] mt-1.5 !text-vermilion">
                      {s.sharePct}% machine · {formatTokens(s.tokens)} tok · {formatUsd(s.costUsd)}
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
