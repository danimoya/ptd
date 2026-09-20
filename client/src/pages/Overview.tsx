import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import KpiStrip, { KpiFootnote } from "@/features/overview/KpiStrip";
import BacklogTab from "@/features/overview/BacklogTab";
import AppsTab from "@/features/overview/AppsTab";
import SystemicTab from "@/features/overview/SystemicTab";
import AgentsTab from "@/features/overview/AgentsTab";
import HybridTab from "@/features/overview/HybridTab";
import { fetchStats } from "@/features/overview/api";

const TABS = [
  { to: "/overview", label: "Backlog", num: "i" },
  { to: "/overview/apps", label: "Apps", num: "ii" },
  { to: "/overview/systemic", label: "Systemic", num: "iii" },
  { to: "/overview/agents", label: "Agents", num: "iv" },
  { to: "/overview/hybrid", label: "Hybrid", num: "v" },
] as const;

/**
 * Overview — the original backlog tracker's dashboard, re-cut for PTD. The KPI strip stays mounted
 * across tabs because it is the page's masthead; each tab is a route so a filter
 * view can be linked and the browser's back button does what it looks like it does.
 */
export default function Overview() {
  const location = useLocation();
  const stats = useQuery({ queryKey: ["/api/org/stats"], queryFn: fetchStats, staleTime: 15_000 });

  return (
    <section className="animate-ink-fade-in space-y-5">
      <div>
        <div className="eyebrow">
          <span className="text-vermilion">§ I.</span> The Ledger
        </div>
        <h2 className="font-display text-2xl sm:text-4xl font-normal tracking-tight mt-1">
          What the estate <span className="italic">owes</span>
        </h2>
      </div>

      <div>
        <KpiStrip stats={stats.data} loading={stats.isLoading} />
        {stats.error ? (
          <p className="eyebrow text-[10px] mt-2 text-vermilion">{(stats.error as Error).message}</p>
        ) : (
          <KpiFootnote stats={stats.data} />
        )}
      </div>

      <nav className="rule-b">
        <ul className="flex gap-1 -mx-1 overflow-x-auto nice-scroll">
          {TABS.map((t) => {
            const active = t.to === "/overview" ? location.pathname === "/overview" || location.pathname === "/overview/" : location.pathname.startsWith(t.to);
            return (
              <li key={t.to}>
                <Link
                  to={t.to}
                  className={cn("relative block px-3 py-2 focus-ink rounded-sm whitespace-nowrap", active ? "text-ink" : "text-ink-muted hover:text-ink")}
                  data-testid={`overview-tab-${t.label.toLowerCase()}`}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="section-num">{t.num}.</span>
                    <span className="font-display text-base tracking-tight">{t.label}</span>
                  </span>
                  {active ? <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-vermilion" /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Routes>
        <Route index element={<BacklogTab />} />
        <Route path="apps" element={<AppsTab />} />
        <Route path="systemic" element={<SystemicTab />} />
        <Route path="agents" element={<AgentsTab />} />
        <Route path="hybrid" element={<HybridTab />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
    </section>
  );
}
