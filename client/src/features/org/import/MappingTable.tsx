import React from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { IGNORE_FIELD, type FieldChoice, type PreviewResult } from "./api";

/**
 * One row per column of the user's file, each with the PTD field it feeds.
 *
 * Deliberately column-first rather than field-first: the user is looking at their
 * own spreadsheet, and the question they can answer is "where does *this* column
 * go", not "which of my columns is the title". Several columns may point at one
 * field — Jira repeats `Labels` once per label, and both copies feed `tags`.
 *
 * The last column shows what PTD made of that column in the first importable
 * row — not the raw cell. A header alone ("Custom field (Start date)") rarely
 * says what is in it, and the useful check is whether the *interpretation* came
 * out right: that `20/Mar/26` really did become the 20th of March.
 */
export default function MappingTable({
  preview,
  fields,
  value,
  onChange,
  disabled,
}: {
  preview: PreviewResult;
  fields: FieldChoice[];
  value: Record<string, string>;
  onChange: (mapping: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const effective = { ...preview.mapping, ...value };
  const sample = preview.rows.find((r) => r.action !== "skip") ?? preview.rows[0];
  const titleMissing = preview.kind === "task" && !Object.values(effective).includes("title");
  const used = (field: string) => Object.keys(effective).filter((c) => effective[c] === field);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="microcaps">Column mapping</span>
        <button
          type="button"
          onClick={() => onChange({})}
          disabled={disabled || Object.keys(value).length === 0}
          className="text-[11px] font-mono text-ink-muted hover:text-ink focus-ink disabled:opacity-40"
          data-testid="import-mapping-reset"
        >
          reset to detected
        </button>
      </div>

      {titleMissing ? (
        <p className="text-xs font-serif text-vermilion flex items-center gap-1.5" data-testid="import-mapping-error">
          <AlertTriangle className="h-3.5 w-3.5" /> Nothing is mapped to the title. A card cannot be created without one.
        </p>
      ) : null}

      <div className="paper-flat overflow-x-auto nice-scroll">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule text-left">
              <th className="px-3 py-2 eyebrow text-[9px] font-normal">column in your file</th>
              <th className="px-3 py-2 eyebrow text-[9px] font-normal w-8" />
              <th className="px-3 py-2 eyebrow text-[9px] font-normal">PTD field</th>
              <th className="px-3 py-2 eyebrow text-[9px] font-normal hidden md:table-cell">read as</th>
            </tr>
          </thead>
          <tbody>
            {preview.columns.map((column) => {
              const field = effective[column] ?? IGNORE_FIELD;
              const ignored = field === IGNORE_FIELD;
              const shared = !ignored && used(field).length > 1;
              return (
                <tr key={column} className={cn("border-b border-rule/50 last:border-0", ignored && "opacity-55")}>
                  <td className="px-3 py-1.5 font-mono text-[12px] align-middle max-w-[16rem] truncate" title={column}>
                    {column}
                  </td>
                  <td className="px-1 py-1.5 text-ink-muted">
                    <ArrowRight className="h-3 w-3" />
                  </td>
                  <td className="px-3 py-1.5">
                    <select
                      value={field}
                      disabled={disabled}
                      onChange={(e) => onChange({ ...value, [column]: e.target.value })}
                      className="draft-input w-full min-w-[11rem] py-1 text-[13px] focus-ink"
                      data-testid={`import-map-${column}`}
                    >
                      {fields.map((f) => (
                        <option key={f.field} value={f.field}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    {shared ? <span className="block text-[10px] font-mono text-ink-muted mt-0.5">shares this field with {used(field).length - 1} other</span> : null}
                  </td>
                  <td className="px-3 py-1.5 hidden md:table-cell font-serif text-ink-muted max-w-[14rem] truncate">
                    {readAs(sample, field) || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Where each mappable field shows up in a preview row. The preview carries
 * normalised values keyed by what PTD ended up storing, which does not always
 * share the field's name: `estimate` lands in `estimatedDuration`, and the four
 * Toggl date/time columns all collapse into one interval.
 */
const PREVIEW_KEY: Record<string, string> = {
  estimate: "estimatedDuration",
  assigneeEmail: "assignee",
  priority: "priorityScore",
  userEmail: "memberEmail",
  userName: "member",
  taskRef: "notes",
  date: "checkIn",
  startTime: "checkIn",
  endDate: "checkOut",
  endTime: "checkOut",
  duration: "minutes",
  hours: "minutes",
};

function readAs(row: { values: Record<string, unknown> } | undefined, field: string): string {
  if (!row || field === IGNORE_FIELD) return "";
  const value = row.values[PREVIEW_KEY[field] ?? field];
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    // A due date has no time of day worth showing; a check-in does.
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    return d.toLocaleString(undefined, midnight ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" });
  }
  return String(value);
}
