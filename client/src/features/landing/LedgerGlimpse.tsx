// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Form, QuietButton, SourceStamp } from "./chrome";

/* ─────────────────────────────────────────────────────────────────────────
 * Glimpse I — the day ledger.
 *
 * Press a button, a session runs, and a line lands on the page with its
 * source stamped on it. Agent lines carry the tokens and the dollars they
 * burned; human lines carry neither, because neither means anything there.
 * Everything here is local state — no request leaves the page.
 * ───────────────────────────────────────────────────────────────────────── */

export type Source = "human" | "agent";

export interface LedgerRow {
  id: string;
  start: number; // minutes past midnight
  seconds: number;
  label: string;
  source: Source;
  tokens?: number;
  cost?: number;
}

/** 15,400 tokens and $0.21 after eight seconds — the brief's own example. */
export const TOKENS_PER_SECOND = 1925;
export const USD_PER_TOKEN = 0.21 / 15400;
const MAX_SECONDS = 8;

const SEED: LedgerRow[] = [
  { id: "seed-1", start: 9 * 60 + 12, seconds: 29 * 60, label: "Write the v2 deprecation notice", source: "human" },
  {
    id: "seed-2",
    start: 10 * 60 + 4,
    seconds: 14 * 60,
    label: "Pin TLS 1.3 + PQC hybrid on the API edge",
    source: "agent",
    tokens: 90200,
    cost: 1.21,
  },
];

const NEXT_LABEL: Record<Source, string[]> = {
  human: ["Review the cascade slip", "Sit with the launch checklist", "Pair on the CSRF fix"],
  agent: ["Triage the overnight failures", "Sweep the backlog for duplicates", "Draft the OpenAPI examples"],
};

