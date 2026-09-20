/**
 * Generate an invoice: pick a customer and a month, read what it would say, then
 * commit it.
 *
 * the original tracker's dialog generated and downloaded in one click. This one previews first,
 * because the document now carries an agent API cost that is passed through to
 * the customer, and nobody should send that to a client without seeing it.
 * Committing writes an `invoices` row and hands back a durable URL; the PDF
 * itself is rendered from the ledger on every request, so a later correction to
 * an entry shows up the next time the link is opened.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { formatMinutes, formatTokens, formatUsd } from "../format";
import {
  fetchInvoicePdfUrl,
  generateInvoice,
  getStreamsForFilter,
  listInvoices,
  previewInvoice,
  reportKeys,
  type GeneratedInvoice,
} from "./api";
import { Empty, Failed, Loading } from "./bits";
import { MONTH_NAMES, invoiceYears } from "./ranges";

/** Open a fetched PDF in a new tab; the blob URL is released once it is handed over. */
async function openPdf(pdfUrl: string) {
  const url = await fetchInvoicePdfUrl(pdfUrl);
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function InvoiceDialog() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const now = new Date();
  const [customerId, setCustomerId] = useState<string>("");
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [issued, setIssued] = useState<GeneratedInvoice | null>(null);

  const pickers = useQuery({ queryKey: ["track", "pickers"], queryFn: getStreamsForFilter, enabled: open });
  const customers = pickers.data?.customers ?? [];

  const args = customerId ? { customerId: Number(customerId), month, year } : null;
  const preview = useQuery({
    queryKey: reportKeys.invoicePreview(args),
    queryFn: () => previewInvoice(args!),
    enabled: open && args !== null,
  });

  const commit = useMutation({
    mutationFn: () => generateInvoice(args!),
    onSuccess: (result) => {
      setIssued(result);
      qc.invalidateQueries({ queryKey: reportKeys.invoices });
      toast({ title: `Invoice ${result.reference} recorded`, description: `${formatMinutes(result.totals.minutes)} across ${result.lineCount} lines.` });
    },
    onError: (e: Error) => toast({ title: "The invoice could not be recorded", description: e.message, variant: "destructive" }),
  });

  const data = preview.data;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setIssued(null);
          commit.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button className="h-9 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight text-sm">
          <FileText className="h-3.5 w-3.5 mr-2" aria-hidden />
          Generate invoice
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-tight">
            <span className="italic">Render an</span> invoice
          </DialogTitle>
          <DialogDescription className="font-serif">
            One month of a customer's recorded work, with the agents' API cost carried through at face value. No hourly rate is
            configured, so the document states hours.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 py-2">
          <Select value={customerId} onValueChange={setCustomerId}>
            <SelectTrigger className="h-10 rounded-sm border-rule font-display" aria-label="Customer">
              <SelectValue placeholder={customers.length ? "Choose a customer…" : "No customers yet"} />
            </SelectTrigger>
            <SelectContent>
              {customers.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
            <SelectTrigger className="h-10 w-full sm:w-[150px] rounded-sm border-rule font-display" aria-label="Month">
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
            <SelectTrigger className="h-10 w-full sm:w-[100px] rounded-sm border-rule font-numeric" aria-label="Year">
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

        {!customerId ? (
          <p className="eyebrow text-[10px] normal-case tracking-normal font-serif text-ink-muted py-4">
            Choose a customer to see what the month would bill. Time reaches a customer through the stream it was logged against.
          </p>
        ) : preview.isLoading ? (
          <Loading>Drawing up the account…</Loading>
        ) : preview.isError ? (
          <Failed>The preview could not be assembled.</Failed>
        ) : !data ? null : (
          <div className="paper-flat p-4 sm:p-5">
            <div className="flex items-baseline justify-between gap-3 pb-3 mb-3 border-b border-rule">
              <div className="min-w-0">
                <div className="eyebrow">{data.period.label}</div>
                <div className="font-display text-lg truncate">{data.customer.name}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="eyebrow text-[9px]">Total</div>
                <div className="font-numeric text-xl tabular-nums">{formatMinutes(data.totals.minutes)}</div>
                <div className="eyebrow text-[9px] mt-0.5">{data.totals.hours.toFixed(2)} h</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 pb-3 mb-3 border-b border-rule">
              <div>
                <div className="eyebrow">Human</div>
                <div className="font-numeric tabular-nums">{formatMinutes(data.totals.humanMinutes)}</div>
                <div className="eyebrow text-[9px] mt-0.5">{data.totals.humanSessions} sessions</div>
              </div>
              <div className="border-l border-rule pl-4">
                <div className="eyebrow !text-vermilion">Agent</div>
                <div className="font-numeric tabular-nums text-vermilion">{formatMinutes(data.totals.agentMinutes)}</div>
                <div className="eyebrow text-[9px] mt-0.5">
                  {data.totals.agentSessions} sessions · {formatTokens(data.totals.tokens)} tok · {formatUsd(data.totals.costUsd)}
                </div>
              </div>
            </div>

            {data.lines.length === 0 ? (
              <Empty>No recorded work in that month.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[440px] border-collapse">
                  <thead>
                    <tr className="border-b border-rule">
                      {["Line", "Src", "Sess", "Human", "Agent", "Total"].map((h, i) => (
                        <th key={h} scope="col" className={`eyebrow text-[9px] pb-2 px-1 ${i === 0 ? "text-left" : "text-right"}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {data.lines.map((l) => (
                      <tr key={`${l.streamId}:${l.taskId}`}>
                        <td className="py-2 px-1 max-w-[220px]">
                          <span className="font-display text-sm truncate block">{l.taskTitle ?? l.streamName}</span>
                          {l.taskTitle && <span className="eyebrow text-[9px]">{l.streamName}</span>}
                        </td>
                        <td className={`ledger-cell text-right px-1 text-[10px] uppercase ${l.source === "human" ? "text-ink-muted" : "text-vermilion"}`}>
                          {l.source}
                        </td>
                        <td className="ledger-cell text-right px-1 tabular-nums text-ink-muted">{l.sessions}</td>
                        <td className="ledger-cell text-right px-1 tabular-nums">{l.humanMinutes > 0 ? formatMinutes(l.humanMinutes) : "–"}</td>
                        <td className="ledger-cell text-right px-1 tabular-nums text-vermilion">
                          {l.agentMinutes > 0 ? formatMinutes(l.agentMinutes) : "–"}
                        </td>
                        <td className="ledger-cell text-right px-1 tabular-nums">{formatMinutes(l.minutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-baseline justify-between gap-3 mt-3 pt-3 border-t border-rule">
              <span className="font-display text-sm">Agent API cost (pass-through)</span>
              <span className="font-numeric tabular-nums text-vermilion">{formatUsd(data.totals.costUsd)}</span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          {issued ? (
            <>
              <span className="eyebrow text-[9px] mr-auto">Recorded as {issued.reference}</span>
              <Button
                variant="outline"
                onClick={() =>
                  openPdf(issued.pdfUrl).catch((e: Error) =>
                    toast({ title: "The PDF could not be opened", description: e.message, variant: "destructive" })
                  )
                }
                className="h-10 rounded-sm border-ink/30 font-display uppercase tracking-tight text-sm"
              >
                Open the PDF
              </Button>
              <Button
                onClick={() => setOpen(false)}
                className="h-10 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight text-sm"
              >
                Done
              </Button>
            </>
          ) : (
            <Button
              disabled={!customerId || preview.isLoading || commit.isPending || !data}
              onClick={() => commit.mutate()}
              className="h-10 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight text-sm"
            >
              {commit.isPending ? "Recording…" : "Record this invoice"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The invoices already issued, with a link to each one's PDF. */
export function InvoiceLedger() {
  const { toast } = useToast();
  const q = useQuery({ queryKey: reportKeys.invoices, queryFn: listInvoices });
  const rows = q.data ?? [];

  if (q.isLoading) return <Loading>Reading the invoice book…</Loading>;
  if (q.isError) return <Failed>The invoice book could not be read.</Failed>;
  if (rows.length === 0) return <Empty>No invoice has been issued yet.</Empty>;

  return (
    <ul className="divide-y divide-rule">
      {rows.map((r) => (
        <li key={r.id} className="py-2.5 flex items-center gap-3">
          <span className="ledger-cell text-ink-muted tabular-nums w-10 shrink-0">{String(r.id).padStart(4, "0")}</span>
          <div className="min-w-0 flex-1">
            <div className="font-display truncate">{r.customerName ?? "(customer removed)"}</div>
            <div className="eyebrow text-[9px]">
              {r.periodLabel} · {r.status}
              {r.issuedBy && ` · ${r.issuedBy}`}
            </div>
          </div>
          <span className="ledger-cell tabular-nums shrink-0">{formatMinutes(r.totalMinutes)}</span>
          <Button
            variant="ghost"
            className="h-8 rounded-sm font-display text-sm shrink-0"
            onClick={() =>
              openPdf(r.pdfUrl).catch((e: Error) => toast({ title: "The PDF could not be opened", description: e.message, variant: "destructive" }))
            }
          >
            PDF
          </Button>
        </li>
      ))}
    </ul>
  );
}
