import { BadgeCheck, Clock, Lock, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ApprovalStatus } from "./api";

/**
 * Where a line stands in the approval workflow.
 *
 * Four states, and the fourth is the important one: `locked` is not an approval
 * state at all but the consequence of one — the entry has been frozen into a
 * certified invoice and can no longer be edited or struck. It reads as a padlock
 * with the invoice's number because that is what somebody needs to know when the
 * ledger refuses their correction.
 *
 * `none` prints nothing. Most of an organization's hours need no approval, and a
 * chip on every line would say only "normal".
 */
export default function ApprovalChip({
  status,
  lockedInvoiceId,
  className,
}: {
  status: ApprovalStatus;
  lockedInvoiceId?: number | null;
  className?: string;
}) {
  if (lockedInvoiceId) {
    return (
      <span
        className={cn("stamp inline-flex items-center gap-1 border-ink/40 text-ink-muted shrink-0", className)}
        title={`Frozen into certified invoice ${lockedInvoiceId}. The hours behind an issued invoice cannot be changed — void it first.`}
        data-testid="approval-chip-locked"
      >
        <Lock className="h-2.5 w-2.5" /> invoiced
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span
        className={cn("stamp inline-flex items-center gap-1 border-ink/40 text-ink shrink-0", className)}
        title="Submitted and waiting for a manager to approve it. It cannot be invoiced yet."
        data-testid="approval-chip-pending"
      >
        <Clock className="h-2.5 w-2.5" /> pending
      </span>
    );
  }
  if (status === "approved") {
    return (
      <span
        className={cn("stamp inline-flex items-center gap-1 border-sage/60 !text-sage shrink-0", className)}
        title="A manager signed these hours off; they can be invoiced."
        data-testid="approval-chip-approved"
      >
        <BadgeCheck className="h-2.5 w-2.5" /> approved
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span
        className={cn("stamp inline-flex items-center gap-1 border-vermilion/60 !text-vermilion shrink-0", className)}
        title="Sent back by a manager. Correct the line and submit it again; it will not be invoiced as it stands."
        data-testid="approval-chip-rejected"
      >
        <XCircle className="h-2.5 w-2.5" /> rejected
      </span>
    );
  }
  return null;
}
