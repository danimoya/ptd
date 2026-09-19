import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAuthHeader } from "@/lib/api";
import { startOfWeek, endOfWeek, subWeeks } from "date-fns";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";

type CompareResponse = {
  current: {
    workMinutes: number;
    breakMinutes: number;
    sessions: number;
    activeDays: number;
  };
  previous: {
    workMinutes: number;
    breakMinutes: number;
    sessions: number;
    activeDays: number;
  };
  delta: {
    workMinutes: number;
    breakMinutes: number;
    sessions: number;
    activeDays: number;
  };
  deltaPct: {
    workMinutes: number;
    breakMinutes: number;
    sessions: number;
    activeDays: number;
  };
};

async function fetchCompare(body: unknown): Promise<CompareResponse> {
  const response = await fetch("/api/reports/compare", {
    method: "POST",
    headers: getAuthHeader(),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Failed to compare");
  return response.json();
}

function fmtDur(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function Trend({ pct, invert = false }: { pct: number; invert?: boolean }) {
  const rounded = Math.round(pct);
  const good = invert ? rounded < 0 : rounded > 0;
  const Icon = rounded === 0 ? Minus : rounded > 0 ? ArrowUp : ArrowDown;
  const cls =
    rounded === 0
      ? "text-ink-muted"
      : good
      ? "text-sage"
      : "text-vermilion";
  return (
    <span
      className={`inline-flex items-center gap-1 font-numeric text-xs tabular-nums ${cls}`}
    >
      <Icon className="h-3 w-3" strokeWidth={2.5} />
      {Math.abs(rounded)}%
    </span>
  );
}

function Row({
  label,
  cur,
  prev,
  pct,
  invert,
}: {
  label: string;
  cur: string;
  prev: string;
  pct: number;
  invert?: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] gap-4 items-baseline py-3">
      <span className="font-display italic text-sm">{label}</span>
      <div className="text-right">
        <div className="font-numeric text-lg sm:text-xl tabular-nums">
          {cur}
        </div>
        <div className="eyebrow text-[9px] mt-0.5">
          prior · {prev}
        </div>
      </div>
      <div className="w-14 text-right">
        <Trend pct={pct} invert={invert} />
      </div>
    </div>
  );
}

export default function PeriodComparison() {
  const ranges = useMemo(() => {
    const now = new Date();
    return {
      current: {
        startDate: startOfWeek(now).toISOString(),
        endDate: endOfWeek(now).toISOString(),
      },
      previous: {
        startDate: startOfWeek(subWeeks(now, 1)).toISOString(),
        endDate: endOfWeek(subWeeks(now, 1)).toISOString(),
      },
    };
  }, []);

  const { data, isLoading, isError } = useQuery<CompareResponse>({
    queryKey: ["/api/reports/compare", ranges],
    queryFn: () => fetchCompare(ranges),
  });

  if (isLoading) {
    return (
      <div className="paper p-5 sm:p-7">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="font-display italic text-lg">
            This week vs last
          </h3>
          <span className="section-num">v.</span>
        </div>
        <div className="eyebrow text-center py-6">Consulting prior pages…</div>
      </div>
    );
  }
  if (isError || !data) return null;

  return (
    <div className="paper p-5 sm:p-7">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="eyebrow">Against the prior week</div>
          <h3 className="font-display italic text-lg mt-1">
            Week <span className="not-italic">in review</span>
          </h3>
        </div>
        <span className="section-num">v.</span>
      </div>
      <div className="divide-y divide-rule">
        <Row
          label="Work time"
          cur={fmtDur(data.current.workMinutes)}
          prev={fmtDur(data.previous.workMinutes)}
          pct={data.deltaPct.workMinutes}
        />
        <Row
          label="Recess"
          cur={fmtDur(data.current.breakMinutes)}
          prev={fmtDur(data.previous.breakMinutes)}
          pct={data.deltaPct.breakMinutes}
          invert
        />
        <Row
          label="Sessions"
          cur={`${data.current.sessions}`}
          prev={`${data.previous.sessions}`}
          pct={data.deltaPct.sessions}
        />
        <Row
          label="Active days"
          cur={`${data.current.activeDays}`}
          prev={`${data.previous.activeDays}`}
          pct={data.deltaPct.activeDays}
        />
      </div>
    </div>
  );
}
