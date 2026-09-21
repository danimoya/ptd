// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BarChart3, CheckCircle2, ExternalLink, Loader2, RefreshCw, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import CopyBlock from "../CopyBlock";
import { Hint } from "../Hint";
import OfflineSubmission from "./OfflineSubmission";
import {
  TELEMETRY_KEY,
  checkTelemetryUpdates,
  getTelemetry,
  sendTelemetryPing,
  setTelemetryPreferences,
  type TelemetryView,
} from "./api";

/**
 * Org → Data → Installation telemetry.
 *
 * The policy, stated once and enforced by the code above it:
 *
 *   Telemetry is **opt-in and off by default**. When enabled, PTD posts a weekly
 *   ping containing four fields and nothing else. It does not send your IP,
 *   username, email, hostname, OS, organization names, counts, or any contents of
 *   your tasks, time entries or invoices. The receiver keeps a salted hash of
 *   (IP, installation_id) bucketed by ISO week, so active installs are
 *   deduplicated without anyone holding a re-identifiable address.
 *
 * Which is why this section leads with the exact JSON rather than a reassurance:
 * the operator sees the precise bytes before deciding, and the preview is built
 * by the same function that does the posting.
 *
 * Owner-only, and instance-wide: the toggles belong to the installation, not to
 * this organization. DataTab renders the section for owners only; the API refuses
 * everyone else regardless.
 */
