import { useEffect, useState } from "react";
import { Loader2, Repeat } from "lucide-react";
import { canAccess, useMe } from "@/hooks/use-me";
import { useRecurrenceMutation, useRecurrences } from "./api";
import { Field } from "./pickers";
import { describeRule, nextRunAfter, parseRule } from "./recurrence";

const PRESETS = ["daily", "weekdays", "weekly:mon,wed", "monthly:1", "every:2w"];

/**
 * The card's recurrence rule, with the preview the scheduler will act on.
 *
 * The preview is computed client-side by the copy of the server's rule module
 * (./recurrence), so it updates as the field is typed and cannot disagree with
 * what `task.recur_set` will store. Setting a rule is a manager action, so a
 * member sees the sentence and no controls.
 */
export function RecurrenceField({ taskId, open }: { taskId: number; open: boolean }) {
  const { role } = useMe();
  const isManager = canAccess(role, "manager");
  const { data: recurrences = [], isLoading } = useRecurrences(open);
  const mutation = useRecurrenceMutation();
  const stored = recurrences.find((r) => r.templateTaskId === taskId) ?? null;
  const [draft, setDraft] = useState(stored?.rule ?? "");

  // Follow the server once it has answered (and when the dialog moves to another card).
  useEffect(() => {
    setDraft(stored?.rule ?? "");
  }, [stored?.rule, taskId]);

  const parsed = parseRule(draft);
  const trimmed = draft.trim();
  const preview = trimmed === "" ? null : parsed.ok ? describeRule(parsed.rule) : parsed.error;
  const next = trimmed !== "" && parsed.ok ? nextRunAfter(parsed.rule, new Date()) : null;
  const unchanged = trimmed === (stored?.rule ?? "");

  return (
    <Field label="Repeats" hint={isLoading ? "…" : stored ? "active" : "off"}>
      <div className="space-y-1.5">
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!isManager}
            placeholder="daily · weekdays · weekly:mon,wed · monthly:15 · every:3d  [at:09:00]"
            aria-label="Recurrence rule"
            className="draft-input w-full font-mono text-xs"
            data-testid="recurrence-input"
          />
          {isManager && (
            <button
              type="button"
              onClick={() => mutation.mutate({ taskId, rule: trimmed === "" ? null : trimmed })}
              disabled={mutation.isPending || unchanged || (trimmed !== "" && !parsed.ok)}
              className="flex shrink-0 items-center gap-1.5 border border-ink px-3 py-2 transition-colors hover:bg-ink hover:text-parchment focus-ink disabled:opacity-40"
              data-testid="recurrence-save"
            >
              {mutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Repeat className="h-3 w-3" />}
              <span className="eyebrow !text-current">{trimmed === "" ? "clear" : stored ? "update" : "set"}</span>
            </button>
          )}
        </div>

        {isManager && (
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setDraft(preset)}
                className="border border-rule px-1.5 py-0.5 font-mono text-[10px] text-ink-muted transition-colors hover:border-ink hover:text-ink focus-ink"
              >
                {preset}
              </button>
            ))}
          </div>
        )}

        <p
          className={`font-serif text-xs ${trimmed !== "" && !parsed.ok ? "text-vermilion" : "text-ink-muted"}`}
          data-testid="recurrence-preview"
        >
          {preview ?? "Not repeating. A rule clones this card into a new backlog card on schedule."}
          {next && <span> — next on {utcStamp(next.toISOString())}</span>}
          {!next && stored?.nextRunAt && unchanged && <span> — next on {utcStamp(stored.nextRunAt)}</span>}
        </p>
        {stored?.lastRunAt && unchanged && (
          <p className="font-mono text-[10px] text-ink-muted">last run {utcStamp(stored.lastRunAt)}</p>
        )}
      </div>
    </Field>
  );
}

/**
 * Rules fire on a UTC clock in v1 (the organization has no timezone column), so
 * the stamp says UTC rather than quietly rendering in the reader's own zone.
 */
function utcStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
}
