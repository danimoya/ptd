import { Download, FileQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { templateUrl, type PreviewResult, type SourceArg, type SourceInfo } from "./api";

/**
 * What the server thought the file was, and the override.
 *
 * The detection is shown with its evidence — the distinctive headers it matched —
 * because "we think this is Linear" is only trustworthy if it can say why. Low
 * confidence turns the row vermilion rather than hiding it: a wrong guess that
 * the user notices costs a click, one they do not notice costs an import.
 */
export default function SourcePicker({
  sources,
  detected,
  value,
  onChange,
  disabled,
}: {
  sources: SourceInfo[];
  detected: PreviewResult | null;
  value: SourceArg;
  onChange: (next: SourceArg) => void;
  disabled?: boolean;
}) {
  const uncertain = detected !== null && detected.confidence < 0.4;
  const evidence = detected?.scores?.find((s) => s.source === detected.source)?.matched ?? [];
  const tasks = sources.filter((s) => s.kind === "task");
  const times = sources.filter((s) => s.kind === "time");
  const active = sources.find((s) => s.source === (value === "auto" ? detected?.source : value));

  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <label className="block min-w-0">
        <span className="eyebrow text-[9px]">source</span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as SourceArg)}
          disabled={disabled}
          className="draft-input w-full mt-1 text-sm h-[38px] focus-ink"
          data-testid="import-source"
        >
          <option value="auto">Detect automatically{detected ? ` — ${detected.label}` : ""}</option>
          <optgroup label="Tasks">
            {tasks.map((s) => (
              <option key={s.source} value={s.source}>
                {s.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Time sheets">
            {times.map((s) => (
              <option key={s.source} value={s.source}>
                {s.label}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      {active ? (
        <a
          href={templateUrl(active.source)}
          className="stamp px-2.5 py-1.5 focus-ink inline-flex items-center gap-1.5 justify-self-start sm:justify-self-end whitespace-nowrap"
          data-testid="import-template-link"
        >
          <Download className="h-3 w-3" /> {active.label} template
        </a>
      ) : null}

      {detected ? (
        <p
          className={cn("sm:col-span-2 text-xs font-serif flex items-start gap-1.5", uncertain ? "text-vermilion" : "text-ink-muted")}
          data-testid="import-detection"
        >
          {uncertain ? <FileQuestion className="h-3.5 w-3.5 shrink-0 mt-px" /> : null}
          <span>
            Read as <b>{detected.label}</b>
            {detected.kind === "time" ? " time entries" : " tasks"} · {detected.totalRows} row{detected.totalRows === 1 ? "" : "s"}
            {evidence.length > 0 ? <> · recognised {evidence.map((e) => `“${e}”`).join(", ")}</> : null}
            {uncertain ? " — nothing distinctive in the header, so please confirm the source above." : null}
          </span>
        </p>
      ) : (
        <p className="sm:col-span-2 text-xs font-serif text-ink-muted">{active?.hint ?? "Drop a file or paste its text and PTD will work out where it came from."}</p>
      )}
    </div>
  );
}
