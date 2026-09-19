import { Outlet, useLocation, Link } from "react-router-dom";
import { LayoutDashboard, GanttChartSquare, Timer, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import OrgSwitcher from "./OrgSwitcher";
import { SURFACES, useMe } from "@/hooks/use-me";

const ICONS = { overview: LayoutDashboard, plan: GanttChartSquare, track: Timer, org: Building2 } as const;
const GLYPHS = { overview: "I", plan: "II", track: "III", org: "IV" } as const;

export default function Layout() {
  const location = useLocation();
  const { surfaces } = useMe();
  if (location.pathname === "/auth") return <Outlet />;

  const tabs = surfaces.map((k) => ({ key: k, ...SURFACES[k], icon: ICONS[k], glyph: GLYPHS[k] }));
  const isActive = (to: string) => location.pathname.startsWith(to);

  return (
    <div className="grain min-h-[100dvh]">
      <div className="mx-auto max-w-6xl px-4 sm:px-8 lg:px-12 min-h-[100dvh] flex flex-col relative z-10">
        <header className="rule-b">
          <div className="pt-4 pb-3 sm:pt-6 sm:pb-5">
            <div className="flex items-start justify-between gap-3">
              <Link to="/" className="group flex flex-col leading-none focus-ink rounded-sm">
                <span className="eyebrow text-[10px] text-vermilion/90">Plan · Track · Done</span>
                <span className="mt-1 font-display text-[28px] sm:text-[34px] font-light tracking-tight">
                  <span className="font-semibold">PTD</span>
                  <span className="text-vermilion">.</span>
                </span>
              </Link>
              <div className="shrink-0 pt-1">
                <OrgSwitcher />
              </div>
            </div>
            <div className="mt-3 sm:mt-4 flex items-center gap-3">
              <div className="flex-1 border-t border-ink/80" />
              <span className="eyebrow text-[10px] text-ink">Same task, same source of truth — human or agent</span>
              <div className="flex-1 border-t border-ink/80" />
            </div>
            <div className="mt-[3px] border-t border-rule" />
          </div>

          <nav className="hidden sm:block">
            <ul className="flex gap-0 -mx-2">
              {tabs.map((t) => {
                const Icon = t.icon;
                const active = isActive(t.path);
                return (
                  <li key={t.key} className="flex-1">
                    <Link to={t.path} className={cn("group block px-2 py-3 focus-ink rounded-sm relative", active ? "text-ink" : "text-ink-muted hover:text-ink")}>
                      <div className="flex items-baseline gap-3">
                        <span className="section-num tabular-nums">{t.glyph}.</span>
                        <span className="font-display text-lg tracking-tight">{t.label}</span>
                        <Icon className="h-3.5 w-3.5 ml-auto opacity-50 self-center" />
                      </div>
                      {active && <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-vermilion" />}
                    </Link>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-rule" />
          </nav>
        </header>

        <main className="flex-1 py-5 sm:py-8 pb-28 sm:pb-12">
          <Outlet />
        </main>

        <footer className="hidden sm:block rule-t">
          <div className="py-4 flex items-center justify-between text-xs text-ink-muted">
            <span className="eyebrow text-[10px]">Open core · MIT</span>
            <span className="font-display italic text-sm">Plan the work in one view, log it in the other.</span>
            <span className="eyebrow text-[10px]">MMXXVI</span>
          </div>
        </footer>
      </div>

      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-20 border-t border-ink/70 bg-parchment/95 backdrop-blur" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <ul className={cn("grid", tabs.length === 4 ? "grid-cols-4" : tabs.length === 3 ? "grid-cols-3" : tabs.length === 2 ? "grid-cols-2" : "grid-cols-1")}>
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = isActive(t.path);
            return (
              <li key={t.key} className="relative">
                <Link to={t.path} className={cn("flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[64px] focus-ink", active ? "text-vermilion" : "text-ink-muted")}>
                  {active && <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] bg-vermilion" />}
                  <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.5} />
                  <span className="text-[10px] tracking-widest2 uppercase mt-0.5 font-numeric">{t.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
