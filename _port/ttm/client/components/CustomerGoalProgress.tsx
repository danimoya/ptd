import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getCustomers, getTimeEntries } from "@/lib/api";
import { startOfWeek, endOfWeek, differenceInMinutes } from "date-fns";

interface Customer {
  id: number;
  name: string;
  weeklyGoalHours: number | null;
}

function Meter({ percent, name, value, goal }: { percent: number; name: string; value: string; goal: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display italic truncate">{name}</span>
        <span className="font-numeric text-xs tabular-nums text-ink-muted whitespace-nowrap">
          {value} <span className="text-ink-muted/60">/</span> {goal}
        </span>
      </div>
      <div className="relative h-[6px] bg-rule rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-vermilion rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${clamped}%` }}
        />
        {/* 25/50/75 tick marks */}
        {[25, 50, 75].map((p) => (
          <span
            key={p}
            className="absolute top-0 bottom-0 w-px bg-parchment/90"
            style={{ left: `${p}%` }}
          />
        ))}
      </div>
      <div className="flex items-center justify-between eyebrow text-[10px]">
        <span>{Math.round(clamped)}% of target</span>
        <span>{clamped >= 100 ? "Fulfilled" : `${(100 - clamped).toFixed(0)}% remaining`}</span>
      </div>
    </div>
  );
}

export default function CustomerGoalProgress() {
  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
    queryFn: getCustomers,
  });
  const { data: entries = [] } = useQuery({
    queryKey: ["/api/time-entries"],
    queryFn: getTimeEntries,
  });

  const weekStart = startOfWeek(new Date());
  const weekEnd = endOfWeek(new Date());

  const progress = useMemo(() => {
    return customers
      .filter((c) => c.weeklyGoalHours && c.weeklyGoalHours > 0)
      .map((c) => {
        const minutes = entries.reduce((sum, e: any) => {
          if (e.isBreak || !e.checkOut || e.customerId !== c.id) return sum;
          const d = new Date(e.checkIn);
          if (d < weekStart || d > weekEnd) return sum;
          return (
            sum + differenceInMinutes(new Date(e.checkOut), new Date(e.checkIn))
          );
        }, 0);
        const goalMinutes = (c.weeklyGoalHours ?? 0) * 60;
        const pct = goalMinutes > 0 ? (minutes / goalMinutes) * 100 : 0;
        return { id: c.id, name: c.name, minutes, goalMinutes, pct };
      });
  }, [customers, entries, weekStart, weekEnd]);

  if (progress.length === 0) return null;

  const fmt = (min: number) => {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h === 0 ? `${m}m` : `${h}h ${m.toString().padStart(2, "0")}m`;
  };

  return (
    <div className="paper p-5 sm:p-7">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <div className="eyebrow">Accounts & pledges</div>
          <h3 className="font-display italic text-lg mt-1">
            Hours owed to clients
          </h3>
        </div>
        <span className="section-num">iv.</span>
      </div>
      <div className="divide-y divide-rule">
        {progress.map((p) => (
          <Meter
            key={p.id}
            percent={p.pct}
            name={p.name}
            value={fmt(p.minutes)}
            goal={fmt(p.goalMinutes)}
          />
        ))}
      </div>
    </div>
  );
}
