// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, X } from "lucide-react";
import { useMe } from "@/hooks/use-me";
import { TELEMETRY_KEY, getTelemetry, setTelemetryPreferences, type TelemetryView } from "./api";

/**
 * The first-run prompt: one line, once, for the owner of a fresh installation.
 *
 * It exists because "off by default" and "never mentioned" are not the same
 * thing — an opt-in nobody is told about is just a feature nobody uses. So the
 * question is asked exactly once and then never again: answering either toggle,
 * or dismissing this, records `decidedAt` on the install record and the banner
 * is gone for good.
 *
 * Nothing is sent by rendering this. The banner is a link to the section, not a
 * consent dialog with a pre-ticked box.
 */
export default function TelemetryFirstRunBanner() {
  const { role } = useMe();
  const qc = useQueryClient();
  const [hidden, setHidden] = useState(false);

  // Owner-only, and the query is owner-gated server-side too: an admin would get
  // a 403, so it is not even attempted for them.
  const isOwner = role === "owner";
  const view = useQuery<TelemetryView>({ queryKey: TELEMETRY_KEY, queryFn: getTelemetry, enabled: isOwner });

  const dismiss = useMutation({
    mutationFn: () => setTelemetryPreferences({ dismissed: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: TELEMETRY_KEY }),
  });

  if (!isOwner || hidden || !view.data || view.data.status.decided) return null;

  return (
    <div
      className="paper-flat flex flex-wrap items-center gap-x-3 gap-y-1.5 border-l-2 border-l-vermilion/70 bg-parchment-deep/40 px-3 py-2"
      data-testid="telemetry-first-run"
    >
      <BarChart3 className="h-3.5 w-3.5 shrink-0 text-vermilion" />
      <p className="font-serif text-[13.5px] leading-relaxed">
        Help count PTD installs — opt in to a weekly anonymous ping.{" "}
        <Link
          to="/org/data"
          className="focus-ink text-vermilion underline decoration-rule underline-offset-2"
          data-testid="telemetry-first-run-link"
        >
          See exactly what it sends
        </Link>
        .
      </p>
      <button
        type="button"
        onClick={() => {
          setHidden(true);
          dismiss.mutate();
        }}
        aria-label="Dismiss"
        className="focus-ink ml-auto rounded-sm p-1 text-ink-muted transition-colors hover:text-ink"
        data-testid="telemetry-first-run-dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
