import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CalendarDays, Loader2, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import CopyBlock from "../CopyBlock";
import { Hint } from "../Hint";
import { absoluteFeedUrl, calendarFeed, type FeedResult } from "./api";

const SCOPES = [
  { value: "me", label: "My cards", note: "Only the cards assigned to you." },
  { value: "org", label: "Whole organization", note: "Every scheduled card. Manager and above." },
] as const;

/**
 * The .ics subscription link.
 *
 * The credential is in the URL — a calendar client cannot send a header — so the
 * warning is not decoration: anyone with this link can read the feed until the
 * token is revoked. The link is generated on demand rather than shown by default
 * so that it is never on screen for someone who did not ask for it.
 */
export default function CalendarFeed({ canSeeOrg }: { canSeeOrg: boolean }) {
  const { toast } = useToast();
  const [scope, setScope] = useState<"me" | "org">("me");
  const [feed, setFeed] = useState<FeedResult | null>(null);

  const mint = useMutation({
    mutationFn: () => calendarFeed(scope),
    onSuccess: (data) => {
      if (data.error) {
        toast({ title: "Not allowed", description: data.message ?? "That scope needs a higher role.", variant: "destructive" });
        return;
      }
      setFeed(data);
      if (data.rotated > 0) {
        toast({ title: "A new link was issued", description: data.note ?? "Earlier calendar links stopped working." });
      }
    },
    onError: (err: Error) => toast({ title: "Could not create the feed", description: err.message, variant: "destructive" }),
  });

  const url = feed ? absoluteFeedUrl(feed) : null;

  return (
    <section className="paper p-4 space-y-3" data-testid="import-calendar">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow text-[9px]">Outbound · read-only</div>
          <h3 className="font-display text-xl tracking-tight mt-0.5 flex items-center gap-2">
            <CalendarDays className="h-4 w-4" /> Calendar feed
          </h3>
          <p className="text-sm font-serif text-ink-muted mt-1 max-w-prose">
            Every card with a start or due date, as all-day events in Google Calendar, Apple Calendar or Outlook. Dates only —
            subscribing never lets a calendar write back to PTD.
          </p>
        </div>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label className="block">
          <span className="eyebrow text-[9px]">scope</span>
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as "me" | "org");
              setFeed(null);
            }}
            className="draft-input w-full mt-1 text-sm h-[38px] focus-ink"
            data-testid="import-calendar-scope"
          >
            {SCOPES.filter((s) => s.value === "me" || canSeeOrg).map((s) => (
              <option key={s.value} value={s.value}>
                {s.label} — {s.note}
              </option>
            ))}
          </select>
        </label>
        <Hint
          side="left"
          text="Shows a subscription URL with its own token inside it — anyone holding the link can read the feed. Pressing it again issues a fresh link and stops the old one."
        >
          <button
            onClick={() => mint.mutate()}
            disabled={mint.isPending}
            className="stamp stamp-strong px-3 py-2 focus-ink inline-flex items-center gap-1.5 justify-self-start sm:justify-self-end"
            data-testid="import-calendar-mint"
          >
            {mint.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {feed ? "New link" : "Show the link"}
          </button>
        </Hint>
      </div>

      {url ? (
        <div className="space-y-2.5">
          <p className={cn("text-xs font-serif flex items-start gap-1.5 text-vermilion")}>
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
            <span>
              This URL is a credential. Anyone holding it can read the feed — share it only with your own calendar, and revoke the{" "}
              <b>{feed!.tokenName}</b> token in <span className="font-mono text-[11px]">Org → Tokens</span> to switch it off.
            </span>
          </p>
          <CopyBlock body={url} label="subscription url" testId="import-calendar-url" />
          <dl className="text-[12px] font-serif text-ink-muted space-y-1">
            {(["google", "apple", "outlook"] as const).map((client) => (
              <div key={client} className="flex gap-2">
                <dt className="microcaps shrink-0 w-16 pt-0.5">{client}</dt>
                <dd>{feed!.instructions[client]}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : (
        <p className="text-[12px] font-serif text-ink-muted">
          The link contains its own credential, so it is only shown when you ask for it.
        </p>
      )}
    </section>
  );
}
