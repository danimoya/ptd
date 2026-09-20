// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Download, Loader2, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import Explainer from "./Explainer";
import { Hint } from "./Hint";
import {
  AUDIT_KEY, dayEnd, dayStart, downloadText, exportAudit, kindLabel, kindTone, listAudit,
  type AuditFilters, type AuditPage,
} from "./audit/api";

const PAGE = 50;
const stamp = (v: string) => format(new Date(v), "d MMM yyyy HH:mm:ss");

/**
 * Org → Audit. The organization's own history: who did what, from where.
 *
 * A table, a date range and a kind — not a search box. The log is small enough
 * per organization that filtering by *what happened* answers nearly every
 * question ("who removed that member", "when did this token appear"), and a free
 * text search over a JSON column would promise more than it delivers.
 */
export default function AuditTab() {
  const { toast } = useToast();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);

  const filters: AuditFilters = {
    ...(dayStart(from) ? { from: dayStart(from) } : {}),
    ...(dayEnd(to) ? { to: dayEnd(to) } : {}),
    ...(kind ? { kind } : {}),
    limit: PAGE,
    offset: page * PAGE,
  };

  const log = useQuery<AuditPage>({ queryKey: AUDIT_KEY(filters), queryFn: () => listAudit(filters) });

  const download = useMutation({
    mutationFn: () => exportAudit({ ...(dayStart(from) ? { from: dayStart(from) } : {}), ...(dayEnd(to) ? { to: dayEnd(to) } : {}), ...(kind ? { kind } : {}) }),
    onSuccess: (data) => {
      downloadText(data.filename, data.csv);
      toast({ title: "Audit log exported", description: `${data.rows} row${data.rows === 1 ? "" : "s"} written to ${data.filename}.` });
    },
    onError: (err: Error) => toast({ title: "Could not export", description: err.message, variant: "destructive" }),
  });

  const rows = log.data?.events ?? [];
  const total = log.data?.total ?? 0;
  const kinds = log.data?.kinds ?? [];
  const pages = Math.max(1, Math.ceil(total / PAGE));

  const reset = () => {
    setFrom("");
    setTo("");
    setKind("");
    setPage(0);
  };

  return (
    <div className="space-y-5">
      <Explainer
        testId="audit-explainer"
        why={
          <>
            Every change to who may do what leaves a line here: sign-ins and refused sign-ins, second factors turned on and off,
            roles changed, members removed, tokens minted and revoked, agent seats opened, integrations connected, data exported.
            When something is wrong — a token nobody remembers creating, a member who lost access — this is the record that says
            when it happened and who was holding the pen. It is append-only: nothing in the product writes over a row.
          </>
        }
        technical={
          <>
            <li>
              One row per event in <code>audit_events</code>: organization, actor, kind, target, a JSON <code>meta</code>, and the
              client IP as <code>trust proxy</code> resolves it (the real address behind nginx, not the proxy's).
            </li>
            <li>
              Registry actions marked <code>audited</code> write their row after the handler succeeds — a refused or failed action
              records nothing, because nothing happened.
            </li>
            <li>
              Anything in <code>meta</code> whose key looks like a credential (<code>token</code>, <code>secret</code>,{" "}
              <code>password</code>, <code>code</code>…) is stored as <code>[redacted]</code>. A log that leaks what it logs about
              is worse than no log.
            </li>
            <li>
              <code>audit.list</code> pages (admin+, {PAGE} at a time); a <code>kind</code> ending in a dot is a prefix, so{" "}
              <code>token.</code> matches every token event. <code>audit.export</code> writes the whole range as RFC 4180 CSV.
            </li>
            <li>
              A sign-in has no organization context, so it is recorded against the actor's oldest membership — the same
              organization an API call with no <code>X-Org-Id</code> would resolve to.
            </li>
          </>
        }
      />

      <section className="paper p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="eyebrow text-[9px]">Organization · history</div>
            <h3 className="font-display mt-0.5 flex items-center gap-2 text-xl tracking-tight">
              <ScrollText className="h-4 w-4" /> Audit log
            </h3>
          </div>
          <button
            type="button"
            onClick={() => download.mutate()}
            disabled={download.isPending}
            className="focus-ink inline-flex items-center gap-2 border border-rule px-3 py-2 font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted transition-colors hover:border-ink hover:text-ink disabled:opacity-60"
            data-testid="audit-export"
          >
            {download.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Export CSV
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-rule pt-4">
          <label className="block">
            <span className="eyebrow mb-1.5 block">From</span>
            <input type="date" className="draft-input" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} data-testid="audit-from" />
          </label>
          <label className="block">
            <span className="eyebrow mb-1.5 block">To</span>
            <input type="date" className="draft-input" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} data-testid="audit-to" />
          </label>
          <label className="block">
            <span className="eyebrow mb-1.5 flex items-center gap-1.5">
              Kind
              <Hint text="Only the kinds this organization has actually produced are listed, with how many of each." />
            </span>
            <select className="draft-input min-w-[14rem]" value={kind} onChange={(e) => { setKind(e.target.value); setPage(0); }} data-testid="audit-kind">
              <option value="">everything</option>
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {kindLabel(k.kind)} ({k.count})
                </option>
              ))}
            </select>
          </label>
          {(from || to || kind) && (
            <button type="button" onClick={reset} className="focus-ink py-2.5 font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink" data-testid="audit-reset">
              clear
            </button>
          )}
          <span className="ml-auto stamp font-numeric" data-testid="audit-total">
            {total} event{total === 1 ? "" : "s"}
          </span>
        </div>
      </section>

      <section className="paper overflow-hidden">
        {log.isLoading ? (
          <div className="py-10 text-center" data-testid="audit-loading">
            <Loader2 className="mx-auto h-4 w-4 animate-spin text-ink-muted" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center font-serif text-sm text-ink-muted" data-testid="audit-empty">
            Nothing recorded in this range yet.
          </p>
        ) : (
          <div className="overflow-x-auto nice-scroll">
            <table className="w-full min-w-[46rem] text-left text-[0.82rem]" data-testid="audit-table">
              <thead>
                <tr className="border-b border-rule">
                  <th className="eyebrow px-4 py-2 text-[9px] font-normal">When</th>
                  <th className="eyebrow px-4 py-2 text-[9px] font-normal">What</th>
                  <th className="eyebrow px-4 py-2 text-[9px] font-normal">Subject</th>
                  <th className="eyebrow px-4 py-2 text-[9px] font-normal">Who</th>
                  <th className="eyebrow px-4 py-2 text-[9px] font-normal">From</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const tone = kindTone(row.kind);
                  const hasMeta = row.meta && Object.keys(row.meta).length > 0;
                  return (
                    <React.Fragment key={row.id}>
                      <tr
                        className={cn("border-b border-rule/60 align-top", hasMeta && "cursor-pointer hover:bg-parchment-deep/40")}
                        onClick={() => hasMeta && setOpen(open === row.id ? null : row.id)}
                        data-testid={`audit-row-${row.id}`}
                      >
                        <td className="whitespace-nowrap px-4 py-2 font-numeric text-[0.75rem] text-ink-muted">{stamp(row.at)}</td>
                        <td className="px-4 py-2">
                          <span className={cn("font-display tracking-tight", tone === "alarm" && "text-vermilion")}>{kindLabel(row.kind)}</span>
                          <span className="ml-1.5 font-mono text-[0.68rem] text-ink-muted">{row.kind}</span>
                        </td>
                        <td className="max-w-[16rem] truncate px-4 py-2">{row.target ?? "—"}</td>
                        <td className="max-w-[16rem] truncate px-4 py-2 text-ink-muted">{row.actor}</td>
                        <td className="whitespace-nowrap px-4 py-2 font-mono text-[0.72rem] text-ink-muted">{row.ip ?? "—"}</td>
                      </tr>
                      {open === row.id && hasMeta && (
                        <tr className="border-b border-rule/60 bg-parchment-deep/30">
                          <td colSpan={5} className="px-4 py-2">
                            <pre className="overflow-x-auto nice-scroll font-mono text-[0.7rem] leading-relaxed text-ink-muted" data-testid={`audit-meta-${row.id}`}>
                              {JSON.stringify(row.meta, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-between gap-3 border-t border-rule px-4 py-2.5">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="focus-ink font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink disabled:opacity-40"
              data-testid="audit-prev"
            >
              &larr; newer
            </button>
            <span className="font-numeric text-[0.75rem] text-ink-muted">
              page {page + 1} of {pages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
              className="focus-ink font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink disabled:opacity-40"
              data-testid="audit-next"
            >
              older &rarr;
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
