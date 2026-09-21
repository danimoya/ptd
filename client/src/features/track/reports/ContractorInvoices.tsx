/**
 * Contractor invoices: who is owed what this month, and the certified documents
 * already issued.
 *
 * Two audiences on one panel, because it is one subject.
 *
 *  - A **manager** sees every billable member with the month's approved, pending
 *    and unsubmitted minutes, and issues the invoice from a dialog that previews
 *    the document first. Issuing is irreversible in the sense that matters: the
 *    entries it covers are frozen, and correcting one afterwards means voiding the
 *    invoice in the open rather than editing underneath it. The dialog says so.
 *  - A **member** sees their own invoices and nothing else — the reference, the
 *    amount, the PDF, and the verification link they can hand to anyone who needs
 *    to check the hours were really produced by the system.
 *
 * The verification link is a plain anchor on purpose: it is a URL a contractor is
 * meant to copy into an email, not an in-app route behind a token. What it shows a
 * stranger is a reference, a date and three integrity checks — nothing about who
 * is billing whom for how much. The particulars are released only to an address
 * named in the **Share** dialog, and only after a code emailed to that address.
 *
 * The recipient list is masked, and that is not coyness: the addresses are stored
 * as a per-invoice salted hash and cannot be read back. So there is no "resend to
 * row three" — re-entering the address re-sends the letter, and the dialog says so.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, ExternalLink, FileText, Loader2, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { canAccess, useMe } from "@/hooks/use-me";
import { formatMinutes, formatTokens, formatUsd } from "../format";
import {
  fetchInvoicePdfUrl,
  formatMoney,
  formatRate,
  generateContractorInvoice,
  getContractors,
  listContractorInvoices,
  previewContractorInvoice,
  reportKeys,
  voidInvoice,
  type ContractorInvoiceRow,
  type ContractorsOverview,
} from "./api";
import { Empty, Failed, Loading, Panel } from "./bits";
import ShareDialog from "./ShareInvoiceDialog";
import { MONTH_NAMES, invoiceYears } from "./ranges";

async function openPdf(pdfUrl: string) {
  const url = await fetchInvoicePdfUrl(pdfUrl);
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function ContractorInvoices({ numeral }: { numeral?: string }) {
  const { me, role } = useMe();
  const isManager = canAccess(role, "manager");
  const isAdmin = canAccess(role, "admin");
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [issueFor, setIssueFor] = useState<{ userId: number; name: string } | null>(null);

  const args = { month, year };
  const overview = useQuery({ queryKey: reportKeys.contractors(args), queryFn: () => getContractors(args), enabled: isManager });
  const invoices = useQuery({ queryKey: reportKeys.contractorInvoices, queryFn: () => listContractorInvoices() });

  return (
    <Panel
      eyebrow="Hours billed inwards"
      title={
        <>
          <span className="italic">Contractor</span> invoices
        </>
      }
      numeral={numeral}
      aside={
        isManager ? (
          <div className="flex items-center gap-1.5">
            <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
              <SelectTrigger className="h-7 w-[104px] rounded-sm border-rule font-display text-xs" aria-label="Month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((name, i) => (
                  <SelectItem key={name} value={String(i + 1)}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger className="h-7 w-[76px] rounded-sm border-rule font-numeric text-xs" aria-label="Year">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {invoiceYears().map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null
      }
    >
      {isManager ? (
        overview.isLoading ? (
          <Loading>Reading the contractors…</Loading>
        ) : overview.isError ? (
          <Failed>The contractors could not be read.</Failed>
        ) : (overview.data?.contractors.length ?? 0) === 0 ? (
          <div className="py-6 text-center">
            <p className="font-display italic text-ink-muted">No member is marked external yet.</p>
            <p className="eyebrow text-[9px] mt-2 normal-case tracking-normal font-serif">
              Turn billing on for a member in Org → Members; PTD then invoices their hours and certifies the document.
            </p>
          </div>
        ) : (
          <ContractorTable data={overview.data!} onIssue={(userId, name) => setIssueFor({ userId, name })} />
        )
      ) : null}

      <div className={isManager ? "mt-5 pt-4 border-t border-rule" : undefined}>
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <span className="eyebrow">{isManager ? "Issued and certified" : "Your invoices"}</span>
          <span className="eyebrow text-[9px] font-numeric">{invoices.data?.length ?? 0}</span>
        </div>
        {invoices.isLoading ? (
          <Loading>Reading the invoice book…</Loading>
        ) : invoices.isError ? (
          <Failed>The invoice book could not be read.</Failed>
        ) : (invoices.data?.length ?? 0) === 0 ? (
          <Empty>No contractor invoice has been issued yet.</Empty>
        ) : (
          <ul className="divide-y divide-rule" data-testid="contractor-invoice-list">
            {invoices.data!.map((row) => (
              <InvoiceLine key={row.id} row={row} canVoid={isAdmin} />
            ))}
          </ul>
        )}
      </div>

      {issueFor ? (
        <IssueDialog
          userId={issueFor.userId}
          name={issueFor.name}
          month={month}
          year={year}
          onClose={() => setIssueFor(null)}
        />
      ) : null}
      {!isManager && me ? null : null}
    </Panel>
  );
}

function ContractorTable({ data, onIssue }: { data: ContractorsOverview; onIssue: (userId: number, name: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse" data-testid="contractor-table">
        <thead>
          <tr className="border-b border-rule">
            {["Contractor", "Rate", "Approved", "Waiting", "Amount", ""].map((h, i) => (
              <th key={h || i} scope="col" className={`eyebrow text-[9px] pb-2 px-1 ${i === 0 ? "text-left" : i === 5 ? "text-right" : "text-right"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {data.contractors.map((c) => {
            const waiting = c.minutes.pending + c.minutes.none;
            return (
              <tr key={c.userId} data-testid={`contractor-row-${c.userId}`}>
                <td className="py-2 px-1">
                  <span className="font-display text-sm block truncate max-w-[200px]">{c.billingName ?? c.displayName}</span>
                  <span className="eyebrow text-[9px]">
                    {c.displayName}
                    {c.requireApproval ? " · approval required" : ""}
                  </span>
                </td>
                <td className="ledger-cell text-right px-1 tabular-nums">{formatRate(c.hourlyRate, c.currency)}</td>
                <td className="ledger-cell text-right px-1 tabular-nums">{formatMinutes(c.minutes.approved)}</td>
                <td className={`ledger-cell text-right px-1 tabular-nums ${waiting > 0 ? "text-vermilion" : "text-ink-muted"}`}>
                  {waiting > 0 ? formatMinutes(waiting) : "–"}
                </td>
                <td className="ledger-cell text-right px-1 tabular-nums">{formatMoney(c.amountCents, c.currency)}</td>
                <td className="py-2 px-1 text-right">
                  {c.invoice && !c.invoice.voided ? (
                    <span className="stamp border-sage/60 !text-sage inline-flex items-center gap-1" title={`Already issued as ${c.invoice.reference}`}>
                      <BadgeCheck className="h-2.5 w-2.5" /> issued
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      className="h-7 rounded-sm font-display text-xs"
                      disabled={c.minutes.billable === 0}
                      title={
                        c.minutes.billable === 0
                          ? "Nothing approved to invoice in this month."
                          : "Preview the month, then freeze and sign it."
                      }
                      onClick={() => onIssue(c.userId, c.displayName)}
                      data-testid={`contractor-issue-${c.userId}`}
                    >
                      Issue…
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function InvoiceLine({ row, canVoid }: { row: ContractorInvoiceRow; canVoid: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [sharing, setSharing] = useState(false);

  const kill = useMutation({
    mutationFn: () => voidInvoice({ invoiceId: row.id, reason: reason.trim() }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["track"] });
      setReason("");
      toast({
        title: `${r.reference ?? `Invoice ${r.invoiceId}`} voided`,
        description: `${r.unlockedEntries.length} ${r.unlockedEntries.length === 1 ? "entry" : "entries"} released. The document still verifies, as withdrawn.`,
      });
    },
    onError: (e: Error) => toast({ title: "Could not void the invoice", description: e.message, variant: "destructive" }),
  });

  return (
    <li className="py-2.5 flex flex-wrap items-center gap-3" data-testid={`contractor-invoice-${row.id}`}>
      <span className="ledger-cell text-ink-muted tabular-nums shrink-0">{row.reference ?? String(row.id).padStart(4, "0")}</span>
      <div className="min-w-0 flex-1">
        <div className="font-display truncate">
          {row.memberName ?? "(member removed)"}
          {row.voided ? <span className="stamp border-vermilion/60 !text-vermilion ml-2">voided</span> : null}
        </div>
        <div className="eyebrow text-[9px]">
          {row.periodLabel} · {formatMinutes(row.totalMinutes)}
          {row.rate !== null ? ` · ${formatRate(row.rate, row.currency)}` : ""}
          {row.contentHash ? ` · ${row.contentHash.slice(0, 8)}` : ""}
        </div>
      </div>
      <span className="ledger-cell tabular-nums shrink-0">{formatMoney(row.amountCents, row.currency)}</span>
      {row.verifyUrl ? (
        <a
          href={row.verifyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="h-8 px-2 rounded-sm inline-flex items-center gap-1.5 text-ink-muted hover:text-vermilion focus-ink shrink-0"
          title="Open the verification page. The link proves the invoice is genuine to anyone; its details need a code emailed to a named recipient."
          data-testid={`contractor-verify-${row.id}`}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          <span className="eyebrow text-[9px] !text-current">verify</span>
          <ExternalLink className="h-2.5 w-2.5" />
        </a>
      ) : null}
      {row.verifyUrl ? (
        <Button
          variant="ghost"
          className="h-8 rounded-sm font-display text-sm shrink-0"
          onClick={() => setSharing(true)}
          title="Name the people who may read this invoice's details"
          data-testid={`contractor-share-${row.id}`}
        >
          Share
        </Button>
      ) : null}
      <Button
        variant="ghost"
        className="h-8 rounded-sm font-display text-sm shrink-0"
        onClick={() => openPdf(row.pdfUrl).catch((e: Error) => toast({ title: "The PDF could not be opened", description: e.message, variant: "destructive" }))}
        data-testid={`contractor-pdf-${row.id}`}
      >
        PDF
      </Button>
      {canVoid && !row.voided ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" className="h-8 rounded-sm font-display text-sm text-ink-muted hover:text-vermilion shrink-0" data-testid={`contractor-void-${row.id}`}>
              Void
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="paper border-ink/20 rounded-sm">
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display font-normal italic text-2xl">Void {row.reference ?? `invoice ${row.id}`}?</AlertDialogTitle>
              <AlertDialogDescription className="font-serif text-base">
                The entries it froze are released, so they can be corrected and invoiced again. The document itself is not deleted —
                any copy already sent goes on verifying, and says it was withdrawn.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <label className="block">
              <span className="eyebrow text-[9px]">reason</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Rate agreed at 45/h after the fact"
                className="draft-input w-full mt-1 text-sm focus-ink"
                data-testid={`contractor-void-reason-${row.id}`}
              />
            </label>
            <AlertDialogFooter>
              <AlertDialogCancel className="rounded-sm">Keep it</AlertDialogCancel>
              <AlertDialogAction
                disabled={!reason.trim() || kill.isPending}
                onClick={() => kill.mutate()}
                className="rounded-sm bg-vermilion hover:bg-ink text-parchment"
              >
                Void
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {sharing ? (
        <ShareDialog
          invoiceId={row.id}
          reference={row.reference ?? `invoice ${row.id}`}
          verifyUrl={row.verifyUrl ?? ""}
          onClose={() => setSharing(false)}
        />
      ) : null}
    </li>
  );
}

function IssueDialog({ userId, name, month, year, onClose }: { userId: number; name: string; month: number; year: number; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const args = { userId, month, year };
  const preview = useQuery({ queryKey: reportKeys.contractorPreview(args), queryFn: () => previewContractorInvoice(args) });
  const [issued, setIssued] = useState<{ invoiceId: number; reference: string; verifyUrl: string; pdfUrl: string; contentHash: string } | null>(null);
  const [share, setShare] = useState(false);

  const commit = useMutation({
    mutationFn: () => generateContractorInvoice(args),
    onSuccess: (r) => {
      setIssued({ invoiceId: r.invoiceId, reference: r.reference, verifyUrl: r.verifyUrl, pdfUrl: r.pdfUrl, contentHash: r.contentHash });
      qc.invalidateQueries({ queryKey: ["track"] });
      toast({
        title: `${r.reference} issued and signed`,
        description: `${r.entryCount} ${r.entryCount === 1 ? "entry" : "entries"} frozen; ${formatMoney(r.totals.amountCents, r.currency)} due. The link is safe to forward — share it with whoever may read the details.`,
      });
    },
    onError: (e: Error) => toast({ title: "The invoice could not be issued", description: e.message, variant: "destructive" }),
  });

  const d = preview.data;
  const waiting = (d?.excluded.pendingMinutes ?? 0) + (d?.excluded.unsubmittedMinutes ?? 0);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-tight">
            <span className="italic">Issue a certified</span> invoice
          </DialogTitle>
          <DialogDescription className="font-serif">
            {name}'s recorded hours for {d?.period.label ?? `${MONTH_NAMES[month - 1]} ${year}`}. Issuing freezes every line below into
            a signed record and locks it against later edits, and hands back a link that proves the invoice is genuine to anyone who
            opens it. The details behind the link go only to the people you name — {name} is named automatically.
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading ? (
          <Loading>Drawing up the account…</Loading>
        ) : preview.isError ? (
          <Failed>{(preview.error as Error).message}</Failed>
        ) : !d ? null : (
          <div className="paper-flat p-4 sm:p-5">
            <div className="flex items-baseline justify-between gap-3 pb-3 mb-3 border-b border-rule">
              <div className="min-w-0">
                <div className="eyebrow">{d.period.label}</div>
                <div className="font-display text-lg truncate">{d.contractor.billingName ?? d.contractor.name}</div>
                {d.contractor.taxId ? <div className="eyebrow text-[9px] font-mono">{d.contractor.taxId}</div> : null}
              </div>
              <div className="text-right shrink-0">
                <div className="eyebrow text-[9px]">{formatRate(d.rate, d.currency)}</div>
                <div className="font-numeric text-xl tabular-nums">{formatMoney(d.totals.amountCents, d.currency)}</div>
                <div className="eyebrow text-[9px] mt-0.5">{d.totals.hours.toFixed(2)} h</div>
              </div>
            </div>

            {waiting > 0 ? (
              <p className="eyebrow text-[9px] !text-vermilion mb-3 normal-case tracking-normal font-serif" data-testid="contractor-waiting-note">
                {formatMinutes(waiting)} in this month {waiting === 1 ? "is" : "are"} not approved and will be left out.
                {d.onlyApproved ? " Approve it on the ledger first if it should be billed." : ""}
              </p>
            ) : null}

            {d.lines.length === 0 ? (
              <Empty>Nothing billable in that month.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[460px] border-collapse">
                  <thead>
                    <tr className="border-b border-rule">
                      {["Date", "Stream · task", "Src", "Hours", "Amount"].map((h, i) => (
                        <th key={h} scope="col" className={`eyebrow text-[9px] pb-2 px-1 ${i < 2 ? "text-left" : "text-right"}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {d.lines.map((l) => (
                      <tr key={`${l.date}:${l.streamId}:${l.taskId}`}>
                        <td className="ledger-cell px-1 whitespace-nowrap">{l.dateLabel}</td>
                        <td className="py-2 px-1 max-w-[220px]">
                          <span className="font-display text-sm truncate block">
                            {l.taskKey ? `${l.taskKey} ` : ""}
                            {l.taskTitle ?? l.streamName ?? "Unassigned"}
                          </span>
                          {l.taskTitle && l.streamName ? <span className="eyebrow text-[9px]">{l.streamName}</span> : null}
                        </td>
                        <td className={`ledger-cell text-right px-1 text-[10px] uppercase ${l.source === "human" ? "text-ink-muted" : "text-vermilion"}`}>{l.source}</td>
                        <td className="ledger-cell text-right px-1 tabular-nums">{formatMinutes(l.minutes)}</td>
                        <td className="ledger-cell text-right px-1 tabular-nums">{formatMoney(l.amountCents, d.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {d.totals.tokens > 0 ? (
              <div className="flex items-baseline justify-between gap-3 mt-3 pt-3 border-t border-rule">
                <span className="font-display text-sm">Agent tokens consumed while this work was done</span>
                <span className="font-numeric tabular-nums text-vermilion">
                  {formatTokens(d.totals.tokens)} · {formatUsd(d.totals.costUsd)}
                </span>
              </div>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          {issued ? (
            <>
              <span className="eyebrow text-[9px] mr-auto">
                {issued.reference} · {issued.contentHash.slice(0, 12)}
              </span>
              <a
                href={issued.verifyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="h-10 px-3 rounded-sm border border-ink/30 inline-flex items-center gap-2 font-display uppercase tracking-tight text-sm focus-ink"
                data-testid="issued-verify-link"
              >
                <ShieldCheck className="h-3.5 w-3.5" /> Verification page
              </a>
              <Button
                variant="outline"
                onClick={() => setShare(true)}
                className="h-10 rounded-sm border-ink/30 font-display uppercase tracking-tight text-sm"
                data-testid="issued-share"
              >
                <Send className="h-3.5 w-3.5 mr-2" /> Share it
              </Button>
              <Button
                variant="outline"
                onClick={() => openPdf(issued.pdfUrl).catch((e: Error) => toast({ title: "The PDF could not be opened", description: e.message, variant: "destructive" }))}
                className="h-10 rounded-sm border-ink/30 font-display uppercase tracking-tight text-sm"
              >
                <FileText className="h-3.5 w-3.5 mr-2" /> Open the PDF
              </Button>
              <Button onClick={onClose} className="h-10 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight text-sm">
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} className="h-10 rounded-sm font-display uppercase tracking-tight text-sm">
                Cancel
              </Button>
              <Button
                disabled={commit.isPending || !d || d.lines.length === 0}
                onClick={() => commit.mutate()}
                className="h-10 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight text-sm"
                data-testid="contractor-issue-confirm"
              >
                {commit.isPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : null}
                {commit.isPending ? "Signing…" : "Freeze, sign and issue"}
              </Button>
            </>
          )}
        </div>

        {share && issued ? (
          <ShareDialog invoiceId={issued.invoiceId} reference={issued.reference} verifyUrl={issued.verifyUrl} onClose={() => setShare(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
