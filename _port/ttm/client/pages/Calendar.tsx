import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar as CalendarUI } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { deleteTimeEntry, getTimeEntries } from "@/lib/api";
import { format, isSameDay, differenceInMinutes } from "date-fns";
import { Coffee, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

export default function Calendar() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [date, setDate] = useState<Date>(new Date());
  const { data: entries = [] } = useQuery({
    queryKey: ["/api/time-entries"],
    queryFn: getTimeEntries,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteTimeEntry,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/time-entries"] });
      toast({ title: "Entry struck from the ledger" });
    },
    onError: () =>
      toast({
        title: "Delete failed",
        description: "Could not strike entry",
        variant: "destructive",
      }),
  });

  const dayEntries = entries.filter((e) => isSameDay(new Date(e.checkIn), date));
  const workMinutes = dayEntries.reduce((t, e) => {
    if (e.isBreak || !e.checkOut) return t;
    return t + differenceInMinutes(new Date(e.checkOut), new Date(e.checkIn));
  }, 0);

  // Days with entries — for marking on calendar
  const markedDays = Array.from(
    new Set(entries.map((e) => format(new Date(e.checkIn), "yyyy-MM-dd")))
  ).map((s) => new Date(s));

  return (
    <div className="animate-ink-fade-in">
      <div className="mb-5 sm:mb-8">
        <div className="eyebrow">
          <span className="text-vermilion">§ II.</span> The Ledger
        </div>
        <h1 className="font-display text-2xl sm:text-4xl font-normal tracking-tight mt-1">
          <span className="italic">Pages</span> by day
        </h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[auto_minmax(0,1fr)] gap-6 lg:gap-10 items-start">
        {/* Calendar paper */}
        <div className="paper p-4 sm:p-6">
          <div className="flex items-center justify-between mb-3">
            <span className="section-num">i.</span>
            <span className="font-display italic text-lg">Select a date</span>
            <span className="eyebrow text-[10px]">
              {format(date, "MMM yyyy").toUpperCase()}
            </span>
          </div>
          <CalendarUI
            mode="single"
            selected={date}
            onSelect={(d) => d && setDate(d)}
            modifiers={{ marked: markedDays }}
            modifiersClassNames={{
              marked:
                "relative after:content-[''] after:absolute after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:w-1 after:h-1 after:rounded-full after:bg-vermilion",
            }}
            className="font-serif"
          />
        </div>

        {/* Day detail paper */}
        <div className="paper p-5 sm:p-7">
          <div className="flex items-start justify-between mb-4 pb-4 border-b border-rule">
            <div>
              <div className="eyebrow">Page</div>
              <h2 className="font-display text-xl sm:text-2xl mt-1">
                <span className="italic">{format(date, "EEEE")}, </span>
                {format(date, "d MMMM")}
              </h2>
            </div>
            <div className="text-right">
              <div className="eyebrow">Recorded</div>
              <div className="font-numeric tabular-nums text-2xl mt-1">
                {formatDuration(workMinutes * 60)}
              </div>
            </div>
          </div>

          {dayEntries.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-3 text-center">
              <div className="fleuron w-full max-w-[220px]">❧</div>
              <div className="font-display italic text-ink-muted">
                No entries on this page.
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-rule">
              {dayEntries.map((entry, idx) => (
                <li key={entry.id} className="py-3 grid grid-cols-[auto_1fr_auto_auto] gap-3 items-center">
                  <span className="font-numeric text-xs text-ink-muted tabular-nums w-6">
                    {String(idx + 1).padStart(2, "0")}.
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-numeric text-sm tabular-nums">
                        {format(new Date(entry.checkIn), "HH:mm")}
                      </span>
                      <span className="text-ink-muted">—</span>
                      <span className="font-numeric text-sm tabular-nums">
                        {entry.checkOut
                          ? format(new Date(entry.checkOut), "HH:mm")
                          : "—"}
                      </span>
                      {entry.isBreak && (
                        <Coffee className="h-3.5 w-3.5 text-vermilion" />
                      )}
                    </div>
                    <div className="eyebrow text-[10px] mt-0.5">
                      {entry.isBreak ? "Recess" : "Work"}
                    </div>
                  </div>
                  <span className="font-numeric text-sm tabular-nums">
                    {entry.checkOut
                      ? formatDuration(
                          (new Date(entry.checkOut).getTime() -
                            new Date(entry.checkIn).getTime()) /
                            1000
                        )
                      : "—"}
                  </span>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Strike entry"
                        className="h-8 w-8 text-ink-muted hover:text-vermilion hover:bg-transparent"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="paper border-ink/20 rounded-sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="font-display font-normal italic text-2xl">
                          Strike this entry from the ledger?
                        </AlertDialogTitle>
                        <AlertDialogDescription className="font-serif text-base">
                          An ink crossing cannot be undone. The session will be
                          removed from every page and report.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="rounded-sm">
                          Keep it
                        </AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => deleteMutation.mutate(entry.id)}
                          disabled={deleteMutation.isPending}
                          className="rounded-sm bg-vermilion hover:bg-ink text-parchment"
                        >
                          Strike
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
