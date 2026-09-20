// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Archive, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useMe } from "@/hooks/use-me";
import { signOut } from "@/lib/auth";
import Explainer from "./Explainer";
import { Hint } from "./Hint";
import { deleteOrg, requestExport, type ExportGrant } from "./data/api";

/**
 * Org → Data. Leave with everything, or leave nothing behind.
 *
 * Both halves are owner-only and both are blunt on purpose. A partial export is a
 * promise nobody can check; a soft delete is a copy you were told was gone.
 */
export default function DataTab() {
  const { toast } = useToast();
  const { org, role } = useMe();
  const isOwner = role === "owner";
  const [grant, setGrant] = useState<ExportGrant | null>(null);
  const [typed, setTyped] = useState("");

  const exportNow = useMutation({
    mutationFn: requestExport,
    onSuccess: (data) => {
      setGrant(data);
      // The link is single-use and five minutes long, so it is followed at once
      // rather than left on screen to be clicked later (or twice).
      window.location.href = data.path;
    },
    onError: (err: Error) => toast({ title: "Could not prepare the export", description: err.message, variant: "destructive" }),
  });

  const destroy = useMutation({
    mutationFn: () => deleteOrg(typed.trim()),
    onSuccess: (data) => {
      toast({
        title: `${data.name} is gone`,
        description: `Everything it held was deleted${data.deletedAgentSeats > 0 ? `, including ${data.deletedAgentSeats} agent seat${data.deletedAgentSeats === 1 ? "" : "s"}` : ""}. Signing you out.`,
      });
      // The org this session was bound to no longer exists; anything else would
      // leave the app pointing at a dead X-Org-Id.
      window.setTimeout(() => signOut(), 1800);
    },
    onError: (err: Error) => toast({ title: "Not deleted", description: err.message, variant: "destructive" }),
  });

  const nameMatches = typed.trim() === (org?.name ?? "");

  return (
    <div className="space-y-5">
      <Explainer
        testId="data-explainer"
        why={
          <>
            Your work is yours, in both directions. The export is one ZIP with every row this organization holds — members,
            streams, apps, tasks, their whole history, time entries, invoices and the audit log — in CSV and JSON, readable by a
            spreadsheet or a script, with no PTD needed to open it. Deleting is the other half of the same promise: it removes the
            organization and everything attached to it, at once, with no copy kept. Take the export first.
          </>
        }
        technical={
          <>
            <li>
              <code>org.export</code> (owner) mints a single-use link valid for five minutes; the archive is built when the link is
              fetched, so it is never a stale snapshot. No Authorization header needed — which is what lets a browser, or{" "}
              <code>curl -O</code>, follow it.
            </li>
            <li>
              A stored ZIP with no compression, written here rather than pulled in as a dependency: nine files, CRC-32 per entry,
              UTF-8 names. <code>unzip</code>, Finder, Explorer and <code>python3 -m zipfile</code> all read it.
            </li>
            <li>
              CSV is RFC 4180: CRLF endings, quotes doubled, and a leading <code>=</code>, <code>+</code>, <code>-</code> or{" "}
              <code>@</code> prefixed with an apostrophe so a spreadsheet cannot read a cell as a formula.
            </li>
            <li>
              <code>org.delete</code> (owner) needs the organization's exact name, and refuses while a hosted subscription is live
              — cancel it in Billing first. Deletion cascades through foreign keys; your own account and your other organizations
              survive, and an agent seat that existed only here goes with it.
            </li>
            <li>
              Both are audited. The deletion's row has no organization (the column is a foreign key to the row being deleted), so
              it names what was deleted in its target instead.
            </li>
          </>
        }
      />

      <section className="paper p-4" data-testid="data-export">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="eyebrow text-[9px]">Organization · portability</div>
            <h3 className="font-display mt-0.5 flex items-center gap-2 text-xl tracking-tight">
              <Archive className="h-4 w-4" /> Export everything
            </h3>
            <p className="mt-1 max-w-prose font-serif text-sm text-ink-muted">
              One ZIP: <span className="font-mono text-[0.75rem]">organization.json</span>,{" "}
              <span className="font-mono text-[0.75rem]">members.csv</span>,{" "}
              <span className="font-mono text-[0.75rem]">streams.csv</span>,{" "}
              <span className="font-mono text-[0.75rem]">apps.csv</span>,{" "}
              <span className="font-mono text-[0.75rem]">tasks.csv</span>,{" "}
              <span className="font-mono text-[0.75rem]">task_events.csv</span>,{" "}
              <span className="font-mono text-[0.75rem]">time_entries.csv</span>,{" "}
              <span className="font-mono text-[0.75rem]">invoices.json</span>,{" "}
              <span className="font-mono text-[0.75rem]">audit_events.csv</span>, and a README naming each one.
            </p>
          </div>
          <Hint text="Owner only. The download link works once and expires after five minutes." />
        </div>

        <button
          type="button"
          onClick={() => exportNow.mutate()}
          disabled={!isOwner || exportNow.isPending}
          className="focus-ink mt-4 inline-flex items-center gap-2 border border-ink bg-ink px-4 py-2 font-numeric text-[11px] uppercase tracking-[0.16em] text-parchment transition-all hover:-translate-x-px hover:-translate-y-px hover:bg-parchment hover:text-ink hover:shadow-stamp disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="export-start"
        >
          {exportNow.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
          Download the archive
        </button>
        {!isOwner && <p className="mt-2 text-[0.8rem] text-ink-muted">Only the organization's owner can export it.</p>}
        {grant && (
          <p className="mt-2 text-[0.8rem] text-ink-muted" data-testid="export-grant">
            <span className="font-mono text-[0.75rem]">{grant.filename}</span> — if the download did not start,{" "}
            <a className="focus-ink text-vermilion underline decoration-rule underline-offset-2" href={grant.path}>
              fetch it here
            </a>{" "}
            (the link works once, within five minutes).
          </p>
        )}
      </section>

      <section className={cn("paper p-4", isOwner && "border-vermilion/40")} data-testid="data-delete">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="eyebrow text-[9px] text-vermilion">Organization · irreversible</div>
            <h3 className="font-display mt-0.5 flex items-center gap-2 text-xl tracking-tight">
              <Trash2 className="h-4 w-4 text-vermilion" /> Delete this organization
            </h3>
            <p className="mt-1 max-w-prose font-serif text-sm text-ink-muted">
              Deletes {org?.name ?? "this organization"} and everything in it — every task, every logged hour, every invoice,
              every token, the audit log. There is no undo and no copy. Members keep their accounts and any other organization
              they belong to.
            </p>
          </div>
          <AlertTriangle className="h-4 w-4 shrink-0 text-vermilion" />
        </div>

        {isOwner ? (
          <form
            className="mt-4 flex flex-wrap items-end gap-2 border-t border-rule pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (nameMatches) destroy.mutate();
            }}
          >
            <label className="block flex-1 min-w-[16rem]">
              <span className="eyebrow mb-1.5 block">
                Type <span className="text-ink">{org?.name ?? "the name"}</span> to confirm
              </span>
              <input
                className="draft-input w-full"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={org?.name ?? ""}
                autoComplete="off"
                data-testid="delete-confirm-input"
              />
            </label>
            <button
              type="submit"
              disabled={!nameMatches || destroy.isPending}
              className="focus-ink inline-flex items-center gap-2 border border-vermilion bg-vermilion/10 px-4 py-2.5 font-numeric text-[11px] uppercase tracking-[0.16em] text-vermilion transition-colors hover:bg-vermilion hover:text-parchment disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-vermilion/10 disabled:hover:text-vermilion"
              data-testid="delete-submit"
            >
              {destroy.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Delete permanently
            </button>
          </form>
        ) : (
          <p className="mt-3 text-[0.8rem] text-ink-muted">Only the organization's owner can delete it.</p>
        )}
      </section>
    </div>
  );
}
