import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDay, formatTokens, formatUsd } from "../format";
import { fetchUsageSummary, formatTokenDelta, sourceLabel, type AgentUsage, type Discrepancy } from "./api";
import { CoverageBar, ReportedVerified } from "./bits";

/**
 * Reported versus verified, per agent seat.
 *
 * This panel exists to answer one question out loud — *why would an agent report
 * its own cost honestly?* — so it leads with the coverage figure rather than the
 * money: a dollar total nobody checked is worth less than a smaller one that a
 * hook, a build or the provider's own bill agrees with. Every session whose gap
 * exceeds tolerance is named, in both directions, because a seat over-reporting
 * is as much a bug as a seat under-reporting.
 */

function Row({ agent }: { agent: AgentUsage }) {
  const hasEvidence = agent.verifiedEntries > 0;
  const sources = Object.entries(agent.sources);
  return (
    <li className="px-3 py-3" data-testid={`verified-agent-${agent.userId}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-serif">{agent.name}</span>
        <span className="eyebrow font-numeric shrink-0 text-[9px] tabular-nums">
          {agent.entries} session{agent.entries === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-1.5">
        <ReportedVerified
          reportedTokens={formatTokens(agent.reported.tokens)}
          verifiedTokens={formatTokens(agent.verified.tokens)}
          reportedCostUsd={formatUsd(agent.reported.costUsd)}
          verifiedCostUsd={formatUsd(agent.verified.costUsd)}
          hasEvidence={hasEvidence}
        />
      </div>

      {hasEvidence && agent.delta.tokens !== 0 ? (
        <p className="eyebrow font-numeric mt-1 text-[9px] tabular-nums">
          <span className={agent.delta.tokens > 0 ? "text-vermilion" : "text-ink-muted"}>
            {formatTokenDelta(agent.delta.tokens)} tok
          </span>{" "}
          against what this seat reported
          {agent.discrepancies > 0 ? (
            <span className="ml-1.5 text-vermilion">
              · {agent.discrepancies} outside tolerance
            </span>
          ) : null}
        </p>
      ) : null}

      <div className="mt-2">
        <CoverageBar
          pct={agent.coveragePct}
          verified={agent.verifiedEntries}
          entries={agent.entries}
          label={agent.name}
          testId={`coverage-${agent.userId}`}
        />
      </div>

      {sources.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {sources.map(([source, count]) => (
            <span key={source} className="stamp border-rule text-ink-muted">
              {sourceLabel(source)} × {count}
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function DiscrepancyRow({ d }: { d: Discrepancy }) {
  const under = d.direction === "under_reported";
  return (
    <li className="px-3 py-2" data-testid={`discrepancy-${d.entryId}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-serif text-sm">
          {d.taskId ? (
            <Link to={`/plan?task=${d.taskId}`} className="rounded-sm hover:text-vermilion focus-ink">
              {d.name}
            </Link>
          ) : (
            d.name
          )}
          <span className="eyebrow ml-1.5 text-[9px]">entry #{d.entryId}</span>
        </span>
        <span className={cn("font-numeric shrink-0 text-sm tabular-nums", under ? "text-vermilion" : "text-ink-muted")}>
          {formatTokenDelta(d.deltaTokens)} tok
        </span>
      </div>
      <p className="eyebrow font-numeric mt-0.5 text-[9px] tabular-nums">
        {under ? "under-reported" : "over-reported"} by {Math.abs(d.deltaPct)}% · said {formatTokens(d.reportedTokens)}, {sourceLabel(d.verifiedSource)} measured{" "}
        {formatTokens(d.verifiedTokens)}
        <span className="mx-1.5">·</span>
        {d.streamName ?? "(no stream)"}
        <span className="mx-1.5">·</span>
        {formatDay(d.checkIn)}
      </p>
    </li>
  );
}

export default function VerifiedPanel() {
  const summary = useQuery({ queryKey: ["/api/actions/usage.summary"], queryFn: () => fetchUsageSummary(), retry: false });

  const totals = summary.data?.totals;
  const agents = summary.data?.byAgent ?? [];
  const discrepancies = summary.data?.discrepancies ?? [];

  return (
    <section className="paper-flat" data-testid="verified-usage">
      <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
        <ShieldCheck className="h-3.5 w-3.5" />
        <span className="microcaps">Reported vs verified</span>
        <span className="eyebrow ml-auto text-[9px]">last 30 days</span>
      </div>

      {summary.isLoading ? (
        <div className="py-10 text-center">
          <Loader2 className="mx-auto h-4 w-4 animate-spin text-ink-muted" />
        </div>
      ) : summary.error ? (
        <div className="px-3 py-8 text-center" data-testid="verified-usage-error">
          <AlertTriangle className="mx-auto h-4 w-4 text-ink-muted" />
          <p className="mt-2 font-serif text-sm italic text-ink-muted">{(summary.error as Error).message}</p>
          <p className="eyebrow mt-1 text-[9px]">usage.summary — manager and above.</p>
        </div>
      ) : (
        <>
          {totals ? (
            <div className="border-b border-rule px-3 py-3">
              <CoverageBar
                pct={totals.coveragePct}
                verified={totals.verifiedEntries}
                entries={totals.entries}
                label="this organization"
                testId="coverage-total"
              />
              <p className="mt-2 max-w-prose font-serif text-sm text-ink-muted">{summary.data?.narrative}</p>
              {totals.unverified.costUsd > 0 ? (
                <p className="eyebrow font-numeric mt-1.5 text-[9px] tabular-nums">
                  {formatUsd(totals.unverified.costUsd)} of self-reported spend has nothing behind it ·{" "}
                  {formatTokens(totals.unverified.tokens)} tok
                </p>
              ) : null}
            </div>
          ) : null}

          {agents.length === 0 ? (
            <p className="px-3 py-8 text-center font-serif text-sm italic text-ink-muted">
              No agent has logged a finished session in this window.
            </p>
          ) : (
            <ul className="divide-y divide-rule">
              {agents.map((a) => (
                <Row key={a.userId} agent={a} />
              ))}
            </ul>
          )}

          {discrepancies.length > 0 ? (
            <div className="border-t border-rule" data-testid="discrepancies">
              <div className="flex items-center gap-2 bg-parchment-deep/40 px-3 py-1.5">
                <AlertTriangle className="h-3 w-3 text-vermilion" />
                <span className="microcaps">Outside tolerance</span>
                <span className="eyebrow ml-auto text-[9px]">
                  ±{summary.data?.tolerance.pct}% or {summary.data?.tolerance.tokens.toLocaleString("en-GB")} tok
                </span>
              </div>
              <ul className="divide-y divide-rule">
                {discrepancies.slice(0, 12).map((d) => (
                  <DiscrepancyRow key={d.entryId} d={d} />
                ))}
              </ul>
              {discrepancies.length > 12 ? (
                <p className="eyebrow px-3 py-1.5 text-[9px]">and {discrepancies.length - 12} more</p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
