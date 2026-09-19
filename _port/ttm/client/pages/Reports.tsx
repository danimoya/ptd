import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getTimeEntries, type ClientTimeEntry } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import {
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  isWithinInterval,
  startOfMonth,
  endOfMonth,
  differenceInMinutes,
  isToday,
} from "date-fns";
import { InvoiceGenerateDialog } from "@/components/InvoiceGenerateDialog";
import CustomerGoalProgress from "@/components/CustomerGoalProgress";
import PeriodComparison from "@/components/PeriodComparison";

type ChartDataPoint = {
  name: string;
  workMinutes: number;
  breakMinutes: number;
  totalMinutes: number;
};

type Period = "week" | "month";

function formatDur(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function MetricCell({
  label,
  value,
  hint,
  glyph,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  glyph?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col py-3 px-4">
      <div className="flex items-start justify-between gap-2">
        <span className="eyebrow">{label}</span>
        {glyph && <span className="section-num">{glyph}</span>}
      </div>
      <span
        className={`font-numeric tabular-nums mt-2 text-2xl sm:text-3xl tracking-tight leading-none ${
          accent ? "text-vermilion" : "text-ink"
        }`}
      >
        {value}
      </span>
      {hint && (
        <span className="eyebrow mt-2 text-[10px] text-ink-muted">{hint}</span>
      )}
    </div>
  );
}

export default function Reports() {
  const [period, setPeriod] = useState<Period>("week");
  const { toast } = useToast();

  const { data: entries = [], isLoading, isError } = useQuery({
    queryKey: ["/api/time-entries"],
    queryFn: async () => {
      try {
        return await getTimeEntries();
      } catch (error) {
        toast({
          title: "Could not load pages",
          description:
            error instanceof Error ? error.message : "Please try again later.",
          variant: "destructive",
        });
        throw error;
      }
    },
    retry: false,
  });

  const getPeriodData = (start: Date, end: Date): ChartDataPoint[] =>
    eachDayOfInterval({ start, end }).map((day) => {
      const dayEnd = new Date(day);
      dayEnd.setHours(23, 59, 59, 999);
      const dayEntries = entries.filter((e: ClientTimeEntry) => {
        if (!e.checkOut) return false;
        return isWithinInterval(new Date(e.checkIn), { start: day, end: dayEnd });
      });
      const workMinutes = dayEntries.reduce((t, e) => {
        if (e.isBreak || !e.checkOut) return t;
        return t + differenceInMinutes(new Date(e.checkOut), new Date(e.checkIn));
      }, 0);
      const breakMinutes = dayEntries.reduce((t, e) => {
        if (!e.isBreak || !e.checkOut) return t;
        return t + differenceInMinutes(new Date(e.checkOut), new Date(e.checkIn));
      }, 0);
      return {
        name: format(day, period === "week" ? "EEE" : "d"),
        workMinutes,
        breakMinutes,
        totalMinutes: workMinutes + breakMinutes,
      };
    });

  const periodData = useMemo(() => {
    const now = new Date();
    const start = period === "week" ? startOfWeek(now) : startOfMonth(now);
    const end = period === "week" ? endOfWeek(now) : endOfMonth(now);
    return getPeriodData(start, end);
  }, [period, entries]);

  const stats = useMemo(() => {
    const totalWork = periodData.reduce((s, d) => s + d.workMinutes, 0);
    const totalBreak = periodData.reduce((s, d) => s + d.breakMinutes, 0);
    const avgWorkPerDay = Math.round(totalWork / Math.max(1, periodData.length));
    const hourly = entries.reduce<Record<number, number>>((acc, e) => {
      if (e.checkOut && !e.isBreak) {
        const h = new Date(e.checkIn).getHours();
        acc[h] = (acc[h] || 0) + differenceInMinutes(new Date(e.checkOut), new Date(e.checkIn));
      }
      return acc;
    }, {});
    const peakHour = Object.entries(hourly).reduce(
      (peak, [h, mins]) => (mins > (hourly[Number(peak)] || 0) ? Number(h) : peak),
      0
    );
    const daysWorked = periodData.filter((d) => d.workMinutes > 0).length;
    const consistencyScore = Math.round(
      (daysWorked / Math.max(1, periodData.length)) * 100
    );
    const weeklyProgress =
      avgWorkPerDay > 0 ? Math.round((avgWorkPerDay / (6 * 60)) * 100) : 0;
    return {
      totalWork,
      totalBreak,
      avgWorkPerDay,
      peakHour,
      consistencyScore,
      weeklyProgress,
      workBreakRatio:
        totalWork > 0 ? Math.round((totalWork / (totalWork + totalBreak)) * 100) : 0,
    };
  }, [periodData, entries]);

  const distributionData = [
    { name: "Work", value: stats.totalWork, color: "hsl(var(--vermilion))" },
    { name: "Recess", value: stats.totalBreak, color: "hsl(var(--ink) / 0.25)" },
  ];

  const handleExport = () => {
    const csv = [
      ["Date", "Work (min)", "Break (min)", "Total (min)"],
      ...periodData.map((d) => [d.name, d.workMinutes, d.breakMinutes, d.totalMinutes]),
    ]
      .map((r) => r.join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `time-report-${period}.csv`;
    a.click();
  };

  if (isError) {
    return (
      <div className="paper p-8 text-center">
        <div className="font-display italic text-2xl">A page is missing.</div>
        <div className="eyebrow mt-3">Please refresh the volume.</div>
      </div>
    );
  }

  return (
    <div className="animate-ink-fade-in space-y-6 sm:space-y-8">
      {/* =========== HEADER =========== */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow">
            <span className="text-vermilion">§ III.</span>{" "}
            {period === "week" ? "This Week" : "This Month"}
          </div>
          <h1 className="font-display text-2xl sm:text-4xl font-normal tracking-tight leading-tight mt-1">
            <span className="italic">A reckoning of</span> hours
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={(v: Period) => setPeriod(v)}>
            <SelectTrigger className="h-10 w-[110px] rounded-sm border-ink/30 font-display text-sm focus:ring-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="week">Week</SelectItem>
              <SelectItem value="month">Month</SelectItem>
            </SelectContent>
          </Select>
          <Button
            onClick={handleExport}
            variant="outline"
            className="h-10 rounded-sm border-ink/30 font-display text-sm uppercase tracking-tight hidden sm:inline-flex"
          >
            Export CSV
          </Button>
          <InvoiceGenerateDialog />
        </div>
      </div>

      {isLoading && (
        <div className="paper p-10 text-center eyebrow">Binding the pages…</div>
      )}

      {!isLoading && (
        <>
          {/* =========== METRIC GRID =========== */}
          <div className="paper overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between border-b border-rule">
              <span className="eyebrow">Tally of the period</span>
              <span className="section-num">i.</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-rule">
              <MetricCell
                label="Total Work"
                value={formatDur(stats.totalWork)}
                hint="Work hours"
                glyph="a"
                accent
              />
              <MetricCell
                label="Daily Avg"
                value={formatDur(stats.avgWorkPerDay)}
                hint="Mean per day"
                glyph="b"
              />
              <MetricCell
                label="Consistency"
                value={`${stats.consistencyScore}%`}
                hint="Days worked"
                glyph="c"
              />
              <MetricCell
                label="Peak Hour"
                value={`${String(stats.peakHour).padStart(2, "0")}:00`}
                hint="Productive"
                glyph="d"
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 divide-x divide-y divide-rule border-t border-rule">
              <MetricCell
                label="Recess"
                value={formatDur(stats.totalBreak)}
                glyph="e"
              />
              <MetricCell
                label="Work Ratio"
                value={`${stats.workBreakRatio}%`}
                glyph="f"
              />
              <MetricCell
                label="Progress"
                value={`${stats.weeklyProgress}%`}
                glyph="g"
              />
            </div>
          </div>

          {/* =========== PERIOD COMPARISON =========== */}
          <PeriodComparison />

          {/* =========== CUSTOMER GOALS =========== */}
          <CustomerGoalProgress />

          {/* =========== CHARTS: daily bar + distribution pie =========== */}
          <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
            <div className="paper p-5 sm:p-7">
              <div className="flex items-baseline justify-between mb-4">
                <div>
                  <div className="eyebrow">Daily recorded hours</div>
                  <h3 className="font-display italic text-lg mt-1">
                    A daily tally
                  </h3>
                </div>
                <span className="section-num">ii.</span>
              </div>
              <div className="h-56 sm:h-64 -ml-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={periodData}>
                    <XAxis
                      dataKey="name"
                      tick={{
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 10,
                        fill: "hsl(var(--ink-muted))",
                      }}
                      axisLine={{ stroke: "hsl(var(--rule))" }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 10,
                        fill: "hsl(var(--ink-muted))",
                      }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      formatter={(v: number) => [formatDur(v), "Minutes"]}
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--rule))",
                        borderRadius: "2px",
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: "12px",
                      }}
                    />
                    <Bar
                      name="Work"
                      dataKey="workMinutes"
                      stackId="a"
                      fill="hsl(var(--vermilion))"
                    />
                    <Bar
                      name="Recess"
                      dataKey="breakMinutes"
                      stackId="a"
                      fill="hsl(var(--ink) / 0.2)"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="paper p-5 sm:p-7">
              <div className="flex items-baseline justify-between mb-4">
                <div>
                  <div className="eyebrow">Proportions</div>
                  <h3 className="font-display italic text-lg mt-1">
                    Work & recess
                  </h3>
                </div>
                <span className="section-num">iii.</span>
              </div>
              <div className="h-56 sm:h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={distributionData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={82}
                      stroke="hsl(var(--card))"
                      strokeWidth={2}
                      label={({ percent }) => `${(percent * 100).toFixed(0)}%`}
                      labelLine={false}
                    >
                      {distributionData.map((entry, idx) => (
                        <Cell key={`c-${idx}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Legend
                      wrapperStyle={{
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: "11px",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* =========== Mobile Export =========== */}
          <div className="sm:hidden">
            <Button
              onClick={handleExport}
              variant="outline"
              className="w-full h-12 rounded-sm border-ink/30 font-display uppercase tracking-tight"
            >
              Export CSV
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
