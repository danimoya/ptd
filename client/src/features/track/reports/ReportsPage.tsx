/**
 * Reports — a reckoning of hours, human and machine.
 *
 * The page is one window's worth of the ledger read four ways: a tally, a
 * stacked bar per bucket, a per-stream table, and the same window set against
 * the one before it. A manager also gets the customer pledges, the invoice book
 * and the button that renders one.
 *
 * All of it comes off `report.range` / `report.compare`, which means the figures
 * here are the same figures an agent gets over MCP — the UI has no arithmetic of
 * its own beyond choosing the window.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { canAccess, useMe } from "@/hooks/use-me";
import { formatMinutes, formatTokens, formatUsd } from "../format";
import { getRange, reportKeys, type GroupBy } from "./api";
import { Failed, Loading, MetricCell, Panel } from "./bits";
import ComparisonCard from "./ComparisonCard";
import GoalMeters from "./GoalMeters";
import InvoiceDialog, { InvoiceLedger } from "./InvoiceDialog";
import RangeBar from "./RangeBar";
import SearchPanel from "./SearchPanel";
import SourceBars from "./SourceBars";
import StreamTable from "./StreamTable";
import { presetRange, previousRange, suggestedGroupBy, type PresetKey, type Range } from "./ranges";

export default function ReportsPage() {
  const { role } = useMe();
  const isManager = canAccess(role, "manager");

  const [preset, setPreset] = useState<PresetKey>("this-month");
  const [range, setRange] = useState<Range>(() => presetRange("this-month"));
  // Null means "follow the range"; a click pins the choice until the reader
  // changes it, so widening the window does not silently undo their toggle.
  const [pinnedGroupBy, setPinnedGroupBy] = useState<GroupBy | null>(null);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [includeBreaks, setIncludeBreaks] = useState(false);

  const groupBy = pinnedGroupBy ?? suggestedGroupBy(range);
  const previous = useMemo(() => previousRange(preset, range), [preset, range]);

  const args = useMemo(
    () => ({
      from: range.from,
      to: range.to,
      groupBy,
      includeBreaks,
      ...(scope === "all" && isManager ? { userId: "all" as const } : {}),
    }),
    [range.from, range.to, groupBy, includeBreaks, scope, isManager]
  );

  const report = useQuery({ queryKey: reportKeys.range(args), queryFn: () => getRange(args) });
  const data = report.data;

  const perDay = data && data.activeDays > 0 ? Math.round(data.minutes / data.activeDays) : 0;
  const agentShare = data && data.minutes > 0 ? Math.round((data.agent.minutes / data.minutes) * 100) : 0;

  return (
    <div className="animate-ink-fade-in space-y-6 sm:space-y-8">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow">
            <span className="text-vermilion">§ III.</span> Reports
          </div>
          <h1 className="font-display text-2xl sm:text-4xl font-normal tracking-tight mt-1">
            <span className="italic">A reckoning of</span> hours
          </h1>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Switch
              checked={includeBreaks}
              onCheckedChange={setIncludeBreaks}
              className="data-[state=checked]:bg-vermilion data-[state=unchecked]:bg-ink/20"
              aria-label="Show recess in the chart"
            />
            <span className="eyebrow text-[9px]">Recess</span>
          </label>
          {isManager && <InvoiceDialog />}
        </div>
      </div>

      <RangeBar
        preset={preset}
        range={range}
        groupBy={groupBy}
        scope={scope}
        canReadTeam={isManager}
        onPreset={(key) => {
          setPreset(key);
          if (key !== "custom") setRange(presetRange(key));
          setPinnedGroupBy(null);
        }}
        onRange={(r) => {
          setPreset("custom");
          setRange(r);
        }}
        onGroupBy={setPinnedGroupBy}
        onScope={setScope}
      />

      {report.isLoading ? (
        <div className="paper p-10">
          <Loading>Binding the pages…</Loading>
        </div>
      ) : report.isError || !data ? (
        <div className="paper p-10">
          <Failed>This report could not be assembled.</Failed>
        </div>
      ) : (
        <>
          <div className="paper overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between border-b border-rule">
              <span className="eyebrow">Tally of the period</span>
              <span className="section-num">i.</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-rule">
              <MetricCell label="Recorded" value={formatMinutes(data.minutes)} hint={`${data.sessions} sessions`} glyph="a" />
              <MetricCell label="Human" value={formatMinutes(data.human.minutes)} hint={`${100 - agentShare}% of the hours`} glyph="b" />
              <MetricCell label="Agent" value={formatMinutes(data.agent.minutes)} hint={`${agentShare}% of the hours`} glyph="c" accent />
              <MetricCell
                label="Agent cost"
                value={formatUsd(data.agent.costUsd)}
                hint={`${formatTokens(data.agent.tokens)} tokens`}
                glyph="d"
                accent
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 divide-x divide-y sm:divide-y-0 divide-rule border-t border-rule">
              <MetricCell label="Active days" value={String(data.activeDays)} glyph="e" />
              <MetricCell label="Per active day" value={formatMinutes(perDay)} glyph="f" />
              <MetricCell label="Recess" value={formatMinutes(data.breakMinutes)} hint={data.includeBreaks ? undefined : "toggle Recess to count"} glyph="g" />
            </div>
            {data.truncated && (
              <p className="px-4 py-2 border-t border-rule eyebrow text-[9px] !text-vermilion">
                This window hit the read ceiling — narrow it for an exact tally.
              </p>
            )}
          </div>

          <Panel
            eyebrow={`Recorded hours by ${groupBy}`}
            title={
              <>
                <span className="italic">Human and</span> machine
              </>
            }
            numeral="ii."
            aside={<span className="eyebrow text-[9px] hidden sm:inline">ink · human / vermilion · agent</span>}
          >
            <SourceBars buckets={data.buckets} showBreaks={includeBreaks} />
          </Panel>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-6 items-start">
            <Panel
              eyebrow="Where the hours went"
              title={
                <>
                  <span className="italic">By</span> stream
                </>
              }
              numeral="iii."
            >
              <StreamTable rows={data.byStream} />
            </Panel>
            <ComparisonCard current={range} previous={previous} groupBy={groupBy} scope={scope} numeral="iv." />
          </div>

          {isManager && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
              <GoalMeters numeral="v." />
              <Panel
                eyebrow="Rendered accounts"
                title={
                  <>
                    <span className="italic">The invoice</span> book
                  </>
                }
                numeral="vi."
              >
                <InvoiceLedger />
              </Panel>
            </div>
          )}

          <SearchPanel range={range} scope={scope} numeral={isManager ? "vii." : "v."} />
        </>
      )}
    </div>
  );
}
