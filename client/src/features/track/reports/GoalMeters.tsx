/**
 * Customers against their weekly pledge.
 *
 * Ported from TTM's CustomerGoalProgress, with two changes: the figure comes
 * from the server (`customer.goals`) rather than being recomputed in the
 * browser from every entry ever logged, and each meter says how much of the
 * week's hours a machine put in — a customer whose 20 hours were four-fifths
 * agent work is a different account from one whose were not.
 */

import { useQuery } from "@tanstack/react-query";
import { useMe, canAccess } from "@/hooks/use-me";
import { formatMinutes, formatUsd } from "../format";
import { getCustomerGoals, reportKeys } from "./api";
import { Empty, Failed, Loading, Meter, Panel } from "./bits";

export default function GoalMeters({ numeral }: { numeral?: string }) {
  const { role } = useMe();
  const allowed = canAccess(role, "manager");
  const q = useQuery({ queryKey: reportKeys.goals, queryFn: getCustomerGoals, enabled: allowed });

  if (!allowed) return null;

  const withGoals = (q.data?.customers ?? []).filter((c) => c.goalMinutes > 0 || c.minutes > 0);

  return (
    <Panel
      eyebrow="Accounts & pledges"
      title={
        <>
          <span className="italic">Hours owed to</span> clients
        </>
      }
      numeral={numeral}
      aside={<span className="eyebrow text-[9px] hidden sm:inline">this week</span>}
    >
      {q.isLoading ? (
        <Loading>Reading the accounts…</Loading>
      ) : q.isError ? (
        <Failed>The accounts could not be read.</Failed>
      ) : withGoals.length === 0 ? (
        <Empty>No customer carries a weekly goal yet.</Empty>
      ) : (
        <div className="divide-y divide-rule">
          {withGoals.map((c) => (
            <div key={c.customerId} className="flex flex-col gap-2 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-display truncate">{c.name}</span>
                <span className="font-numeric text-xs tabular-nums text-ink-muted whitespace-nowrap">
                  {formatMinutes(c.minutes)} <span className="text-ink-muted/60">/</span>{" "}
                  {c.goalMinutes > 0 ? formatMinutes(c.goalMinutes) : "no goal"}
                </span>
              </div>
              <Meter percent={c.pct} />
              <div className="flex items-center justify-between eyebrow text-[10px] gap-3">
                <span>
                  {c.goalMinutes > 0 ? `${Math.round(Math.min(100, c.pct))}% of target` : `${c.sessions} sessions`}
                  {c.agent.minutes > 0 && (
                    <span className="!text-vermilion">
                      {" · "}
                      {formatMinutes(c.agent.minutes)} agent · {formatUsd(c.agent.costUsd)}
                    </span>
                  )}
                </span>
                <span className="shrink-0">
                  {c.goalMinutes === 0 ? "—" : c.met ? "Fulfilled" : `${formatMinutes(c.remainingMinutes)} remaining`}
                </span>
              </div>
              {c.streams.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 eyebrow text-[9px]">
                  {c.streams.map((s) => (
                    <span key={s.streamId}>
                      {s.name} · <span className="tabular-nums">{formatMinutes(s.minutes)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
