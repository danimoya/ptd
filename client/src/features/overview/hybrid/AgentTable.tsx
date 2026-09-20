import { formatMinutes, formatTokens, formatUsd } from "../format";
import type { AgentHybrid } from "./api";
import { Empty } from "./bits";

/**
 * The agent seats, dearest first.
 *
 * "Dearest first" rather than "busiest first" on purpose: minutes are cheap for an
 * agent and dollars are not, so the ordering answers the question the tab exists
 * to answer. Tokens and sessions are the two columns that drop out below `sm`,
 * because cost and tasks closed are the pair worth keeping on a phone.
 */
export default function AgentTable({ rows }: { rows: AgentHybrid[] }) {
  if (rows.length === 0) return <Empty>No agent seat logged time in this window.</Empty>;

  return (
    <table className="w-full text-left" data-testid="hybrid-agent-table">
      <thead>
        <tr className="border-b border-rule">
          <th scope="col" className="eyebrow px-3 py-1.5 text-[9px] font-normal">
            seat
          </th>
          <th scope="col" className="eyebrow px-2 py-1.5 text-right text-[9px] font-normal">
            hours
          </th>
          <th scope="col" className="eyebrow hidden px-2 py-1.5 text-right text-[9px] font-normal sm:table-cell">
            tokens
          </th>
          <th scope="col" className="eyebrow px-2 py-1.5 text-right text-[9px] font-normal">
            cost
          </th>
          <th scope="col" className="eyebrow hidden px-2 py-1.5 text-right text-[9px] font-normal sm:table-cell">
            sessions
          </th>
          <th scope="col" className="eyebrow px-3 py-1.5 text-right text-[9px] font-normal" title="Tasks whose completion was recorded by this seat in this window">
            closed
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-rule">
        {rows.map((r) => (
          <tr key={r.userId} data-testid={`hybrid-agent-${r.userId}`}>
            <td className="max-w-[9rem] truncate px-3 py-2 font-serif sm:max-w-none">{r.displayName}</td>
            <td className="font-numeric px-2 py-2 text-right text-[0.78rem] tabular-nums">{formatMinutes(r.minutes)}</td>
            <td className="font-numeric hidden px-2 py-2 text-right text-[0.78rem] tabular-nums text-ink-muted sm:table-cell">
              {formatTokens(r.tokens)}
            </td>
            <td className="font-numeric px-2 py-2 text-right text-[0.78rem] tabular-nums text-vermilion">{formatUsd(r.costUsd)}</td>
            <td className="font-numeric hidden px-2 py-2 text-right text-[0.78rem] tabular-nums text-ink-muted sm:table-cell">{r.sessions}</td>
            <td className="font-numeric px-3 py-2 text-right text-[0.78rem] tabular-nums">
              {r.tasksCompleted > 0 ? r.tasksCompleted : <span className="text-ink-muted">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
