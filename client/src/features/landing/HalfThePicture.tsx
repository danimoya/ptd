// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React from "react";
import { cn } from "@/lib/utils";
import { Footnote } from "./chrome";

/* ─────────────────────────────────────────────────────────────────────────
 * The half-the-picture ledger.
 *
 * Five categories of tool, five columns of the thing a hybrid team has to
 * account for, and one full row. Marks are filled rules, not ticks, and a
 * category that cannot see a column gets nothing at all — a blank in a
 * ledger says more than a cross, because a cross still looks like an entry.
 *
 * Two renderings of the same data: a table from 640px up, a stack of ruled
 * entries below it. A five-column table on a 390px phone is a table nobody
 * reads, and a horizontally scrolling one is a table nobody finds.
 * ───────────────────────────────────────────────────────────────────────── */

export const COLUMNS = [
  { key: "tasks", label: "Tasks & dependencies", short: "Tasks" },
  { key: "hours", label: "Human hours", short: "Hours" },
  { key: "tokens", label: "Agent tokens & cost", short: "Tokens" },
  { key: "same", label: "Both on one ledger", short: "One ledger" },
  { key: "proof", label: "Proof on an invoice", short: "Proof" },
] as const;

export type ColumnKey = (typeof COLUMNS)[number]["key"];

/** `true` is a full mark; a string is a qualified one, printed as written. */
export type Mark = boolean | string;

export interface Category {
  kind: string;
  examples: string;
  marks: Record<ColumnKey, Mark>;
  /** The sentence under the row: what this category cannot tell you. */
  blind: string;
}

export const CATEGORIES: Category[] = [
  {
    kind: "Planners",
    examples: "Asana, Linear, Jira, Monday",
    marks: { tasks: true, hours: false, tokens: false, same: false, proof: false },
    blind: "Plan the work, then know nothing about the hours it took or what an agent spent doing it.",
  },
  {
    kind: "Time trackers",
    examples: "Toggl, Clockify, Harvest",
    marks: { tasks: false, hours: true, tokens: false, same: false, proof: false },
    blind: "Log human hours, with no dependencies, no agents and no tokens behind them.",
  },
  {
    kind: "LLM dashboards",
    examples: "Helicone, Langfuse, provider consoles",
    marks: { tasks: false, hours: false, tokens: true, same: false, proof: false },
    blind: "See tokens, but not the task they belonged to, the person who asked, or the invoice they land on.",
  },
  {
    kind: "Monitoring tools",
    examples: "Hubstaff, Upwork",
    marks: { tasks: false, hours: true, tokens: false, same: false, proof: "screenshots" },
    blind: "Prove contractor time with screenshots and keystroke surveillance — presence, not work.",
  },
  {
    kind: "Open-source suites",
    examples: "Plane, OpenProject, Kimai",
    marks: { tasks: "planning", hours: "or time", tokens: false, same: false, proof: false },
    blind: "Compete on open source, but none pair planning with time, and none are agent-native.",
  },
];

export const PTD: Category = {
  kind: "PTD",
  examples: "one task, one ledger",
  marks: { tasks: true, hours: true, tokens: true, same: true, proof: true },
  blind: "Tasks, human hours, agent tokens and the invoice behind them — one ledger, one set of figures, one proof.",
};

