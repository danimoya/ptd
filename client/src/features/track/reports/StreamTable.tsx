/**
 * Per-stream table: where the window's hours went, and how much of each lane
 * was machine work.
 *
 * The agent share is printed as a number *and* drawn as a hairline bar, because
 * the number a manager scans for is "which lane is the agents running away with",
 * and that reads faster as a length than as a percentage.
 */

import { formatMinutes, formatTokens, formatUsd } from "../format";
import type { StreamSplit } from "./api";
import { Empty } from "./bits";

export default function StreamTable({ rows }: { rows: StreamSplit[] }) {
  if (rows.length === 0) return <Empty>No stream carried work in this period.</Empty>;
  const widest = Math.max(...rows.map((r) => r.minutes), 1);

  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full min-w-[520px] border-collapse">
        <thead>
          <tr className="border-b border-rule">
            {["Stream", "Sess", "Human", "Agent", "Tokens", "Cost", "Total"].map((h, i) => (
              <th
                key={h}
                scope="col"
                className={`eyebrow text-[9px] pb-2 px-1 ${i === 0 ? "text-left" : "text-right"} ${h === "Agent" || h === "Cost" ? "!text-vermilion" : ""}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map((r) => (
            <tr key={String(r.streamId)} className="group">
              <td className="py-2.5 px-1 max-w-[220px]">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 rounded-[1px] shrink-0 border border-ink/20"
                    style={{ backgroundColor: r.streamColor ?? "transparent" }}
                  />
                  <span className="font-display truncate">{r.streamName ?? "(no stream)"}</span>
                </div>
                {/* One rule, two inks: the human length then the agent length. */}
                <div className="mt-1.5 h-[3px] bg-rule/60 rounded-full overflow-hidden ml-[18px] flex">
                  <span className="h-full bg-ink/70" style={{ width: `${(r.human.minutes / widest) * 100}%` }} />
                  <span className="h-full bg-vermilion" style={{ width: `${(r.agent.minutes / widest) * 100}%` }} />
                </div>
              </td>
              <td className="ledger-cell text-right px-1 tabular-nums text-ink-muted">{r.sessions}</td>
              <td className="ledger-cell text-right px-1 tabular-nums">{formatMinutes(r.human.minutes)}</td>
              <td className="ledger-cell text-right px-1 tabular-nums text-vermilion">
                {r.agent.minutes > 0 ? formatMinutes(r.agent.minutes) : "–"}
              </td>
              <td className="ledger-cell text-right px-1 tabular-nums text-ink-muted">
                {r.agent.tokens > 0 ? formatTokens(r.agent.tokens) : "–"}
              </td>
              <td className="ledger-cell text-right px-1 tabular-nums text-vermilion">
                {r.agent.costUsd > 0 ? formatUsd(r.agent.costUsd) : "–"}
              </td>
              <td className="ledger-cell text-right px-1 tabular-nums font-medium">{formatMinutes(r.minutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
