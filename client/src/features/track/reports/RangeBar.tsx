/**
 * The reports header: which window, how it is bucketed, and — for a manager —
 * whose ledger is being read.
 *
 * Presets come first because that is what is actually used; the two date fields
 * only appear once "Custom" is chosen, so the common case is one click.
 */

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { GroupBy } from "./api";
import { PRESET_KEYS, PRESET_LABELS, describeRange, type PresetKey, type Range } from "./ranges";

const GROUPS: { value: GroupBy; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

export default function RangeBar({
  preset,
  range,
  groupBy,
  scope,
  canReadTeam,
  showGroupBy = true,
  onPreset,
  onRange,
  onGroupBy,
  onScope,
}: {
  preset: PresetKey;
  range: Range;
  groupBy: GroupBy;
  scope: "mine" | "all";
  canReadTeam: boolean;
  /** Insights is always binned by hour and weekday, so it hides the toggle. */
  showGroupBy?: boolean;
  onPreset: (key: PresetKey) => void;
  onRange: (range: Range) => void;
  onGroupBy: (groupBy: GroupBy) => void;
  onScope: (scope: "mine" | "all") => void;
}) {
  return (
    <div className="paper p-4 sm:p-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow">Period</div>
          <div className="font-display text-lg sm:text-xl mt-1 tracking-tight">{describeRange(range)}</div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canReadTeam && (
            <div className="flex items-center rounded-sm border border-rule overflow-hidden" role="group" aria-label="Whose ledger">
              {(["mine", "all"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onScope(s)}
                  aria-pressed={scope === s}
                  className={cn(
                    "px-3 h-9 font-display text-sm tracking-tight focus-ink transition-colors",
                    scope === s ? "bg-ink text-parchment" : "text-ink-muted hover:text-ink"
                  )}
                >
                  {s === "mine" ? "Mine" : "Everyone"}
                </button>
              ))}
            </div>
          )}

          {showGroupBy && (
          <div className="flex items-center rounded-sm border border-rule overflow-hidden" role="group" aria-label="Bucket size">
            {GROUPS.map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => onGroupBy(g.value)}
                aria-pressed={groupBy === g.value}
                className={cn(
                  "px-3 h-9 font-display text-sm tracking-tight focus-ink transition-colors border-l border-rule first:border-l-0",
                  groupBy === g.value ? "bg-ink text-parchment" : "text-ink-muted hover:text-ink"
                )}
              >
                {g.label}
              </button>
            ))}
          </div>
          )}

          <Select value={preset} onValueChange={(v) => onPreset(v as PresetKey)}>
            <SelectTrigger className="h-9 w-[150px] rounded-sm border-rule font-display text-sm focus:ring-0" aria-label="Preset period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESET_KEYS.map((k) => (
                <SelectItem key={k} value={k}>
                  {PRESET_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {preset === "custom" && (
        <div className="flex flex-wrap items-end gap-3 pt-3 border-t border-rule">
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-[9px]">From</span>
            <Input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => e.target.value && onRange({ ...range, from: e.target.value })}
              className="h-9 w-[160px] rounded-sm border-rule font-numeric text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-[9px]">To</span>
            <Input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => e.target.value && onRange({ ...range, to: e.target.value })}
              className="h-9 w-[160px] rounded-sm border-rule font-numeric text-sm"
            />
          </label>
        </div>
      )}
    </div>
  );
}