export default function HalfThePicture({ className }: { className?: string }) {
  return (
    <div className={className}>
      {/* ── The stack, up to 640px ───────────────────────────────────── */}
      <ul className="border-t border-ink/70 sm:hidden">
        {[...CATEGORIES, PTD].map((row) => {
          const isPtd = row.kind === "PTD";
          return (
            <li key={row.kind} className={cn("border-b border-rule py-4", isPtd && "border-b-0 border-t-2 border-t-ink")}>
              <h3
                className={cn(
                  "font-display text-[1.1rem] tracking-[-0.015em]",
                  isPtd ? "text-ink" : "text-ink-muted"
                )}
              >
                {row.kind}
              </h3>
              <p className="font-numeric mt-0.5 text-[10px] leading-snug text-ink-muted">{row.examples}</p>
              <dl className="mt-2.5 grid grid-cols-5 gap-x-1.5">
                {COLUMNS.map((col) => (
                  <div key={col.key}>
                    <dt className="font-numeric text-[9px] uppercase leading-tight tracking-[0.06em] text-ink-muted">
                      {col.short}
                    </dt>
                    <dd className="mt-1">
                      <MarkCell mark={row.marks[col.key]} strong={isPtd} />
                    </dd>
                  </div>
                ))}
              </dl>
              <p
                className={cn(
                  "mt-2.5 text-[0.9rem] leading-snug text-pretty",
                  isPtd ? "text-ink" : "text-ink-muted"
                )}
              >
                {row.blind}
              </p>
            </li>
          );
        })}
      </ul>

      {/* ── The table, 640px and up ──────────────────────────────────── */}
      <table className="hidden w-full border-collapse text-left sm:table">
        <caption className="sr-only">
          What each category of tool can account for, compared with PTD
        </caption>
        <thead>
          <tr className="border-b border-ink/70">
            <th scope="col" className="w-[34%] py-2.5 pr-3 font-numeric text-[10px] font-normal uppercase tracking-[0.14em] text-ink-muted">
              What it is
            </th>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                scope="col"
                className="py-2.5 pl-3 align-bottom font-numeric text-[10px] font-normal uppercase leading-tight tracking-[0.1em] text-ink-muted"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CATEGORIES.map((row) => (
            <tr key={row.kind} className="border-b border-rule align-top">
              <th scope="row" className="py-3.5 pr-3 font-normal">
                <span className="block font-display text-[1.05rem] tracking-[-0.015em] text-ink">{row.kind}</span>
                <span className="font-numeric mt-0.5 block text-[10px] text-ink-muted">{row.examples}</span>
                <span className="mt-1.5 block max-w-[22rem] text-[0.85rem] leading-snug text-ink-muted text-pretty">
                  {row.blind}
                </span>
              </th>
              {COLUMNS.map((col) => (
                <td key={col.key} className="py-3.5 pl-3">
                  <MarkCell mark={row.marks[col.key]} />
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t-2 border-ink align-top">
            <th scope="row" className="py-4 pr-3 font-normal">
              <span className="block font-display text-[1.35rem] tracking-[-0.02em] text-ink">PTD</span>
              <span className="mt-1.5 block max-w-[22rem] text-[0.9rem] leading-snug text-ink text-pretty">
                {PTD.blind}
              </span>
            </th>
            {COLUMNS.map((col) => (
              <td key={col.key} className="py-4 pl-3">
                <MarkCell mark={PTD.marks[col.key]} strong />
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      <Footnote>
        Read across, not down. Every other row stops somewhere; the claim is the intersection, not a longer
        feature list.
      </Footnote>
    </div>
  );
}

/**
 * A filled rule for yes, an empty gap for no, the word itself for a qualified
 * mark. Screen readers get the verdict in words either way.
 */
function MarkCell({ mark, strong }: { mark: Mark; strong?: boolean }) {
  if (mark === true) {
    return (
      <span className="flex items-center" data-mark="yes">
        <span className={cn("h-[3px] w-6 sm:w-7", strong ? "bg-ink" : "bg-ink/55")} aria-hidden="true" />
        <span className="sr-only">yes</span>
      </span>
    );
  }
  if (mark === false) {
    return (
      <span className="flex items-center" data-mark="no">
        <span className="h-[3px] w-6 border-b border-dotted border-ink/25 sm:w-7" aria-hidden="true" />
        <span className="sr-only">no</span>
      </span>
    );
  }
  return (
    <span className="font-numeric block text-[10px] leading-tight text-vermilion" data-mark="partial">
      {mark}
    </span>
  );
}
