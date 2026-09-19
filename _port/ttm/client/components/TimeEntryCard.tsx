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
import { Trash2 } from "lucide-react";
import { iconFor, BUILTIN_BREAKS } from "./break-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteTimeEntry, getProjects, type Project } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface TimeEntryProps {
  entry: {
    id: number;
    checkIn: string;
    checkOut: string | null;
    isBreak: boolean;
    notes?: string | null;
    projectId?: number | null;
  };
  index?: number;
}

function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

export default function TimeEntryCard({ entry, index }: TimeEntryProps) {
  const start = new Date(entry.checkIn);
  const end = entry.checkOut ? new Date(entry.checkOut) : null;
  const running = !end;
  const rawDuration = end
    ? Math.floor((end.getTime() - start.getTime()) / 1000)
    : 0;
  // Clamp to non-negative — guards against clock-skew / bad test data.
  const duration = Math.max(0, rawDuration);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    queryFn: () => getProjects(),
  });
  const project = entry.projectId
    ? projects.find((p) => p.id === entry.projectId)
    : undefined;

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

  return (
    <li
      className={`grid grid-cols-[auto_1fr_auto_auto] gap-3 sm:gap-4 items-center py-3 first:pt-4 ${
        running ? "bg-vermilion/5 -mx-2 px-2 rounded-sm" : ""
      }`}
    >
      {/* Index number */}
      <span className="font-numeric text-xs text-ink-muted w-6 tabular-nums">
        {String(index ?? "").padStart(2, "0")}.
      </span>

      {/* Period + note */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-numeric text-sm sm:text-base tabular-nums">
            {format(start, "HH:mm")}
          </span>
          <span className="text-ink-muted">—</span>
          <span
            className={`font-numeric text-sm sm:text-base tabular-nums ${
              running ? "text-vermilion" : ""
            }`}
          >
            {end ? format(end, "HH:mm") : "now"}
          </span>
          {entry.isBreak &&
            (() => {
              // Match the entry's note to a built-in break glyph when possible.
              const note = (entry.notes ?? "").toLowerCase();
              const builtin = BUILTIN_BREAKS.find(
                (b) =>
                  b.name.toLowerCase() === note || b.note.toLowerCase() === note
              );
              const Icon = iconFor(builtin?.icon ?? "coffee");
              return (
                <Icon
                  className="h-3.5 w-3.5 text-vermilion shrink-0"
                  strokeWidth={2}
                  aria-label="Break"
                />
              );
            })()}
        </div>
        <div className="mt-0.5 flex items-center gap-2 min-w-0">
          {project && (
            <span className="inline-flex items-center gap-1 min-w-0 shrink-0">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: project.color || "hsl(var(--vermilion))" }}
                aria-hidden
              />
              <span className="font-display italic text-[11px] text-ink truncate max-w-[140px]">
                {project.name}
              </span>
            </span>
          )}
          {entry.notes ? (
            <span className="font-display italic text-xs text-ink-muted truncate">
              {project ? "· " : ""}{entry.notes}
            </span>
          ) : (
            <span className="eyebrow text-[10px]">
              {project ? "" : entry.isBreak ? "Recess" : "Work session"}
            </span>
          )}
        </div>
      </div>

      {/* Duration */}
      <span
        className={`font-numeric text-sm sm:text-base font-medium tabular-nums whitespace-nowrap ${
          running ? "text-vermilion animate-tick-pulse" : ""
        }`}
      >
        {running ? "…" : formatDuration(duration)}
      </span>

      {/* Delete */}
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
              An ink crossing cannot be undone. The session will be removed from
              every page and report.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm">Keep it</AlertDialogCancel>
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
  );
}
