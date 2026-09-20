import { useState } from "react";
import { format } from "date-fns";
import { BadgeCheck, Trash2, XCircle } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { BUILTIN_BREAKS, iconFor } from "@/components/break-icons";
import SourceBadge from "./SourceBadge";
import ApprovalChip from "./ApprovalChip";
import { formatMinutes, minutesBetween } from "./format";
import type { EntryView } from "./api";

/** Match a break's note back to a built-in glyph when we can, so the tile you tapped is the mark you see. */
function breakIcon(notes: string | null) {
  const note = (notes ?? "").toLowerCase();
  const builtin = BUILTIN_BREAKS.find((b) => b.name.toLowerCase() === note || b.note.toLowerCase() === note);
  return iconFor(builtin?.icon ?? "coffee");
}

/**
 * One line of the ledger.
 *
 * Every line states its source. That is the one thing this product knows that a
 * timesheet does not, so it is never behind a hover or a detail pane.
 */
export function EntryRow({
  entry,
  index,
  onDelete,
  deleting,
  showWho = false,
  onApprove,
  onReject,
  acting,
}: {
  entry: EntryView;
  index?: number;
  onDelete?: (id: number) => void;
  deleting?: boolean;
  showWho?: boolean;
  /** Manager-only: sign this line off so it can be invoiced. */
  onApprove?: (id: number) => void;
  /** Manager-only: send it back with a reason. */
  onReject?: (id: number, reason: string) => void;
  acting?: boolean;
}) {
  const start = new Date(entry.checkIn);
  const end = entry.checkOut ? new Date(entry.checkOut) : null;
  const running = !end;
  const minutes = minutesBetween(entry.checkIn, entry.checkOut);
  const BreakIcon = breakIcon(entry.notes);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  // Nothing to review on a break, a running session, or a line already invoiced.
  const canReview = Boolean(onApprove && onReject) && !entry.isBreak && !running && !entry.lockedInvoiceId;

  return (
    <li className={cn("grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 sm:gap-4 items-center py-3 first:pt-4", running && "bg-vermilion/5 -mx-2 px-2 rounded-sm")}>
      <span className="font-numeric text-xs text-ink-muted w-6 tabular-nums">{String(index ?? "").padStart(2, "0")}.</span>

      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-numeric text-sm sm:text-base tabular-nums">{format(start, "HH:mm")}</span>
          <span className="text-ink-muted">—</span>
          <span className={cn("font-numeric text-sm sm:text-base tabular-nums", running && "text-vermilion")}>{end ? format(end, "HH:mm") : "now"}</span>
          {entry.isBreak && <BreakIcon className="h-3.5 w-3.5 text-vermilion shrink-0" strokeWidth={2} aria-label="Break" />}
          <SourceBadge entry={entry} />
          <ApprovalChip status={entry.approvalStatus} lockedInvoiceId={entry.lockedInvoiceId} />
        </div>
        <div className="mt-0.5 flex items-center gap-2 min-w-0">
          {showWho && entry.userName && <span className="font-display italic text-[11px] text-ink shrink-0">{entry.userName}</span>}
          {entry.streamName && (
            <span className="inline-flex items-center gap-1 min-w-0 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: entry.streamColor || "hsl(var(--vermilion))" }} aria-hidden />
              <span className="font-display italic text-[11px] text-ink truncate max-w-[140px]">{entry.streamName}</span>
            </span>
          )}
          {entry.taskTitle && <span className="font-display italic text-[11px] text-ink-muted truncate max-w-[180px]">· {entry.taskTitle}</span>}
          {entry.notes ? (
            <span className="font-display italic text-xs text-ink-muted truncate">{entry.streamName || entry.taskTitle ? "· " : ""}{entry.notes}</span>
          ) : (
            !entry.streamName && !entry.taskTitle && <span className="eyebrow text-[10px]">{entry.isBreak ? "Recess" : "Work session"}</span>
          )}
        </div>
      </div>

      <span className={cn("font-numeric text-sm sm:text-base font-medium tabular-nums whitespace-nowrap", running && "text-vermilion motion-safe:animate-tick-pulse")}>
        {running ? "…" : formatMinutes(minutes)}
      </span>

      {canReview ? (
        <span className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Approve ${entry.userName ?? "this entry"}'s ${minutes} minutes`}
            title="Approve these hours so they can be invoiced"
            disabled={acting}
            onClick={() => onApprove?.(entry.id)}
            className="h-8 w-8 text-ink-muted hover:text-sage hover:bg-transparent"
            data-testid={`entry-approve-${entry.id}`}
          >
            <BadgeCheck className="h-4 w-4" />
          </Button>
          <AlertDialog open={rejecting} onOpenChange={setRejecting}>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Reject ${entry.userName ?? "this entry"}'s ${minutes} minutes`}
                title="Send these hours back with a reason"
                disabled={acting}
                className="h-8 w-8 text-ink-muted hover:text-vermilion hover:bg-transparent"
                data-testid={`entry-reject-${entry.id}`}
              >
                <XCircle className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="paper border-ink/20 rounded-sm">
              <AlertDialogHeader>
                <AlertDialogTitle className="font-display font-normal italic text-2xl">Send these hours back?</AlertDialogTitle>
                <AlertDialogDescription className="font-serif text-base">
                  The line stays on the ledger but stops counting towards an invoice until it is corrected and resubmitted. The
                  reason is recorded in the organization's audit trail, not written over the member's own note.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <label className="block">
                <span className="eyebrow text-[9px]">reason</span>
                <input
                  autoFocus
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Logged against the wrong stream"
                  className="draft-input w-full mt-1 text-sm focus-ink"
                  data-testid={`entry-reject-reason-${entry.id}`}
                />
              </label>
              <AlertDialogFooter>
                <AlertDialogCancel className="rounded-sm">Keep it</AlertDialogCancel>
                <AlertDialogAction
                  disabled={!reason.trim()}
                  onClick={() => {
                    onReject?.(entry.id, reason.trim());
                    setReason("");
                  }}
                  className="rounded-sm bg-vermilion hover:bg-ink text-parchment"
                >
                  Reject
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </span>
      ) : null}

      {onDelete ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Strike entry" className="h-8 w-8 text-ink-muted hover:text-vermilion hover:bg-transparent">
              <Trash2 className="h-4 w-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="paper border-ink/20 rounded-sm">
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display font-normal italic text-2xl">Strike this entry from the ledger?</AlertDialogTitle>
              <AlertDialogDescription className="font-serif text-base">
                An ink crossing cannot be undone. The session leaves every page and every total —
                {entry.entrySource === "agent" ? " including the agent minutes, tokens and cost it contributed." : " including the minutes it contributed."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="rounded-sm">Keep it</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => onDelete(entry.id)}
                disabled={deleting}
                className="rounded-sm bg-vermilion hover:bg-ink text-parchment"
              >
                Strike
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <span className="w-8" />
      )}
    </li>
  );
}

export default EntryRow;
