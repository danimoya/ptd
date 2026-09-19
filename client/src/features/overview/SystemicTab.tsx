import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Loader2, Network } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchSystemic } from "./api";
import { bandTextClass, formatUsd } from "./format";

/**
 * Sprinter's "systemic themes", generalised: a stream attached to several apps is
 * a concern that recurs across the estate, and is usually cheaper to fix once at
 * the platform level than app by app. The slider is the same knob Sprinter hard-coded at 3.
 */
export default function SystemicTab() {
  const [minApps, setMinApps] = useState(2);
  const systemic = useQuery({ queryKey: ["/api/actions/stream.systemic", minApps], queryFn: () => fetchSystemic(minApps) });

  return (
    <div className="space-y-4">
      <div className="paper-flat p-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-3">
          <span className="eyebrow text-[9px]">spans at least</span>
          <input
            type="range"
            min={2}
            max={6}
            value={minApps}
            onChange={(e) => setMinApps(Number(e.target.value))}
            className="w-32 accent-vermilion"
            data-testid="systemic-minapps"
          />
          <span className="font-numeric text-sm">{minApps} apps</span>
        </label>
        <span className="eyebrow text-[10px] ml-auto font-numeric" data-testid="systemic-count">
          {systemic.isFetching ? "…" : `${systemic.data?.length ?? 0} stream${(systemic.data?.length ?? 0) === 1 ? "" : "s"}`}
        </span>
      </div>

      {systemic.isLoading ? (
        <div className="py-12 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></div>
      ) : systemic.error ? (
        <p className="py-12 text-center font-serif italic text-vermilion">{(systemic.error as Error).message}</p>
      ) : (systemic.data?.length ?? 0) === 0 ? (
        <div className="paper p-8 text-center">
          <Network className="h-6 w-6 mx-auto text-ink-muted" />
          <p className="font-serif italic text-ink-muted mt-3">
            No stream touches {minApps} or more apps yet. Attach a stream to several apps in Plan and it will surface here.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {systemic.data!.map((s) => (
            <article key={s.streamId} className="paper p-4" data-testid={`systemic-${s.streamId}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="eyebrow text-[9px] flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ background: s.color ?? "hsl(var(--vermilion))" }} />
                    {s.appCount} apps
                  </div>
                  <h3 className="font-display text-xl tracking-tight mt-1 leading-snug">{s.name}</h3>
                </div>
                <div className="text-right shrink-0">
                  <div className={cn("font-numeric text-2xl leading-none", s.maxPriority > 0 ? bandTextClass(s.maxPriority) : "text-ink-muted")}>{s.maxPriority}</div>
                  <div className="eyebrow text-[9px] mt-1">max P</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 mt-3">
                {s.apps.map((a) => (
                  <Link
                    key={a.appId}
                    to={`/overview?appId=${a.appId}`}
                    className={cn("stamp normal-case tracking-normal hover:shadow-stamp transition-shadow focus-ink", a.archived ? "border-rule text-ink-muted" : "border-ink/50")}
                    title={a.name}
                  >
                    {a.key}
                  </Link>
                ))}
              </div>

              <dl className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-rule">
                <div>
                  <dt className="eyebrow text-[9px]">open</dt>
                  <dd className="font-numeric text-lg">{s.open}</dd>
                </div>
                <div>
                  <dt className="eyebrow text-[9px]">critical</dt>
                  <dd className={cn("font-numeric text-lg", s.critical > 0 ? "text-vermilion" : "text-ink-muted")}>{s.critical}</dd>
                </div>
                <div>
                  <dt className="eyebrow text-[9px]">agent budget</dt>
                  <dd className="font-numeric text-lg">{s.agentBudgetUsd === null ? <span className="text-ink-muted">—</span> : formatUsd(s.agentBudgetUsd)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
