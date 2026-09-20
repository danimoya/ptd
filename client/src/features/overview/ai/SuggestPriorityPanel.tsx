// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useEffect, useState } from "react";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { suggestPriority } from "../api";
import {
  AI_MANUAL_PROMISE,
  bandChipClass,
  formatAiCost,
  formatConfidence,
  formatDelta,
  formatTokens,
} from "../format";
import type { PrioritySuggestionResult, TaskRow } from "../types";
import { useAiStatus } from "./useAiStatus";

/**
 * "Suggest priority" for one card, inside the Overview drawer.
 *
 * The flow is propose → read → decide, never propose-and-write: the first call
 * is read-only, the numbers land next to the ones the card already has, and
 * nothing is written until Apply. A card a human scored by hand needs one more
 * deliberate tick than that, because overwriting a person's judgement silently
 * is the one thing this feature must never do.
 */

/** One 0–10 input, current value ghosted behind the proposed one. */
function ScoreRow({ label, current, next }: { label: string; current: number; next: number }) {
  const moved = next !== current;
  return (
    <div className="grid grid-cols-[62px_1fr_84px] items-center gap-2" data-testid={`ai-score-${label}`}>
      <span className="eyebrow text-[9px]">{label}</span>
      <span className="relative block h-4">
        {/* Disabled on purpose: the panel shows what the model proposed, it is not an editor. */}
        <input
          type="range"
          min={0}
          max={10}
          step={1}
          value={next}
          disabled
          aria-label={`proposed ${label}`}
          className="w-full accent-vermilion disabled:opacity-100"
          data-testid={`ai-slider-${label}`}
        />
      </span>
      <span className="font-numeric text-xs whitespace-nowrap">
        <span className={moved ? "text-ink-muted line-through" : "text-ink-muted"}>{current}</span>
        {moved ? <span className="text-ink"> → {next}</span> : null}
      </span>
    </div>
  );
}

