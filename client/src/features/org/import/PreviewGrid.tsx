import React from "react";
import { CircleSlash, FilePlus2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PreviewResult, PreviewRow } from "./api";

const TASK_COLUMNS = [
  { key: "title", label: "title" },
  { key: "status", label: "status" },
  { key: "externalKey", label: "key" },
  { key: "stream", label: "stream" },
  { key: "assignee", label: "assignee" },
  { key: "dueDate", label: "due" },
  { key: "estimatedDuration", label: "days" },
  { key: "priorityScore", label: "score" },
  { key: "tags", label: "tags" },
] as const;

const TIME_COLUMNS = [
  { key: "member", label: "member" },
  { key: "customer", label: "customer" },
  { key: "stream", label: "stream" },
  { key: "checkIn", label: "from" },
  { key: "checkOut", label: "to" },
  { key: "minutes", label: "min" },
  { key: "notes", label: "note" },
] as const;

const ACTION = {
  create: { label: "create", icon: FilePlus2, className: "text-sage" },
  update: { label: "update", icon: RefreshCw, className: "text-ink-muted" },
  skip: { label: "skip", icon: CircleSlash, className: "text-vermilion" },
} as const;

/**
 * The first rows, exactly as the server normalised them.
 *
 * Every cell here came back from `import.preview` — nothing is recomputed in the
 * browser — so what is on screen is literally what the commit will write. The
 * per-row action is the load-bearing column: `update` means an existing card was
 * matched on its external key, which is the difference between a re-import and
 * an accidental duplicate.
 */
export default function PreviewGrid({ preview }: { preview: PreviewResult }) {
  const columns = preview.kind === "task" ? TASK_COLUMNS : TIME_COLUMNS;
  const shown = preview.rows.length;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="microcaps">Preview</span>
        <span className="text-[11px] font-mono text-ink-muted">
          first {shown} of {preview.totalRows} row{preview.totalRows === 1 ? "" : "s"}
        </span>
      </div>

      <div className="paper-flat overflow-x-auto nice-scroll">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-rule text-left">
              <th className="px-2 py-2 eyebrow text-[9px] font-normal w-10">#</th>
              <th className="px-2 py-2 eyebrow text-[9px] font-normal">do</th>
              {columns.map((c) => (
                <th key={c.key} className="px-2 py-2 eyebrow text-[9px] font-normal whitespace-nowrap">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => {
              const action = ACTION[row.action];
              const Icon = action.icon;
              return (
                <tr key={row.row} className="border-b border-rule/50 last:border-0 align-top" data-testid={`import-preview-row-${row.row}`}>
                  <td className="px-2 py-1.5 font-numeric text-[11px] text-ink-muted">{row.row}</td>
                  <td className={cn("px-2 py-1.5 whitespace-nowrap", action.className)}>
                    <span className="inline-flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-wider">
                      <Icon className="h-3 w-3" /> {action.label}
                    </span>
                  </td>
                  {row.action === "skip" ? (
                    <td className="px-2 py-1.5 font-serif text-ink-muted" colSpan={columns.length}>
                      {row.reason ?? "skipped"}
                    </td>
                  ) : (
                    columns.map((c) => (
                      <td key={c.key} className="px-2 py-1.5 max-w-[15rem] truncate" title={cell(row, c.key)}>
                        {cell(row, c.key) || <span className="text-ink-muted">—</span>}
                      </td>
                    ))
                  )}
                </tr>
              );
            })}
            {preview.rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 font-serif text-ink-muted" colSpan={columns.length + 2}>
                  No data rows in the file.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {preview.rows.some((r) => r.warnings.length > 0) ? (
        <ul className="text-[11.5px] font-serif text-ink-muted space-y-0.5">
          {preview.rows
            .filter((r) => r.warnings.length > 0)
            .slice(0, 8)
            .map((r) => (
              <li key={r.row}>
                <span className="font-mono text-[10.5px]">row {r.row}</span> — {r.warnings.join("; ")}
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}

function cell(row: PreviewRow, key: string): string {
  const value = row.values[key];
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    // A date-only field (a due date) has no meaningful time of day to show.
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    return d.toLocaleString(undefined, midnight ? { dateStyle: "medium" } : { dateStyle: "short", timeStyle: "short" });
  }
  return String(value);
}
