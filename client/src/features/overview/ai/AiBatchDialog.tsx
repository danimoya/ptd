// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { suggestPriorityBatch } from "../api";
import { AI_MANUAL_PROMISE, bandChipClass, formatAiCost, formatDelta, formatTokens } from "../format";
import type { AiBatchResult, AppRow, StreamOption } from "../types";
import { useAiStatus } from "./useAiStatus";

const LIMITS = [5, 10, 15, 25] as const;
const selectClass = "draft-input h-9 py-0 text-sm w-full appearance-none bg-parchment pr-6 focus-ink";

/**
 * "AI batch" — the same suggestion across a stream or an app.
 *
 * Defaults to a dry run. Scoring twenty-five cards costs real money and, with
 * `apply` on, rewrites twenty-five priorities at once, so the checkbox that
 * writes them is off until someone ticks it and the summary always leads with
 * what the run cost. Hand-scored cards are listed as skipped rather than quietly
 * left out, because "why didn't it touch that one?" is the first question.
 */
export default function AiBatchDialog({
  streams,
  apps,
  defaultStreamId,
  defaultAppId,
  onApplied,
}: {
  streams: StreamOption[];
  apps: AppRow[];
  defaultStreamId?: number;
  defaultAppId?: number;
  /** Fired once after a run that wrote at least one card, so the table can refetch. */
  onApplied: () => void;
}) {
  const ai = useAiStatus();
  const [open, setOpen] = useState(false);
  const [streamId, setStreamId] = useState(defaultStreamId ? String(defaultStreamId) : "");
  const [appId, setAppId] = useState(defaultAppId ? String(defaultAppId) : "");
  const [limit, setLimit] = useState<number>(10);
  const [apply, setApply] = useState(false);
  const [override, setOverride] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AiBatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!ai.available) return null;

  const openDialog = () => {
    setResult(null);
    setError(null);
    setStreamId(defaultStreamId ? String(defaultStreamId) : "");
    setAppId(defaultAppId ? String(defaultAppId) : "");
    setOpen(true);
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await suggestPriorityBatch({
        streamId: streamId ? Number(streamId) : undefined,
        appId: appId ? Number(appId) : undefined,
        limit,
        ...(apply ? { apply: true } : {}),
        ...(override ? { overrideManual: true } : {}),
      });
      setResult(res);
      if (res.applied > 0) onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        title={`Score several cards at once with ${ai.modelLabel ?? "the configured model"}. Dry run by default. ${AI_MANUAL_PROMISE}`}
        className="inline-flex items-center gap-2 px-3 py-1.5 border border-ink/50 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink"
        data-testid="ai-batch-button"
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span className="eyebrow text-[10px] !text-current">AI batch</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-card border border-ink/30 rounded-sm sm:max-w-xl" data-testid="ai-batch-dialog">
          <DialogHeader>
            <div className="eyebrow text-[9px]">{ai.modelLabel}</div>
            <DialogTitle className="font-display text-2xl font-normal tracking-tight">Suggest priorities in bulk</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="eyebrow text-[9px]">stream</span>
              <select value={streamId} onChange={(e) => setStreamId(e.target.value)} className={selectClass} data-testid="ai-batch-stream">
                <option value="">all streams</option>
                {streams.filter((s) => !s.archived).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="eyebrow text-[9px]">app</span>
              <select value={appId} onChange={(e) => setAppId(e.target.value)} className={selectClass} data-testid="ai-batch-app">
                <option value="">all apps</option>
                {apps.map((a) => (
                  <option key={a.id} value={a.id}>{a.key}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="eyebrow text-[9px]">cards</span>
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className={cn(selectClass, "font-numeric")}
                data-testid="ai-batch-limit"
              >
                {LIMITS.map((n) => (
                  <option key={n} value={n}>{n} highest-scored</option>
                ))}
              </select>
            </label>
          </div>

          <div className="space-y-2 pt-1">
            <label className="flex items-start gap-2 cursor-pointer" title="Off: you get the proposals and the cost, and nothing on any card changes.">
              <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} className="accent-vermilion mt-0.5" data-testid="ai-batch-apply" />
              <span className="text-xs font-serif leading-snug">
                Write the suggestions onto the cards. Leave this off for a dry run — the proposals and the cost, nothing changed.
              </span>
            </label>
            <label
              className="flex items-start gap-2 cursor-pointer"
              title={`Off, hand-scored cards are skipped without spending a call. ${AI_MANUAL_PROMISE}`}
            >
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="accent-vermilion mt-0.5" data-testid="ai-batch-override" />
              <span className="text-xs font-serif leading-snug">
                Include cards someone scored by hand{apply ? ", and replace those scores" : ""}. Off by default: {AI_MANUAL_PROMISE.toLowerCase()}
              </span>
            </label>
          </div>

          {error ? (
            <p className="text-xs font-serif italic text-vermilion" data-testid="ai-batch-error">
              {error}
            </p>
          ) : null}

          {result ? (
            <div className="paper-flat px-3 py-2.5 max-h-[38vh] overflow-y-auto nice-scroll" data-testid="ai-batch-summary">
              <p className="font-numeric text-sm">
                {result.scored} scored · {result.applied} written · {result.skipped.length} skipped
                {result.failed > 0 ? ` · ${result.failed} failed` : ""} ·{" "}
                <b>{formatAiCost(result.totals.costUsd)}</b>
              </p>
              <p className="eyebrow text-[9px] mt-1 font-numeric">
                {result.totals.calls} call{result.totals.calls === 1 ? "" : "s"} · {formatTokens(result.totals.inputTokens)} in ·{" "}
                {formatTokens(result.totals.outputTokens)} out{result.apply ? "" : " · dry run, nothing written"}
              </p>

              {result.results.length > 0 ? (
                <table className="w-full text-xs mt-2.5">
                  <tbody>
                    {result.results.map((r) => (
                      <tr key={r.taskId} className="border-b border-rule last:border-0" data-testid={`ai-batch-row-${r.taskId}`}>
                        <td className="py-1.5 pr-2">
                          <span className="font-serif">{r.title}</span>
                          <span className="block eyebrow text-[9px] mt-0.5">
                            u {r.suggestion.urgency} · i {r.suggestion.impact} · e {r.suggestion.effort}
                          </span>
                        </td>
                        <td className="py-1.5 whitespace-nowrap text-right font-numeric">
                          <span className="text-ink-muted">{r.current.priorityScore} → </span>
                          <span className={cn("stamp", bandChipClass(r.suggestion.priorityScore))}>{r.suggestion.priorityScore}</span>
                          <span className="text-ink-muted"> {formatDelta(r.delta.priorityScore)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}

              {result.skipped.length > 0 ? (
                <p className="text-xs font-serif italic text-ink-muted mt-2" data-testid="ai-batch-skipped">
                  Left alone because a person scored them: {result.skipped.map((s) => s.title).join(", ")}.
                </p>
              ) : null}
              {result.failures.length > 0 ? (
                <ul className="text-xs font-serif italic text-vermilion mt-2 space-y-0.5" data-testid="ai-batch-failures">
                  {result.failures.map((f) => (
                    <li key={f.taskId}>
                      {f.title}: {f.error}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="eyebrow text-[10px] hover:text-ink focus-ink rounded-sm px-3 py-2"
              data-testid="ai-batch-close"
            >
              close
            </button>
            <button
              type="button"
              onClick={run}
              disabled={running}
              title={apply ? "Score these cards and write every suggestion." : "Score these cards and show what would change. Nothing is written."}
              className="inline-flex items-center gap-2 px-4 py-2 border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-50"
              data-testid="ai-batch-run"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              <span className="eyebrow text-[10px] !text-current">{apply ? "score and write" : "dry run"}</span>
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
