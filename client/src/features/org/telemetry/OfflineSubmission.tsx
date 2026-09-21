// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { Check, Copy, ExternalLink, RefreshCw, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OfflineFormat, TelemetryPayload, TelemetryView } from "./api";

/**
 * Offline / restricted-egress submission — the same block the Claude-Dashboard
 * telemetry page carries, reproduced here.
 *
 * On an air-gapped or egress-restricted host PTD cannot reach the receiver, so
 * the operator picks a format, copies it, and submits from any machine that can.
 * That still counts exactly once: the receiver dedupes on
 * `SHA-256(salt || ip || installation_id)` per ISO week, so a one-off submission
 * from a different network increments the unique-installs count for this install
 * and no more.
 *
 * The six snippets are rendered server-side from one payload, so the timestamp
 * in the URL, in the curl body and in the preview above are the same timestamp.
 * "Refresh timestamp" refetches, which re-stamps all of them together.
 */
export default function OfflineSubmission({
  view,
  onRefresh,
  refreshing,
}: {
  view: TelemetryView;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  // URL (browser-paste) is the lowest-friction path — pick it by default.
  const [fmt, setFmt] = useState<OfflineFormat>("url");
  const [copied, setCopied] = useState(false);
  const command = view.offline.commands[fmt];
  const payload: TelemetryPayload = view.payload;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // A blocked clipboard is not worth an error state — the text is selectable.
    }
  };

  const hint =
    fmt === "url"
      ? "Copy the URL and open it in any browser on a machine with internet access. The receiver answers a small “Ping received” page."
      : fmt === "json"
        ? `Body for any HTTP client you prefer. POST it to ${view.status.endpoint}.`
        : "Run from any shell on a machine with internet access. Exit 0 and {\"ok\":true} means the ping was counted.";

  return (
    <div className="mt-4 border-t border-rule pt-4" data-testid="telemetry-offline">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow text-[9px]">Air-gapped · out of band</div>
          <h4 className="font-display mt-0.5 flex items-center gap-2 text-lg tracking-tight">
            <WifiOff className="h-4 w-4" /> Offline submission
          </h4>
          <p className="mt-1 max-w-prose font-serif text-[13.5px] leading-relaxed text-ink-muted">{view.policy.offlineNote}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1 border-b border-rule pb-2">
        {view.offline.formats.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFmt(f.id)}
            aria-pressed={fmt === f.id}
            className={cn(
              "focus-ink rounded-sm px-2.5 py-1 font-numeric text-[10px] uppercase tracking-[0.14em] transition-colors",
              fmt === f.id ? "bg-ink text-parchment" : "text-ink-muted hover:text-ink",
            )}
            data-testid={`telemetry-format-${f.id}`}
          >
            {f.label}
            {f.id === "url" ? <span className="ml-1.5 text-[8px] tracking-[0.1em] opacity-70">preferred</span> : null}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            title="Regenerate with the current timestamp"
            className="focus-ink inline-flex items-center gap-1.5 rounded-sm px-2 py-1 font-numeric text-[10px] uppercase tracking-[0.14em] text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
            data-testid="telemetry-refresh-timestamp"
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} /> Refresh timestamp
          </button>
          <button
            type="button"
            onClick={copy}
            className="focus-ink inline-flex items-center gap-1.5 rounded-sm px-2 py-1 font-numeric text-[10px] uppercase tracking-[0.14em] text-ink-muted transition-colors hover:text-ink"
            data-testid="telemetry-offline-copy"
          >
            {copied ? <Check className="h-3 w-3 text-sage" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>

      <p className="mt-2 text-[0.8rem] text-ink-muted">{hint}</p>

      <pre
        className="paper-flat nice-scroll mt-2 overflow-x-auto whitespace-pre-wrap break-all bg-parchment-deep/50 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed"
        data-testid="telemetry-offline-command"
      >
        {command}
      </pre>

      {fmt === "url" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <a
            href={command}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ink inline-flex items-center gap-1.5 border border-ink px-3 py-1.5 font-numeric text-[10px] uppercase tracking-[0.14em] text-ink transition-colors hover:bg-ink hover:text-parchment"
            data-testid="telemetry-open-in-browser"
          >
            <ExternalLink className="h-3 w-3" /> Open in browser
          </a>
          <span className="text-[0.8rem] text-ink-muted">
            Useful when this host itself has egress — it verifies the URL works before you copy it somewhere else.
          </span>
        </div>
      ) : null}

      <p className="mt-2 text-[0.8rem] leading-relaxed text-ink-muted">
        The timestamp shown is <span className="font-mono text-[0.75rem]">{payload.timestamp}</span> — UTC at the moment this section was
        loaded. Hit <strong>Refresh timestamp</strong> for a new one before copying. The receiver accepts any RFC 3339 timestamp; it is stored
        for diagnostics and is not what dedupe keys on.
      </p>
    </div>
  );
}
