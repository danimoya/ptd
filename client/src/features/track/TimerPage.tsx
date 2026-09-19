import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import Chronograph from "./Chronograph";
import EntryRow from "./EntryRow";
import StreamTaskPicker from "./StreamTaskPicker";
import TemplateMenu from "./TemplateMenu";
import { formatMinutes } from "./format";
import {
  deleteEntry,
  getCurrentEntry,
  getPickers,
  getTodaySummary,
  listEntries,
  listTemplates,
  startEntry,
  stopEntry,
  switchBreak,
  trackKeys,
  type PickerFeed,
  type TemplateRow,
} from "./api";

const dayWindow = () => {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date();
  to.setHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
};

const EMPTY_PICKERS: PickerFeed = { streams: [], tasks: [], customers: [] };

/** Today's page: the chronograph on the left, the day's ledger on the right. */
export default function TimerPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [streamId, setStreamId] = useState<number | undefined>();
  const [taskId, setTaskId] = useState<number | undefined>();
  const [note, setNote] = useState("");
  const [window] = useState(dayWindow);

  const current = useQuery({ queryKey: trackKeys.current, queryFn: getCurrentEntry, refetchInterval: 60_000 });
  const today = useQuery({ queryKey: trackKeys.today, queryFn: getTodaySummary });
  const templates = useQuery({ queryKey: trackKeys.templates, queryFn: listTemplates });
  const pickers = useQuery({ queryKey: trackKeys.pickers, queryFn: getPickers });
  const entries = useQuery({ queryKey: trackKeys.entries(window), queryFn: () => listEntries(window) });

  const refresh = () => qc.invalidateQueries({ queryKey: trackKeys.all });
  const fail = (title: string) => (e: Error) => toast({ title, description: e.message, variant: "destructive" });

  const start = useMutation({
    mutationFn: startEntry,
    onSuccess: (res) => {
      refresh();
      setNote("");
      toast({
        title: res.entry.isBreak ? "Recess started" : "Timer started",
        description: res.cut ? `Previous entry closed at ${formatMinutes(res.cut.minutes)}.` : "A new line has been entered.",
      });
    },
    onError: fail("Could not start the timer"),
  });

  const stop = useMutation({
    mutationFn: () => stopEntry(),
    onSuccess: (res) => {
      refresh();
      toast({ title: "Entry closed", description: `${formatMinutes(res.minutes)} recorded in the ledger.` });
    },
    onError: fail("Could not close the entry"),
  });

  const toBreak = useMutation({
    mutationFn: switchBreak,
    onSuccess: (res) => {
      refresh();
      toast({
        title: "On recess",
        description: res.cut ? `${res.cut.isBreak ? "Break" : "Work session"} closed at ${formatMinutes(res.cut.minutes)}.` : res.entry.notes || undefined,
      });
    },
    onError: fail("Could not switch to a break"),
  });

  const strike = useMutation({
    mutationFn: deleteEntry,
    onSuccess: () => {
      refresh();
      toast({ title: "Entry struck from the ledger" });
    },
    onError: fail("Could not strike the entry"),
  });

  const busy = start.isPending || stop.isPending || toBreak.isPending;
  const feed = pickers.data ?? EMPTY_PICKERS;
  const summary = today.data;
  const open = current.data ?? null;

  const startFromTemplate = (tpl: TemplateRow) => {
    if (tpl.isBreak) {
      toBreak.mutate({ templateId: tpl.id });
      return;
    }
    if (tpl.streamId) setStreamId(tpl.streamId);
    start.mutate({
      streamId: tpl.streamId ?? undefined,
      customerId: tpl.customerId ?? undefined,
      notes: tpl.notes ?? tpl.name,
    });
  };

  // Running entries ride at the top; closed ones follow newest-first, so the
  // most recent activity is always the first thing read.
  const lines = [...(entries.data ?? [])].sort((a, b) => {
    if (!a.checkOut && b.checkOut) return -1;
    if (a.checkOut && !b.checkOut) return 1;
    return +new Date(b.checkIn) - +new Date(a.checkIn);
  });

  return (
    <div className="animate-ink-fade-in">
      <div className="flex items-baseline justify-between gap-3 mb-5 sm:mb-8">
        <div>
          <div className="eyebrow">
            <span className="text-vermilion">§ I.</span> Today's Page
          </div>
          <h1 className="font-display text-2xl sm:text-4xl font-normal tracking-tight leading-tight mt-1">
            <span className="italic">{format(new Date(), "EEEE")},</span> {format(new Date(), "d MMMM yyyy")}
          </h1>
        </div>
        <TemplateMenu templates={templates.data ?? []} streams={feed.streams} onStart={startFromTemplate} disabled={busy} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8 lg:gap-12">
        {/* ── The chronograph ── */}
        <section className="paper p-5 sm:p-8 relative">
          <div className="absolute top-2 left-2 w-3 h-3 border-l border-t border-ink/30" />
          <div className="absolute top-2 right-2 w-3 h-3 border-r border-t border-ink/30" />
          <div className="absolute bottom-2 left-2 w-3 h-3 border-l border-b border-ink/30" />
          <div className="absolute bottom-2 right-2 w-3 h-3 border-r border-b border-ink/30" />

          <div className="flex items-center justify-between mb-5">
            <span className="section-num">I.</span>
            <h2 className="font-display italic text-xl">The Chronograph</h2>
            <span className="eyebrow text-[10px]">01</span>
          </div>

          <Chronograph
            current={open}
            templates={templates.data ?? []}
            busy={busy}
            onStart={() => start.mutate({ streamId, taskId, notes: note.trim() || undefined })}
            onStop={() => stop.mutate()}
            onBreak={(args) => toBreak.mutate(args)}
          />

          {!open && (
            <div className="mt-6 sm:mt-8 pt-5 border-t border-rule space-y-3">
              <div>
                <span className="eyebrow block mb-2">What are you working on</span>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional note for this line…"
                  className="h-12 rounded-sm border-ink/30 bg-transparent font-serif text-base"
                />
              </div>
              <StreamTaskPicker
                streams={feed.streams}
                tasks={feed.tasks}
                customers={feed.customers}
                streamId={streamId}
                taskId={taskId}
                disabled={busy}
                onChange={(next) => {
                  setStreamId(next.streamId);
                  setTaskId(next.taskId);
                }}
              />
            </div>
          )}

          <div className="mt-6 sm:mt-8 grid grid-cols-2 rule-t pt-4">
            <div className="pr-4 border-r border-rule">
              <div className="eyebrow">Work today</div>
              <div className="font-numeric text-2xl mt-1 tracking-tight">{formatMinutes(summary?.minutes ?? 0)}</div>
            </div>
            <div className="pl-4">
              <div className="eyebrow">Recess</div>
              <div className="font-numeric text-2xl mt-1 tracking-tight text-ink-muted">{formatMinutes(summary?.breakMinutes ?? 0)}</div>
            </div>
          </div>

          {!!summary?.byStream.some((s) => s.minutes > 0) && (
            <ul className="mt-4 pt-3 border-t border-rule space-y-1">
              {summary.byStream.filter((s) => s.minutes > 0).map((s) => (
                <li key={s.streamId ?? "none"} className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.streamColor || "hsl(var(--ink) / 0.25)" }} aria-hidden />
                    <span className="font-display italic text-[13px] truncate">{s.streamName ?? "Unattributed"}</span>
                  </span>
                  <span className="font-numeric text-xs tabular-nums text-ink-muted">{formatMinutes(s.minutes)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Today's ledger ── */}
        <section className="paper p-5 sm:p-8">
          <div className="flex items-center justify-between mb-5">
            <span className="section-num">II.</span>
            <h2 className="font-display italic text-xl">Today's Ledger</h2>
            <span className="eyebrow text-[10px]">{String(lines.length).padStart(2, "0")}</span>
          </div>

          <div className="hidden sm:grid grid-cols-[auto_1fr_auto_auto] gap-4 pb-2 border-b border-ink/60 eyebrow text-[10px]">
            <span className="w-6">№</span>
            <span>Period · source</span>
            <span>Duration</span>
            <span className="w-8 text-right">—</span>
          </div>

          {entries.isLoading ? (
            <div className="py-10 text-center eyebrow">Loading pages…</div>
          ) : entries.isError ? (
            <div className="py-10 text-center text-vermilion font-display italic">A page could not be fetched.</div>
          ) : lines.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-3 text-center">
              <div className="fleuron w-full max-w-[220px]">❧</div>
              <div className="font-display italic text-ink-muted">The day begins unmarked.</div>
              <div className="eyebrow text-[10px]">Commence a session beside</div>
            </div>
          ) : (
            <ul className="divide-y divide-rule">
              {lines.map((entry, idx) => (
                <EntryRow key={entry.id} entry={entry} index={idx + 1} onDelete={strike.mutate} deleting={strike.isPending} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
