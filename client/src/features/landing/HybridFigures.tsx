// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { Form, QuietButton } from "./chrome";

/* ─────────────────────────────────────────────────────────────────────────
 * The same money, three ways.
 *
 * Minutes, tokens and dollars are one set of entries; per task, per stream
 * and per agent are three readings of it. The switcher exists because the
 * claim is not "we have a cost chart" — it is that the figure follows the
 * work wherever you cut it, and that a budget can therefore be enforced on
 * any of those cuts.
 *
 * Figures are the seeded demo organization's, rounded to the cent.
 * ───────────────────────────────────────────────────────────────────────── */

export type Cut = "task" | "stream" | "agent";

export interface Row {
  label: string;
  note: string;
  humanMinutes: number;
  agentMinutes: number;
  tokens: number;
  cost: number;
  /** Streams carry a ceiling; a cut without one shows the cost alone. */
  budget?: number;
  /** Agents carry what they closed, so cost per completed task is readable. */
  closed?: number;
}

export const CUTS: { key: Cut; label: string; unit: string }[] = [
  { key: "task", label: "Per task", unit: "four open cards" },
  { key: "stream", label: "Per stream", unit: "budgets, enforced" },
  { key: "agent", label: "Per agent", unit: "cost per completed task" },
];

export const ROWS: Record<Cut, Row[]> = {
  task: [
    { label: "Rotate the leaked API keys", note: "SEC-1", humanMinutes: 200, agentMinutes: 18, tokens: 42000, cost: 0.59 },
    { label: "Pin TLS 1.3 + PQC hybrid on the edge", note: "SEC-2", humanMinutes: 345, agentMinutes: 95, tokens: 152000, cost: 2.13 },
    { label: "Generate the OpenAPI spec from routes", note: "API-1", humanMinutes: 95, agentMinutes: 52, tokens: 88400, cost: 1.24 },
    { label: "Deprecation headers on v1", note: "API-2", humanMinutes: 130, agentMinutes: 24, tokens: 31600, cost: 0.44 },
  ],
  stream: [
    { label: "Security hardening", note: "2 apps", humanMinutes: 545, agentMinutes: 113, tokens: 194000, cost: 2.72, budget: 50 },
    { label: "API v2", note: "1 app", humanMinutes: 225, agentMinutes: 76, tokens: 120000, cost: 1.68, budget: 120 },
    { label: "Q3 launch", note: "3 apps", humanMinutes: 750, agentMinutes: 242, tokens: 388400, cost: 5.44, budget: 6 },
    { label: "Inbox sweep", note: "systemic", humanMinutes: 0, agentMinutes: 311, tokens: 455000, cost: 6.4, budget: 6 },
  ],
  agent: [
    { label: "Scout Agent", note: "member · MCP", humanMinutes: 0, agentMinutes: 252, tokens: 402000, cost: 5.63, closed: 9 },
    { label: "Fixer Agent", note: "member · REST", humanMinutes: 0, agentMinutes: 168, tokens: 301500, cost: 4.22, closed: 5 },
    { label: "Nightly Triage", note: "member · Claude Code", humanMinutes: 0, agentMinutes: 65, tokens: 118000, cost: 1.65, closed: 3 },
  ],
};

export function hoursOf(minutes: number): string {
  if (minutes === 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function kTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export function burn(row: Row): number | null {
  if (!row.budget) return null;
  return Math.round((row.cost / row.budget) * 100);
}

export function perClosed(row: Row): string | null {
  if (!row.closed) return null;
  return `$${(row.cost / row.closed).toFixed(2)}`;
}

export default function HybridFigures({ className }: { className?: string }) {
  const [cut, setCut] = useState<Cut>("task");
  const rows = ROWS[cut];
  const meta = CUTS.find((c) => c.key === cut)!;
  const totalCost = rows.reduce((a, r) => a + r.cost, 0);
  const totalAgent = rows.reduce((a, r) => a + r.agentMinutes, 0);
  const totalHuman = rows.reduce((a, r) => a + r.humanMinutes, 0);

  return (
    <Form title="The same money, three ways" meta={meta.unit} className={className} bodyClassName="p-0">
      <div className="flex flex-wrap gap-1 border-b border-rule p-4 sm:px-5">
        {CUTS.map((c) => (
          <QuietButton key={c.key} data-testid={`cut-${c.key}`} active={cut === c.key} onClick={() => setCut(c.key)}>
            {c.label}
          </QuietButton>
        ))}
      </div>

      <ul className="divide-y divide-rule">
        {rows.map((row) => {
          const pct = burn(row);
          const over = pct !== null && pct >= 100;
          return (
            <li key={row.label} className="px-4 py-3 sm:px-5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-[0.95rem] text-ink">{row.label}</span>
                  <span className="font-numeric mt-0.5 block text-[11px] text-ink-muted">
                    {row.note}
                    {row.humanMinutes > 0 && <> · human {hoursOf(row.humanMinutes)}</>}
                    {row.agentMinutes > 0 && (
                      <>
                        {" "}
                        · <span className="text-vermilion">agent {hoursOf(row.agentMinutes)} · {kTokens(row.tokens)} tok</span>
                      </>
                    )}
                    {perClosed(row) && <> · {row.closed} closed · {perClosed(row)} each</>}
                  </span>
                </span>
                <span
                  className={cn(
                    "font-numeric shrink-0 self-center text-sm tabular-nums",
                    over ? "text-vermilion" : "text-ink"
                  )}
                >
                  ${row.cost.toFixed(2)}
                </span>
              </div>

              {pct !== null && (
                <div className="mt-2">
                  <div className="flex h-[3px] w-full bg-rule" aria-hidden="true">
                    <span
                      className={cn("h-full", over ? "bg-vermilion" : "bg-sage")}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                  <p
                    className={cn(
                      "font-numeric mt-1 text-[10px] tabular-nums",
                      over ? "text-vermilion" : "text-ink-muted"
                    )}
                  >
                    ${row.cost.toFixed(2)} of ${row.budget?.toFixed(2)} · {pct}%
                    {over && " · over budget, next task paused for agents on this stream"}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <dl className="grid grid-cols-3 border-t border-ink/70">
        <div className="px-4 py-3 sm:px-5">
          <dt className="eyebrow">Human</dt>
          <dd className="font-numeric mt-1 text-base tabular-nums text-ink">{hoursOf(totalHuman)}</dd>
        </div>
        <div className="border-l border-rule px-4 py-3 sm:px-5">
          <dt className="eyebrow text-vermilion">Agent</dt>
          <dd className="font-numeric mt-1 text-base tabular-nums text-vermilion">{hoursOf(totalAgent)}</dd>
        </div>
        <div className="border-l border-rule px-4 py-3 sm:px-5">
          <dt className="eyebrow">Spend</dt>
          <dd className="font-numeric mt-1 text-base tabular-nums text-ink">${totalCost.toFixed(2)}</dd>
        </div>
      </dl>
    </Form>
  );
}
