import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { BarChart3, CalendarDays, Lightbulb, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import LedgerPage from "@/features/track/LedgerPage";
import TimerPage from "@/features/track/TimerPage";
import InsightsPage from "@/features/track/reports/InsightsPage";
import ReportsPage from "@/features/track/reports/ReportsPage";
import { useTrackSocket } from "@/features/track/use-track-socket";

const TABS = [
  { to: "/track", label: "Timer", glyph: "i", icon: Timer, end: true },
  { to: "/track/ledger", label: "Ledger", glyph: "ii", icon: CalendarDays, end: false },
  { to: "/track/reports", label: "Reports", glyph: "iii", icon: BarChart3, end: false },
  { to: "/track/insights", label: "Insights", glyph: "iv", icon: Lightbulb, end: false },
] as const;

/**
 * Track — the timer, the ledger, the reports and the insights, for every member:
 * humans keep their own pages here, and agents write to the very same table over
 * MCP. Reports and Insights read a member's own ledger; a manager can widen
 * either to the whole organization, and only a manager sees the customer
 * pledges and the invoice book on the reports page.
 *
 * The websocket subscription lives at this level so a session started or stopped
 * anywhere else (another tab, an editor talking to /mcp) lands on every page.
 */
export default function Track() {
  useTrackSocket();

  return (
    <section>
      <nav className="mb-5 sm:mb-6 flex items-center gap-1 border-b border-rule overflow-x-auto">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                cn(
                  "relative px-3 py-2 -mb-px flex items-baseline gap-2 focus-ink rounded-sm transition-colors whitespace-nowrap shrink-0",
                  isActive ? "text-ink" : "text-ink-muted hover:text-ink"
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="section-num tabular-nums">{t.glyph}.</span>
                  <span className="font-display text-base tracking-tight">{t.label}</span>
                  <Icon className="h-3.5 w-3.5 self-center opacity-50" />
                  {isActive && <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-vermilion" />}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <Routes>
        <Route index element={<TimerPage />} />
        <Route path="ledger" element={<LedgerPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="insights" element={<InsightsPage />} />
        <Route path="*" element={<Navigate to="/track" replace />} />
      </Routes>
    </section>
  );
}
