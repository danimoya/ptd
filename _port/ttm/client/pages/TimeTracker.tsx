import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ActiveTimer from "@/components/ActiveTimer";
import TimeEntryCard from "@/components/TimeEntryCard";
import CustomerSelect from "@/components/CustomerSelect";
import ProjectSelect from "@/components/ProjectSelect";
import TemplateMenu from "@/components/TemplateMenu";
import { createTimeEntry, getTimeEntries, type EntryTemplate } from "@/lib/api";
import { format, differenceInMinutes } from "date-fns";
import { useToast } from "@/hooks/use-toast";

function formatHours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

export default function TimeTracker() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>();
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const {
    data: entries = [],
    isError,
    isLoading,
  } = useQuery({ queryKey: ["/api/time-entries"], queryFn: getTimeEntries });

  const startFromTemplate = useMutation({
    mutationFn: (tpl: EntryTemplate) =>
      createTimeEntry({
        isBreak: tpl.isBreak,
        customerId: tpl.customerId ?? undefined,
        projectId: (tpl as any).projectId ?? undefined,
      }),
    onSuccess: (_, tpl) => {
      queryClient.invalidateQueries({ queryKey: ["/api/time-entries"] });
      if (tpl.customerId) setSelectedCustomerId(tpl.customerId.toString());
      if ((tpl as any).projectId) setSelectedProjectId(String((tpl as any).projectId));
      toast({ title: `Started: ${tpl.name}` });
    },
    onError: () => toast({ title: "Failed to start timer", variant: "destructive" }),
  });

  const activeEntry = entries.find((entry) => !entry.checkOut);
  const todayEntries = entries.filter((entry) => {
    const d = new Date(entry.checkIn);
    return format(d, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
  });
  // Ledger shows every entry from today — work + recess, closed + running.
  // Running entries ride at the top; closed entries follow in reverse start
  // order (latest first), so the most recent activity is always at the top.
  const todayAll = [...todayEntries].sort((a, b) => {
    if (!a.checkOut && b.checkOut) return -1;
    if (a.checkOut && !b.checkOut) return 1;
    return +new Date(b.checkIn) - +new Date(a.checkIn);
  });
  const workMinutes = todayEntries.reduce((total, e) => {
    if (e.isBreak || !e.checkOut) return total;
    return total + Math.max(0, differenceInMinutes(new Date(e.checkOut), new Date(e.checkIn)));
  }, 0);
  const breakMinutes = todayEntries.reduce((total, e) => {
    if (!e.isBreak || !e.checkOut) return total;
    return total + Math.max(0, differenceInMinutes(new Date(e.checkOut), new Date(e.checkIn)));
  }, 0);

  return (
    <div className="animate-ink-fade-in">
      {/* =========== DATELINE =========== */}
      <div className="flex items-baseline justify-between gap-3 mb-5 sm:mb-8">
        <div>
          <div className="eyebrow">
            <span className="text-vermilion">§ I.</span> Today's Page
          </div>
          <h1 className="font-display text-2xl sm:text-4xl font-normal tracking-tight leading-tight mt-1">
            <span className="italic">{format(new Date(), "EEEE")},</span>{" "}
            {format(new Date(), "d MMMM yyyy")}
          </h1>
        </div>
        <TemplateMenu
          onStartFromTemplate={(tpl) => startFromTemplate.mutate(tpl)}
          disabled={!!activeEntry || startFromTemplate.isPending}
        />
      </div>

      {/* =========== LAYOUT: timer + ledger =========== */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8 lg:gap-12">
        {/* --- CHRONOGRAPH + CONTROLS --- */}
        <section className="paper p-5 sm:p-8 relative">
          {/* Corner marks */}
          <div className="absolute top-2 left-2 w-3 h-3 border-l border-t border-ink/30" />
          <div className="absolute top-2 right-2 w-3 h-3 border-r border-t border-ink/30" />
          <div className="absolute bottom-2 left-2 w-3 h-3 border-l border-b border-ink/30" />
          <div className="absolute bottom-2 right-2 w-3 h-3 border-r border-b border-ink/30" />

          <div className="flex items-center justify-between mb-5">
            <span className="section-num">I.</span>
            <h2 className="font-display italic text-xl">The Chronograph</h2>
            <span className="eyebrow text-[10px]">01</span>
          </div>

          <ActiveTimer
            activeEntry={
              activeEntry && {
                id: activeEntry.id,
                checkIn: activeEntry.checkIn,
                isBreak: activeEntry.isBreak,
                notes: activeEntry.notes,
              }
            }
            selectedCustomerId={selectedCustomerId}
            selectedProjectId={selectedProjectId}
            onCustomerChange={setSelectedCustomerId}
          />

          {!activeEntry && (
            <div className="mt-6 sm:mt-8 pt-5 border-t border-rule space-y-3">
              <div>
                <span className="eyebrow block mb-2">Client</span>
                <CustomerSelect
                  onCustomerChange={(id) => {
                    setSelectedCustomerId(id);
                    // Clear project if it no longer matches the new customer
                    setSelectedProjectId(undefined);
                  }}
                  selectedCustomerId={selectedCustomerId}
                />
              </div>
              <div>
                <span className="eyebrow block mb-2">Project</span>
                <ProjectSelect
                  selectedProjectId={selectedProjectId}
                  filterCustomerId={selectedCustomerId}
                  onProjectChange={(pid, project) => {
                    setSelectedProjectId(pid);
                    // If the project has a customer and no customer selected yet,
                    // adopt it so the UI stays consistent.
                    if (project?.customerId && !selectedCustomerId) {
                      setSelectedCustomerId(project.customerId.toString());
                    }
                  }}
                />
              </div>
            </div>
          )}

          {/* Today's tally bar */}
          <div className="mt-6 sm:mt-8 grid grid-cols-2 rule-t pt-4">
            <div className="pr-4 border-r border-rule">
              <div className="eyebrow">Work today</div>
              <div className="font-numeric text-2xl mt-1 tracking-tight">
                {formatHours(workMinutes)}
              </div>
            </div>
            <div className="pl-4">
              <div className="eyebrow">Recess</div>
              <div className="font-numeric text-2xl mt-1 tracking-tight text-ink-muted">
                {formatHours(breakMinutes)}
              </div>
            </div>
          </div>
        </section>

        {/* --- LEDGER (TODAY'S ENTRIES) --- */}
        <section className="paper p-5 sm:p-8">
          <div className="flex items-center justify-between mb-5">
            <span className="section-num">II.</span>
            <h2 className="font-display italic text-xl">Today's Ledger</h2>
            <span className="eyebrow text-[10px]">
              {String(todayAll.length).padStart(2, "0")}
            </span>
          </div>

          {/* Table header — visible at ≥sm */}
          <div className="hidden sm:grid grid-cols-[auto_1fr_auto_auto] gap-4 pb-2 border-b border-ink/60 eyebrow text-[10px]">
            <span className="w-6">№</span>
            <span>Period</span>
            <span>Duration</span>
            <span className="w-8 text-right">—</span>
          </div>

          {isLoading ? (
            <div className="py-10 text-center eyebrow">Loading pages…</div>
          ) : isError ? (
            <div className="py-10 text-center text-vermilion font-display italic">
              A page could not be fetched.
            </div>
          ) : todayAll.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-3 text-center">
              <div className="fleuron w-full max-w-[220px]">❧</div>
              <div className="font-display italic text-ink-muted">
                The day begins unmarked.
              </div>
              <div className="eyebrow text-[10px]">
                Commence a session above
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-rule">
              {todayAll.map((entry, idx) => (
                <TimeEntryCard key={entry.id} entry={entry} index={idx + 1} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
