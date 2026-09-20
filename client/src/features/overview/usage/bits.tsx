import { cn } from "@/lib/utils";
import { ShieldCheck, ShieldQuestion } from "lucide-react";

/**
 * The two marks this feature adds to the page.
 *
 * A coverage bar answers "how much of this figure is anybody's word but the
 * agent's?", and the glyph is the shorthand for the same thing on a row too
 * narrow for a bar. Both are deliberately quiet: coverage is context for the
 * money beside it, not the headline.
 */

/** Sage above three quarters, ochre in the middle, vermilion when almost nothing is verified. */
function coverageTone(pct: number): { bar: string; text: string } {
  if (pct >= 75) return { bar: "bg-sage", text: "text-sage" };
  if (pct >= 25) return { bar: "bg-[#9a6a12] dark:bg-[#d6a243]", text: "text-[#9a6a12] dark:text-[#d6a243]" };
  return { bar: "bg-vermilion", text: "text-vermilion" };
}

export function CoverageBar({
  pct,
  verified,
  entries,
  label,
  testId,
}: {
  pct: number;
  verified: number;
  entries: number;
  label: string;
  testId?: string;
}) {
  const tone = coverageTone(pct);
  const width = entries === 0 ? 0 : Math.max(pct, 2);
  return (
    <div data-testid={testId}>
      <div
        className="h-1.5 overflow-hidden rounded-sm bg-parchment-deep"
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} — share of agent sessions with independent usage evidence`}
      >
        <div className={cn("h-full", tone.bar)} style={{ width: `${width}%` }} />
      </div>
      <div className="eyebrow font-numeric mt-1 text-[9px] tabular-nums">
        {entries === 0 ? (
          "no agent sessions"
        ) : (
          <>
            <span className={tone.text}>{pct}% verified</span>
            <span className="mx-1.5">·</span>
            {verified} of {entries} sessions attested
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The stamp on a row whose figures somebody other than the agent has confirmed.
 * A row with nothing attested gets the hollow mark rather than nothing at all —
 * "unverified" is the fact worth seeing.
 */
export function VerifiedGlyph({ verified, entries, pct }: { verified: number; entries: number; pct: number }) {
  if (entries === 0) return null;
  if (verified === 0) {
    return (
      <span
        className="stamp border-rule inline-flex shrink-0 items-center gap-1 text-ink-muted"
        title={`None of the ${entries} agent session${entries === 1 ? "" : "s"} here carry independent usage evidence — these tokens and dollars are the agents' own report.`}
        data-testid="glyph-unverified"
      >
        <ShieldQuestion className="h-3 w-3" />
        unverified
      </span>
    );
  }
  const full = verified === entries;
  return (
    <span
      className={cn("stamp inline-flex shrink-0 items-center gap-1", full ? "border-sage/60 text-sage" : "border-rule text-ink-muted")}
      title={`${verified} of ${entries} agent session${entries === 1 ? "" : "s"} attested by a Claude Code hook, a CI job or the provider's own billing (${pct}%).`}
      data-testid="glyph-verified"
    >
      <ShieldCheck className="h-3 w-3" />
      {full ? "verified" : `${pct}%`}
    </span>
  );
}

/** reported → verified, side by side, with the gap named. */
export function ReportedVerified({
  reportedTokens,
  verifiedTokens,
  reportedCostUsd,
  verifiedCostUsd,
  hasEvidence,
}: {
  reportedTokens: string;
  verifiedTokens: string;
  reportedCostUsd: string;
  verifiedCostUsd: string;
  hasEvidence: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
      <div>
        <div className="eyebrow text-[9px]">reported</div>
        <div className="font-numeric text-sm tabular-nums">
          {reportedTokens} <span className="text-ink-muted">tok</span> · {reportedCostUsd}
        </div>
      </div>
      <div>
        <div className="eyebrow text-[9px]">verified</div>
        <div className={cn("font-numeric text-sm tabular-nums", hasEvidence ? "" : "text-ink-muted")}>
          {hasEvidence ? (
            <>
              {verifiedTokens} <span className="text-ink-muted">tok</span> · {verifiedCostUsd}
            </>
          ) : (
            <span className="font-serif italic">nothing attested</span>
          )}
        </div>
      </div>
    </div>
  );
}
