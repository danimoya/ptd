import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { endOfMonth, format, isSameDay, startOfMonth } from "date-fns";
import { BadgeCheck, Loader2, Send } from "lucide-react";
import { Calendar as CalendarUI } from "@/components/ui/calendar";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { canAccess, useMe } from "@/hooks/use-me";
import EntryRow from "./EntryRow";
import { formatMinutes, formatTokens, formatUsd, minutesBetween } from "./format";
import {
  approveEntries,
  deleteEntry,
  listEntries,
  rejectEntries,
  submitHours,
  trackKeys,
  type EntryView,
} from "./api";
import { getMemberBilling } from "./reports/api";

/**
 * The ledger: a month of pages, one day open at a time.
 *
 * Managers get a Team toggle, which re-reads the same list with
 * `time_entry.list { userId: "all" }` — one call for the whole organization
 * rather than one per member — and each line then names who (or what) logged it.
 * The day's tally splits human from agent, with the agent's tokens and dollars,
 * because that split is the reason this ledger exists.
 */
export default function LedgerPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { me, role } = useMe();
  const isManager = canAccess(role, "manager");

  const [date, setDate] = useState<Date>(() => new Date());
  const [month, setMonth] = useState<Date>(() => new Date());
  const [team, setTeam] = useState(false);

  const window = useMemo(
    () => ({
      from: startOfMonth(month).toISOString(),
      to: endOfMonth(month).toISOString(),
      limit: 500,
      ...(team && isManager ? { userId: "all" as const } : {}),
    }),
    [month, team, isManager]
  );

  const entries = useQuery({ queryKey: trackKeys.entries(window), queryFn: () => listEntries(window) });

  const strike = useMutation({
    mutationFn: deleteEntry,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: trackKeys.all });
      toast({ title: "Entry struck from the ledger" });
    },
    onError: (e: Error) => toast({ title: "Could not strike the entry", description: e.message, variant: "destructive" }),
  });

  /* ── Approvals ──────────────────────────────────────────────────────────
   * An external member's finished entries close as `pending`, so this page is
   * where both halves of that workflow live: the member hands a month over, and
   * a manager reading the Team view signs lines off or sends them back. Neither
   * is a separate screen, because the thing being judged is the ledger line.
   */
  const myBilling = useQuery({
    queryKey: ["track", "my-billing", me?.user.id],
    queryFn: () => getMemberBilling(me!.user.id),
    enabled: Boolean(me?.user.id),
  });
  const needsSubmitting = myBilling.data?.requireApproval ?? false;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: trackKeys.all });
    qc.invalidateQueries({ queryKey: ["track", "contractors"] });
  };

  const submit = useMutation({
    mutationFn: () => submitHours({ from: startOfMonth(month).toISOString(), to: endOfMonth(month).toISOString() }),
    onSuccess: (r) => {
      refresh();
      toast({
        title: r.submitted > 0 ? `${r.submitted} ${r.submitted === 1 ? "line" : "lines"} submitted` : "Nothing left to submit",
        description:
          r.submitted > 0
            ? `${formatMinutes(r.minutes)} of ${format(month, "MMMM")} is now waiting for a manager.`
            : r.alreadyApproved > 0
              ? `All ${r.alreadyApproved} of this month's lines are already approved.`
              : "There are no finished lines in this month.",
      });
    },
    onError: (e: Error) => toast({ title: "Could not submit the month", description: e.message, variant: "destructive" }),
  });

  const approve = useMutation({
    mutationFn: (entryIds: number[]) => approveEntries({ entryIds }),
    onSuccess: (r) => {
      refresh();
      toast({ title: `${r.approved} ${r.approved === 1 ? "line" : "lines"} approved`, description: `${formatMinutes(r.minutes)} can now be invoiced.` });
    },
    onError: (e: Error) => toast({ title: "Could not approve", description: e.message, variant: "destructive" }),
  });

  const reject = useMutation({
    mutationFn: ({ entryIds, reason }: { entryIds: number[]; reason: string }) => rejectEntries({ entryIds, reason }),
    onSuccess: (r) => {
      refresh();
      toast({ title: `${r.rejected} ${r.rejected === 1 ? "line" : "lines"} sent back`, description: r.reason });
    },
    onError: (e: Error) => toast({ title: "Could not reject", description: e.message, variant: "destructive" }),
  });

  const rows = entries.data ?? [];
  const markedDays = useMemo(() => {
    const seen = new Map<string, Date>();
    for (const e of rows) {
      const d = new Date(e.checkIn);
      seen.set(format(d, "yyyy-MM-dd"), d);
    }
    return Array.from(seen.values());
  }, [rows]);

  const dayRows = useMemo(
    () =>
      rows
        .filter((e) => isSameDay(new Date(e.checkIn), date))
        .sort((a, b) => +new Date(a.checkIn) - +new Date(b.checkIn)),
    [rows, date]
  );

  const tally = useMemo(() => {
    const t = { work: 0, breaks: 0, human: 0, agent: 0, tokens: 0, cost: 0 };
    for (const e of dayRows) {
      if (!e.checkOut) continue;
      const minutes = minutesBetween(e.checkIn, e.checkOut);
      if (e.isBreak) {
        t.breaks += minutes;
        continue;
      }
      t.work += minutes;
      if (e.entrySource === "agent") {
        t.agent += minutes;
        t.tokens += e.tokensUsed ?? 0;
        t.cost += e.apiCostUsd ?? 0;
      } else {
        t.human += minutes;
      }
    }
    return t;
  }, [dayRows]);

  const canStrike = (entry: EntryView) => (isManager || entry.userId === me?.user.id) && !entry.lockedInvoiceId;

  // A manager may sign off anyone's hours, including their own; the server allows
  // it and the alternative — an org with one manager whose hours nobody can
  // approve — is worse than the conflict of interest.
  const pendingToday = dayRows.filter((e) => e.approvalStatus === "pending" && !e.lockedInvoiceId);
  const acting = approve.isPending || reject.isPending;

  return (
    <div className="animate-ink-fade-in">
      <div className="mb-5 sm:mb-8 flex items-end justify-between gap-4">
        <div>
          <div className="eyebrow">
            <span className="text-vermilion">§ II.</span> The Ledger
          </div>
          <h1 className="font-display text-2xl sm:text-4xl font-normal tracking-tight mt-1">
            <span className="italic">Pages</span> by day
          </h1>
        </div>
        <div className="flex items-center gap-4 shrink-0">
        {needsSubmitting && (
          <button
            onClick={() => submit.mutate()}
            disabled={submit.isPending}
            title={`Hand every finished line of ${format(month, "MMMM")} to a manager for approval. Only approved hours can be invoiced.`}
            className="h-9 px-3 rounded-sm border border-ink text-ink hover:bg-ink hover:text-parchment transition-colors focus-ink inline-flex items-center gap-2 disabled:opacity-60"
            data-testid="ledger-submit-month"
          >
            {submit.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            <span className="eyebrow text-[9px] !text-current">submit {format(month, "MMM")}</span>
          </button>
        )}
        {isManager && (
          <label className="flex items-center gap-3 cursor-pointer select-none shrink-0">
            <span className="text-right">
              <span className="eyebrow block">Team</span>
              <span className="font-display italic text-[11px] text-ink-muted">{team ? "Everyone's lines" : "Only yours"}</span>
            </span>
            <Switch
              checked={team}
              onCheckedChange={setTeam}
              className="data-[state=checked]:bg-vermilion data-[state=unchecked]:bg-ink/20"
              aria-label="Show the whole team's entries"
            />
          </label>
        )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[auto_minmax(0,1fr)] gap-6 lg:gap-10 items-start">
        <div className="paper p-4 sm:p-6">
          <div className="flex items-center justify-between mb-3">
            <span className="section-num">i.</span>
            <span className="font-display italic text-lg">Select a date</span>
            <span className="eyebrow text-[10px]">{format(month, "MMM yyyy").toUpperCase()}</span>
          </div>
          <CalendarUI
            mode="single"
            selected={date}
            month={month}
            onMonthChange={setMonth}
            onSelect={(d) => d && setDate(d)}
            modifiers={{ marked: markedDays }}
            modifiersClassNames={{
              marked:
                "relative after:content-[''] after:absolute after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:w-1 after:h-1 after:rounded-full after:bg-vermilion",
            }}
            className="font-serif"
          />
          <p className="mt-3 eyebrow text-[9px]">A dot marks a day with lines.</p>
        </div>

        <div className="paper p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4 mb-4 pb-4 border-b border-rule">
            <div>
              <div className="eyebrow">Page</div>
              <h2 className="font-display text-xl sm:text-2xl mt-1">
                <span className="italic">{format(date, "EEEE")}, </span>
                {format(date, "d MMMM")}
              </h2>
              <div className="mt-1 eyebrow text-[10px]">{team ? "Every member" : "Your lines"} · {String(dayRows.length).padStart(2, "0")} lines</div>
            </div>
            <div className="text-right">
              <div className="eyebrow">Recorded</div>
              <div className="font-numeric tabular-nums text-2xl mt-1">{formatMinutes(tally.work)}</div>
              {tally.breaks > 0 && <div className="eyebrow text-[9px] mt-1">+ {formatMinutes(tally.breaks)} recess</div>}
            </div>
          </div>

          {/* Human vs agent — the split this whole surface exists to record. */}
          <div className="grid grid-cols-2 gap-4 mb-4 pb-4 border-b border-rule">
            <div>
              <div className="eyebrow">Human</div>
              <div className="font-numeric text-lg mt-0.5 tabular-nums">{formatMinutes(tally.human)}</div>
            </div>
            <div className="border-l border-rule pl-4">
              <div className="eyebrow !text-vermilion">Agent</div>
              <div className="font-numeric text-lg mt-0.5 tabular-nums text-vermilion">{formatMinutes(tally.agent)}</div>
              {(tally.tokens > 0 || tally.cost > 0) && (
                <div className="font-numeric text-[10px] mt-0.5 text-ink-muted tabular-nums">
                  {formatTokens(tally.tokens)} tok · {formatUsd(tally.cost)}
                </div>
              )}
            </div>
          </div>

          {isManager && pendingToday.length > 0 && (
            <div
              className="mb-4 pb-4 border-b border-rule flex flex-wrap items-center gap-3"
              data-testid="ledger-pending-banner"
            >
              <span className="eyebrow text-[9px]">
                {pendingToday.length} {pendingToday.length === 1 ? "line waits" : "lines wait"} for approval ·{" "}
                {formatMinutes(pendingToday.reduce((t, e) => t + minutesBetween(e.checkIn, e.checkOut), 0))}
              </span>
              <button
                onClick={() => approve.mutate(pendingToday.map((e) => e.id))}
                disabled={acting}
                className="h-8 px-3 rounded-sm border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors focus-ink inline-flex items-center gap-2 disabled:opacity-60"
                data-testid="ledger-approve-day"
              >
                {approve.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <BadgeCheck className="h-3 w-3" />}
                <span className="eyebrow text-[9px] !text-current">approve this page</span>
              </button>
            </div>
          )}

          {entries.isLoading ? (
            <div className="py-10 text-center eyebrow">Loading pages…</div>
          ) : entries.isError ? (
            <div className="py-10 text-center text-vermilion font-display italic">A page could not be fetched.</div>
          ) : dayRows.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-3 text-center">
              <div className="fleuron w-full max-w-[220px]">❧</div>
              <div className="font-display italic text-ink-muted">No entries on this page.</div>
            </div>
          ) : (
            <ul className="divide-y divide-rule">
              {dayRows.map((entry, idx) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  index={idx + 1}
                  showWho={team}
                  onDelete={canStrike(entry) ? strike.mutate : undefined}
                  deleting={strike.isPending}
                  onApprove={isManager ? (id) => approve.mutate([id]) : undefined}
                  onReject={isManager ? (id, reason) => reject.mutate({ entryIds: [id], reason }) : undefined}
                  acting={acting}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