export default function SuggestPriorityPanel({
  task,
  onApplied,
}: {
  task: TaskRow;
  /** Hand the caller the fields that changed so the drawer and the table can catch up. */
  onApplied: (patch: Partial<TaskRow>) => void;
}) {
  const ai = useAiStatus();
  const [result, setResult] = useState<PrioritySuggestionResult | null>(null);
  const [busy, setBusy] = useState<"suggest" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState(false);

  // A drawer reused for the next card must not show the last card's suggestion.
  useEffect(() => {
    setResult(null);
    setError(null);
    setOverride(false);
    setBusy(null);
  }, [task.id]);

  if (!ai.available) return null;

  const isManual = task.prioritySource === "manual";

  const run = async (apply: boolean) => {
    setBusy(apply ? "apply" : "suggest");
    setError(null);
    try {
      const res = await suggestPriority({
        taskId: task.id,
        ...(apply ? { apply: true, ...(isManual ? { overrideManual: override } : {}) } : {}),
      });
      setResult(res);
      if (res.applied) {
        onApplied({
          urgency: res.suggestion.urgency,
          impact: res.suggestion.impact,
          effort: res.suggestion.effort,
          priorityScore: res.suggestion.priorityScore,
          prioritySource: "ai",
          priorityNote: res.suggestion.rationale,
        });
      } else if (apply && res.skipped === "manual") {
        setError("This card's score was set by hand. Tick the box below to let a suggestion replace it.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!result) {
    return (
      <div className="mt-4">
        <button
          type="button"
          onClick={() => run(false)}
          disabled={busy !== null}
          title={`Ask ${ai.modelLabel ?? "the configured model"} for urgency, impact and effort on this card. Nothing is written until you accept it. ${AI_MANUAL_PROMISE}`}
          className="inline-flex items-center gap-2 px-3 py-1.5 border border-ink/50 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
          data-testid="suggest-priority-button"
        >
          {busy === "suggest" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          <span className="eyebrow text-[10px] !text-current">suggest priority</span>
        </button>
        {error ? (
          <p className="text-xs font-serif italic text-vermilion mt-2" data-testid="ai-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const { suggestion, current, delta, usage } = result;

  return (
    <div className="mt-4 paper-flat px-3 py-2.5" data-testid="ai-suggestion-panel">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-ink-muted" />
        <span className="eyebrow text-[9px]">AI suggestion</span>
        <span className="eyebrow text-[9px] ml-auto font-numeric" title={`${usage.provider} · ${usage.model}`}>
          {usage.model}
        </span>
      </div>

      <div className="flex items-baseline gap-2 mt-2">
        <span className={cn("stamp", bandChipClass(suggestion.priorityScore))} data-testid="ai-suggestion-score">
          P {suggestion.priorityScore}
        </span>
        <span className="font-numeric text-xs text-ink-muted" data-testid="ai-suggestion-delta">
          was {current.priorityScore} · {formatDelta(delta.priorityScore)}
        </span>
        <span
          className="eyebrow text-[9px] ml-auto"
          title="The model's own confidence in this score. A thin card with no description should score low."
          data-testid="ai-confidence"
        >
          confidence {formatConfidence(suggestion.confidence)}
        </span>
      </div>

      <div className="space-y-1.5 mt-2.5">
        <ScoreRow label="urgency" current={current.urgency} next={suggestion.urgency} />
        <ScoreRow label="impact" current={current.impact} next={suggestion.impact} />
        <ScoreRow label="effort" current={current.effort} next={suggestion.effort} />
      </div>

      <p className="text-sm font-serif mt-2.5 leading-snug" data-testid="ai-rationale">
        {suggestion.rationale}
      </p>

      <p className="eyebrow text-[9px] mt-2 font-numeric" data-testid="ai-cost">
        {formatAiCost(usage.costUsd)}
        {usage.priced ? "" : " (model not in price table)"} · {formatTokens(usage.inputTokens)} in ·{" "}
        {formatTokens(usage.outputTokens)} out · {usage.durationMs}ms
        {usage.attempts > 1 ? ` · ${usage.attempts} attempts` : ""}
      </p>

      {result.applied ? (
        <p className="text-xs font-serif italic text-sage mt-2" data-testid="ai-applied">
          Applied. The card now reads {suggestion.priorityScore}, and the rationale is its priority note.
        </p>
      ) : (
        <>
          {isManual ? (
            <label
              className="flex items-start gap-2 mt-2.5 cursor-pointer"
              title={`This card's score was typed by a person. ${AI_MANUAL_PROMISE}`}
            >
              <input
                type="checkbox"
                checked={override}
                onChange={(e) => setOverride(e.target.checked)}
                className="accent-vermilion mt-0.5"
                data-testid="ai-override-manual"
              />
              <span className="text-xs font-serif leading-snug">
                This score was set by hand{task.priorityNote ? ` — “${task.priorityNote}”` : ""}. Replace it anyway.
              </span>
            </label>
          ) : null}

          <div className="flex items-center gap-2 mt-2.5">
            <button
              type="button"
              onClick={() => run(true)}
              disabled={busy !== null || (isManual && !override)}
              title={
                isManual && !override
                  ? "Tick the box above first — a score set by hand is never replaced without confirmation."
                  : "Write these three numbers onto the card. The score is recomputed by the formula, the rationale becomes the card's priority note, and the change is recorded in its history."
              }
              className="inline-flex items-center gap-2 px-3 py-1.5 border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-40"
              data-testid="ai-apply"
            >
              {busy === "apply" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              <span className="eyebrow text-[10px] !text-current">apply</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setResult(null);
                setError(null);
                setOverride(false);
              }}
              title="Throw the suggestion away. The card is untouched."
              className="inline-flex items-center gap-1.5 eyebrow text-[10px] hover:text-ink focus-ink rounded-sm"
              data-testid="ai-dismiss"
            >
              <X className="h-3 w-3" /> dismiss
            </button>
          </div>
        </>
      )}

      {error ? (
        <p className="text-xs font-serif italic text-vermilion mt-2" data-testid="ai-error">
          {error}
        </p>
      ) : null}

      <p className="text-[11px] font-serif italic text-ink-muted mt-2 pt-2 border-t border-rule">
        Calibrated against {result.calibration.openTasks} open card
        {result.calibration.openTasks === 1 ? "" : "s"}
        {result.calibration.p50 === null
          ? ""
          : ` (p25 ${result.calibration.p25} · p50 ${result.calibration.p50} · p75 ${result.calibration.p75})`}
        . {AI_MANUAL_PROMISE}
      </p>
    </div>
  );
}