export function clock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Compact duration: 1h 04m · 29m · 8s. */
export function compact(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function tokensFor(seconds: number): number {
  return Math.round(seconds * TOKENS_PER_SECOND);
}

export function costFor(tokens: number): number {
  return Math.round(tokens * USD_PER_TOKEN * 100) / 100;
}

export function shortTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export function totalsFor(rows: LedgerRow[]) {
  const human = rows.filter((r) => r.source === "human");
  const agent = rows.filter((r) => r.source === "agent");
  return {
    humanSeconds: human.reduce((a, r) => a + r.seconds, 0),
    agentSeconds: agent.reduce((a, r) => a + r.seconds, 0),
    tokens: agent.reduce((a, r) => a + (r.tokens ?? 0), 0),
    cost: Math.round(agent.reduce((a, r) => a + (r.cost ?? 0), 0) * 100) / 100,
  };
}

export default function LedgerGlimpse({ className }: { className?: string }) {
  const [rows, setRows] = useState<LedgerRow[]>(SEED);
  const [running, setRunning] = useState<Source | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [landed, setLanded] = useState<string | null>(null);
  const startedAt = useRef(0);
  const nextStart = useRef(11 * 60 + 2);

  const land = useCallback(
    (source: Source, seconds: number) => {
      const secs = Math.max(1, Math.round(seconds));
      const tokens = source === "agent" ? tokensFor(secs) : undefined;
      const id = `line-${Date.now()}`;
      const pool = NEXT_LABEL[source];
      setRows((prev) => {
        const nth = prev.filter((r) => r.source === source && r.id.startsWith("line-")).length;
        return [
          ...prev,
          {
            id,
            start: nextStart.current,
            seconds: secs,
            label: pool[nth % pool.length],
            source,
            tokens,
            cost: tokens === undefined ? undefined : costFor(tokens),
          },
        ];
      });
      nextStart.current += 47;
      setRunning(null);
      setElapsed(0);
      setLanded(id);
    },
    []
  );

  // The session ticks in real seconds and closes itself at eight, so a
  // visitor who walks away does not leave a timer open on the page.
  useEffect(() => {
    if (!running) return;
    startedAt.current = Date.now();
    const source = running;
    const tick = window.setInterval(() => {
      const secs = (Date.now() - startedAt.current) / 1000;
      if (secs >= MAX_SECONDS) {
        window.clearInterval(tick);
        // Deliberately MAX_SECONDS, not `secs`: the timer fires on a 100ms
        // interval, so the measured value overshoots eight by a little and by
        // a different little each time. Passing it through would bill the row
        // 15,457 tokens instead of 15,400 and put a different figure on the
        // page every visit. The auto-stop happens *at* eight seconds, so eight
        // is what the line records. Do not "fix" this to `land(source, secs)`.
        land(source, MAX_SECONDS);
      } else {
        setElapsed(secs);
      }
    }, 100);
    return () => window.clearInterval(tick);
  }, [running, land]);

  useEffect(() => {
    if (!landed) return;
    const t = window.setTimeout(() => setLanded(null), 1400);
    return () => window.clearTimeout(t);
  }, [landed]);

  const stop = () => {
    if (!running) return;
    land(running, (Date.now() - startedAt.current) / 1000);
  };

  const totals = totalsFor(rows);
  const liveTokens = running === "agent" ? tokensFor(elapsed) : 0;
  const added = rows.length - SEED.length;

  return (
    <Form
      title="Today's page"
      meta={`${rows.length} lines · Sat 19 Sept`}
      className={className}
      bodyClassName="p-0"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-rule p-4 sm:px-5">
        {running ? (
          <>
            <QuietButton onClick={stop} active>
              Stop the session
            </QuietButton>
            <span className="font-numeric flex items-baseline gap-2 text-sm tabular-nums">
              <span className={running === "agent" ? "text-vermilion" : "text-ink"}>
                {String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(Math.floor(elapsed % 60)).padStart(2, "0")}
              </span>
              <span className="text-[11px] text-ink-muted">
                {running === "agent"
                  ? `${shortTokens(liveTokens)} tok · $${costFor(liveTokens).toFixed(2)}`
                  : "running as human"}
              </span>
            </span>
          </>
        ) : (
          <>
            <QuietButton onClick={() => setRunning("human")}>Start as human</QuietButton>
            <QuietButton onClick={() => setRunning("agent")}>Start as agent</QuietButton>
            {added > 0 && (
              <button
                type="button"
                onClick={() => {
                  setRows(SEED);
                  nextStart.current = 11 * 60 + 2;
                }}
                className="focus-ink ml-auto font-numeric text-[11px] uppercase tracking-[0.14em] text-ink-muted underline underline-offset-4 hover:text-ink"
              >
                Clear {added} {added === 1 ? "line" : "lines"}
              </button>
            )}
          </>
        )}
      </div>

      <ul className="divide-y divide-rule">
        {rows.map((row, i) => (
          <li
            key={row.id}
            className={cn(
              "grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5",
              landed === row.id && "bg-vermilion/5"
            )}
          >
            <span className="font-numeric text-[11px] tabular-nums text-ink-muted">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[0.95rem] text-ink">{row.label}</span>
              <span className="font-numeric mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
                <span className="tabular-nums">
                  {clock(row.start)}–{clock(row.start + Math.round(row.seconds / 60))}
                </span>
                <SourceStamp agent={row.source === "agent"}>
                  {row.source === "agent"
                    ? `agent · ${shortTokens(row.tokens ?? 0)} tok · $${(row.cost ?? 0).toFixed(2)}`
                    : "human"}
                </SourceStamp>
              </span>
            </span>
            <span className="font-numeric self-center text-sm tabular-nums text-ink">{compact(row.seconds)}</span>
          </li>
        ))}
      </ul>

      <dl className="grid grid-cols-2 border-t border-ink/70">
        <div className="px-4 py-3 sm:px-5">
          <dt className="eyebrow">Human</dt>
          <dd className="font-numeric mt-1 text-lg tabular-nums text-ink">{compact(totals.humanSeconds)}</dd>
        </div>
        <div className="border-l border-rule px-4 py-3 sm:px-5">
          <dt className="eyebrow text-vermilion">Agent</dt>
          <dd className="font-numeric mt-1 text-lg tabular-nums text-vermilion">
            {compact(totals.agentSeconds)}
          </dd>
          <dd className="font-numeric mt-0.5 text-[11px] tabular-nums text-ink-muted">
            {shortTokens(totals.tokens)} tok · ${totals.cost.toFixed(2)}
          </dd>
        </div>
      </dl>
    </Form>
  );
}