export default function TelemetrySection() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const view = useQuery<TelemetryView>({ queryKey: TELEMETRY_KEY, queryFn: getTelemetry });

  const prefs = useMutation({
    mutationFn: setTelemetryPreferences,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TELEMETRY_KEY });
      toast({ title: "Saved", description: "Telemetry preferences updated for this installation." });
    },
    onError: (err: Error) => toast({ title: "Not saved", description: err.message, variant: "destructive" }),
  });

  const ping = useMutation({
    mutationFn: sendTelemetryPing,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: TELEMETRY_KEY });
      if (r.ok) toast({ title: "Ping accepted", description: `The receiver answered ${r.receiverStatus}.` });
      else
        toast({
          title: "Not sent",
          description: r.error === "telemetry-disabled" ? "Turn the ping on first — nothing is sent while it is off." : (r.error ?? "unknown error"),
          variant: "destructive",
        });
    },
    onError: (err: Error) => toast({ title: "Not sent", description: err.message, variant: "destructive" }),
  });

  const updates = useMutation({
    mutationFn: checkTelemetryUpdates,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: TELEMETRY_KEY });
      if (r.notes === "update-checks-disabled") toast({ title: "Update checks are off", description: "Turn them on to query the releases feed.", variant: "destructive" });
      else if (r.upgradeAvailable) toast({ title: `Version ${r.latest} is out`, description: `You are running ${r.current}.` });
      else toast({ title: "Up to date", description: `Running ${r.current}.` });
    },
    onError: (err: Error) => toast({ title: "Check failed", description: err.message, variant: "destructive" }),
  });

  if (view.isLoading) {
    return (
      <section className="paper p-4" data-testid="data-telemetry">
        <div className="flex items-center gap-2 text-ink-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> <span className="text-[0.8rem]">Reading the install record…</span>
        </div>
      </section>
    );
  }

  if (view.error || !view.data) {
    return (
      <section className="paper p-4" data-testid="data-telemetry">
        <div className="eyebrow text-[9px]">Installation · telemetry</div>
        <p className="mt-1 text-[0.8rem] text-ink-muted">Could not read the install record: {(view.error as Error | null)?.message ?? "unknown error"}</p>
      </section>
    );
  }

  const { status, payload, policy } = view.data;
  const result = status.lastPingResult;

  return (
    <section className="paper p-4" id="installation-telemetry" data-testid="data-telemetry">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow text-[9px]">Installation · anonymous, opt-in</div>
          <h3 className="font-display mt-0.5 flex items-center gap-2 text-xl tracking-tight">
            <BarChart3 className="h-4 w-4" /> Installation telemetry
          </h3>
          <p className="mt-1 max-w-prose font-serif text-sm text-ink-muted" data-testid="telemetry-policy">
            {policy.summary}
          </p>
        </div>
        <Hint text="Owner only, and instance-wide: one install record for this deployment, not one per organization." />
      </div>

      {/* The two toggles. Independent on purpose: the update check sends nothing. */}
      <div className="mt-4 grid gap-2 border-t border-rule pt-4">
        <label className="flex cursor-pointer select-none items-start gap-2.5">
          <input
            type="checkbox"
            checked={status.telemetryEnabled}
            disabled={prefs.isPending || status.envPinned}
            onChange={(e) => prefs.mutate({ telemetryEnabled: e.target.checked })}
            className="accent-vermilion mt-0.5 h-3.5 w-3.5"
            data-testid="telemetry-toggle-ping"
          />
          <span>
            <span className="block font-display text-base tracking-tight">Submit a weekly install ping</span>
            <span className="block text-[0.8rem] text-ink-muted">
              Posts the JSON below to <span className="font-mono text-[0.75rem]">{status.endpoint}</span>, once a week. Nothing else, ever.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer select-none items-start gap-2.5">
          <input
            type="checkbox"
            checked={status.updateChecksEnabled}
            disabled={prefs.isPending}
            onChange={(e) => prefs.mutate({ updateChecksEnabled: e.target.checked })}
            className="accent-vermilion mt-0.5 h-3.5 w-3.5"
            data-testid="telemetry-toggle-updates"
          />
          <span>
            <span className="block font-display text-base tracking-tight">Check for updates</span>
            <span className="block text-[0.8rem] text-ink-muted">
              A bare GET against <span className="font-mono text-[0.75rem]">{status.updateCheckUrl}</span>. No payload leaves this host.
            </span>
          </span>
        </label>
        {status.envPinned ? (
          <p className="flex items-start gap-1.5 text-[0.8rem] text-ink-muted">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-vermilion" />
            <span>
              <span className="font-mono text-[0.75rem]">PTD_TELEMETRY</span> is set in the environment, so it decides the ping toggle and this
              checkbox cannot.
            </span>
          </p>
        ) : null}
      </div>

      {/* The exact payload, before anything is sent. */}
      <div className="mt-4 border-t border-rule pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="font-display text-lg tracking-tight">The exact payload</h4>
          <span className="text-[0.8rem] text-ink-muted">Four fields. No headers beyond Content-Type, no cookies, no token.</span>
        </div>
        <CopyBlock className="mt-2" body={JSON.stringify(payload, null, 2)} testId="telemetry-payload" />
        <table className="mt-3 w-full border border-rule text-left">
          <thead>
            <tr>
              <th className="eyebrow border-b border-rule px-2 py-1.5 text-[9px]">Field</th>
              <th className="eyebrow border-b border-rule px-2 py-1.5 text-[9px]">Source</th>
              <th className="eyebrow border-b border-rule px-2 py-1.5 text-[9px]">PII risk</th>
            </tr>
          </thead>
          <tbody>
            {policy.fields.map((f) => (
              <tr key={f.key} className="border-t border-rule/60">
                <td className="px-2 py-1.5 font-mono text-[11px] align-top">{f.key}</td>
                <td className="px-2 py-1.5 text-[0.8rem] text-ink-muted align-top">{f.source}</td>
                <td className="px-2 py-1.5 text-[0.8rem] text-ink-muted align-top">{f.risk}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Act now, and what happened last time. */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-rule pt-4">
        <button
          type="button"
          onClick={() => ping.mutate()}
          disabled={ping.isPending || !status.telemetryEnabled}
          className="focus-ink inline-flex items-center gap-2 border border-ink bg-ink px-4 py-2 font-numeric text-[11px] uppercase tracking-[0.16em] text-parchment transition-all hover:-translate-x-px hover:-translate-y-px hover:bg-parchment hover:text-ink hover:shadow-stamp disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="telemetry-ping-now"
        >
          {ping.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send ping now
        </button>
        <button
          type="button"
          onClick={() => updates.mutate()}
          disabled={updates.isPending || !status.updateChecksEnabled}
          className="focus-ink inline-flex items-center gap-2 border border-rule px-4 py-2 font-numeric text-[11px] uppercase tracking-[0.16em] text-ink transition-colors hover:border-ink disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="telemetry-check-updates"
        >
          {updates.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Check for updates
        </button>
        <span className="text-[0.8rem] text-ink-muted" data-testid="telemetry-last-result">
          {result ? (
            <span className={cn(result.ok ? "text-sage" : "text-vermilion")}>
              {result.ok ? `Last ping accepted (HTTP ${result.status})` : `Last ping failed — ${result.error}`}
            </span>
          ) : (
            <span>No ping has ever been sent from this installation.</span>
          )}
          {status.lastPingAt ? <> · last success {new Date(status.lastPingAt).toLocaleString()}</> : null}
          {status.nextPingDueAt ? <> · next due {new Date(status.nextPingDueAt).toLocaleString()}</> : null}
        </span>
      </div>

      <OfflineSubmission view={view.data} onRefresh={() => void view.refetch()} refreshing={view.isFetching} />

      {/* Retention, verbatim from the receiver's own README. */}
      <div className="mt-4 border-t border-rule pt-4">
        <h4 className="font-display text-lg tracking-tight">What the receiver keeps</h4>
        <ul
          className="mt-2 max-w-prose list-disc space-y-1.5 pl-4 font-serif text-[13px] leading-relaxed text-ink-muted marker:text-vermilion/70"
          data-testid="telemetry-retention"
        >
          {policy.retention.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-2 flex items-start gap-1.5 text-[0.8rem] text-ink-muted">
          <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-sage" />
          <span>
            Receiver source — schema, cron jobs and the salt-rotation script —{" "}
            <a
              className="focus-ink inline-flex items-center gap-1 text-vermilion underline decoration-rule underline-offset-2"
              href={policy.receiverSource}
              target="_blank"
              rel="noopener noreferrer"
            >
              {policy.receiverSource.replace(/^https:\/\//, "")} <ExternalLink className="h-3 w-3" />
            </a>
            . Read it before you opt in. Installation id{" "}
            <span className="font-mono text-[0.75rem]">{status.installationId}</span>, reporting as{" "}
            <span className="font-mono text-[0.75rem]">{status.version}</span>.
          </span>
        </p>
      </div>
    </section>
  );
}
