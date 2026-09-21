/**
 * Naming who may read a certified invoice.
 *
 * The verification link proves a document is genuine to anyone who opens it and
 * says nothing else: no organization, no party, no period, no money, no lines.
 * The particulars are released to a **named recipient** who types back a
 * six-digit code emailed to their own address. This dialog maintains that list,
 * and sits on both invoice ledgers — a contractor invoice is shared with the
 * client who commissioned the work, a customer invoice with their accounts desk.
 *
 * One thing about it reads as coyness and is not: the recipient list is masked
 * because the addresses are kept only as a per-invoice salted hash and cannot be
 * read back. So there is no "resend to row three" — re-entering the address
 * re-sends the letter, and the dialog says so rather than hiding it.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { getInvoiceRecipients, reportKeys, shareInvoice, unshareInvoice } from "./api";
import { Empty, Failed, Loading } from "./bits";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The Share dialog.
 *
 * It does three things and explains one: it lists the addresses already named
 * (masked), it takes more, and it takes them away again. The explanation is that
 * the link it is sending is safe to forward — which is the whole reason this
 * dialog exists rather than a "copy link" button.
 */
export default function ShareDialog({
  invoiceId,
  reference,
  verifyUrl,
  onClose,
}: {
  invoiceId: number;
  reference: string;
  verifyUrl: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [raw, setRaw] = useState("");
  const [message, setMessage] = useState("");

  const list = useQuery({ queryKey: reportKeys.invoiceRecipients(invoiceId), queryFn: () => getInvoiceRecipients(invoiceId) });

  const emails = raw
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  const invalid = emails.filter((e) => !EMAIL.test(e));

  const send = useMutation({
    mutationFn: () => shareInvoice({ invoiceId, emails, message: message.trim() || undefined }),
    onSuccess: (r) => {
      qc.setQueryData(reportKeys.invoiceRecipients(invoiceId), r);
      setRaw("");
      setMessage("");
      const added = r.shared.filter((s) => s.added).length;
      toast({
        title: `${reference} shared with ${r.shared.length} ${r.shared.length === 1 ? "address" : "addresses"}`,
        description:
          r.mailed === r.shared.length
            ? `${added} newly named. Each was sent the link and told a code will be emailed to that address on request.`
            : `${added} newly named, but ${r.shared.length - r.mailed} letter${r.shared.length - r.mailed === 1 ? "" : "s"} could not be sent — no SMTP on this deployment. They are on the list; send them the link yourself.`,
      });
    },
    onError: (e: Error) => toast({ title: "Could not share the invoice", description: e.message, variant: "destructive" }),
  });

  const drop = useMutation({
    mutationFn: (email: string) => unshareInvoice({ invoiceId, email }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: reportKeys.invoiceRecipients(invoiceId) });
      toast({
        title: r.removed ? `${r.mask} can no longer open this invoice` : `${r.mask} was not on the list`,
        description: r.removed ? "Any code already sent to that address has been destroyed with it." : undefined,
      });
    },
    onError: (e: Error) => toast({ title: "Could not withdraw access", description: e.message, variant: "destructive" }),
  });

  const recipients = list.data?.recipients ?? [];

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl max-h-[88vh] overflow-y-auto" data-testid="invoice-share-dialog">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-tight">
            <span className="italic">Share</span> {reference}
          </DialogTitle>
          <DialogDescription className="font-serif">
            The link below proves this invoice is genuine to anyone who opens it and shows nothing else — no names, no period, no
            figures, no lines. Its details are released only to the addresses named here, each after a six-digit code emailed to that
            address.
          </DialogDescription>
        </DialogHeader>

        {verifyUrl ? (
          <p className="font-mono text-[11px] break-all text-ink-muted border border-rule p-2.5" data-testid="invoice-share-link">
            {verifyUrl}
          </p>
        ) : null}

        <div className="paper-flat p-4">
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <span className="eyebrow inline-flex items-center gap-1.5">
              <Users className="h-3 w-3" /> named recipients
            </span>
            <span className="eyebrow text-[9px] font-numeric">
              {recipients.length}
              {list.data ? ` / ${list.data.maxRecipients}` : ""}
            </span>
          </div>
          {list.isLoading ? (
            <Loading>Reading the list…</Loading>
          ) : list.isError ? (
            <Failed>{(list.error as Error).message}</Failed>
          ) : recipients.length === 0 ? (
            <Empty>Nobody has been named yet.</Empty>
          ) : (
            <ul className="divide-y divide-rule" data-testid="invoice-recipient-list">
              {recipients.map((r) => (
                <li key={r.mask + r.addedAt} className="py-2 flex items-center gap-3">
                  <span className="font-mono text-xs flex-1 min-w-0 truncate">{r.mask}</span>
                  <span className="eyebrow text-[9px] shrink-0">
                    {r.via === "issue" ? "named at issue" : "shared"} · {r.requests} {r.requests === 1 ? "code" : "codes"} · {r.grants} opened
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="font-serif text-[13px] text-ink-muted mt-2.5 pt-2.5 border-t border-rule">
            Addresses are kept only as a salted hash, so PTD cannot show one back or resend to it by itself. To resend, or to withdraw
            access, type the address again below.
          </p>
        </div>

        <label className="block">
          <span className="eyebrow text-[9px]">addresses — commas, spaces or new lines</span>
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={2}
            placeholder="accounts@northwind.example, auditor@fielding-vance.example"
            className="draft-input w-full mt-1 text-sm focus-ink"
            data-testid="invoice-share-emails"
          />
        </label>
        <label className="block">
          <span className="eyebrow text-[9px]">a line of your own (optional)</span>
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="September's invoice, as agreed — the link verifies it."
            className="draft-input w-full mt-1 text-sm focus-ink"
            data-testid="invoice-share-message"
          />
        </label>

        {invalid.length ? (
          <p className="font-serif text-sm text-vermilion" data-testid="invoice-share-invalid">
            Not an address: {invalid.join(", ")}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {emails.length === 1 && recipients.length ? (
            <Button
              variant="ghost"
              disabled={drop.isPending || invalid.length > 0}
              onClick={() => drop.mutate(emails[0])}
              className="h-10 rounded-sm mr-auto font-display uppercase tracking-tight text-sm text-ink-muted hover:text-vermilion"
              data-testid="invoice-unshare"
            >
              <X className="h-3.5 w-3.5 mr-2" /> Withdraw that address
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} className="h-10 rounded-sm font-display uppercase tracking-tight text-sm">
            Done
          </Button>
          <Button
            disabled={send.isPending || emails.length === 0 || invalid.length > 0}
            onClick={() => send.mutate()}
            className="h-10 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight text-sm"
            data-testid="invoice-share-send"
          >
            {send.isPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-2" />}
            {send.isPending ? "Sending…" : "Send the link"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
