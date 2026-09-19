// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, CheckCircle2, CreditCard, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useMe } from "@/hooks/use-me";
import {
  BILLING_STATUS_KEY, getBillingStatus, openPortal, startCheckout, statusLabel, syncBilling,
  type BillingStatus,
} from "./billing/api";

const PRICE_NOTE = "One flat price per organization — every human and every agent seat included.";

/**
 * Org → Billing. Exists only on the hosted instance: `billing.status` answers
 * `{ hosted: false }` on a self-hosted PTD and this component renders nothing,
 * so a self-hoster never sees a paywall even if the tab is linked by accident.
 */
export default function BillingTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { role } = useMe();
  const [params, setParams] = useSearchParams();
  const checkout = params.get("checkout");
  const sessionId = params.get("session_id");
  const syncedOnce = useRef(false);

  const status = useQuery<BillingStatus>({ queryKey: BILLING_STATUS_KEY, queryFn: getBillingStatus });

  const sync = useMutation({
    mutationFn: (id?: string) => syncBilling(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BILLING_STATUS_KEY });
      qc.invalidateQueries({ queryKey: ["/api/orgs/current"] });
      qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
    onError: (err: Error) => toast({ title: "Could not read the subscription", description: err.message, variant: "destructive" }),
  });

  const upgrade = useMutation({
    mutationFn: startCheckout,
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
      else toast({ title: "Checkout unavailable", description: "Stripe returned no checkout URL.", variant: "destructive" });
    },
    onError: (err: Error) => toast({ title: "Could not start checkout", description: err.message, variant: "destructive" }),
  });

  const portal = useMutation({
    mutationFn: openPortal,
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
      else toast({ title: "Portal unavailable", description: "Stripe returned no portal URL.", variant: "destructive" });
    },
    onError: (err: Error) => toast({ title: "Could not open the billing portal", description: err.message, variant: "destructive" }),
  });

  // The success redirect beats Stripe's webhook often enough that the tab reads
  // the subscription itself once, then drops the query string.
  useEffect(() => {
    if (checkout !== "success" || syncedOnce.current || !status.data?.hosted) return;
    syncedOnce.current = true;
    sync.mutate(sessionId ?? undefined);
    const next = new URLSearchParams(params);
    next.delete("session_id");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout, sessionId, status.data?.hosted]);

  if (status.isLoading) {
    return (
      <div className="py-10 text-center" data-testid="billing-loading">
        <Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" />
      </div>
    );
  }
  // Self-hosted, or the caller cannot see billing at all: render nothing.
  if (!status.data?.hosted) return null;

  const s = status.data;
  const plan = s.plan ?? "free";
  const isPaid = plan === "hosted";
  const limit = s.limits?.members ?? null;
  const used = s.usage?.members ?? 0;
  const atLimit = limit !== null && used >= limit;
  const isOwner = role === "owner";
  const sub = s.subscription ?? null;
  const pastDue = sub?.pastDue || sub?.status === "past_due";

  return (
    <div className="space-y-5" data-testid="billing-tab">
      {checkout === "success" ? (
        <Banner tone="ok" testId="billing-banner-success" icon={<CheckCircle2 className="h-3.5 w-3.5" />}>
          Payment received. {sync.isPending ? "Confirming with Stripe…" : "This organization is on the hosted plan."}
        </Banner>
      ) : null}
      {checkout === "cancelled" ? (
        <Banner tone="muted" testId="billing-banner-cancelled">
          Checkout cancelled — nothing was charged. The organization stays on the free plan.
        </Banner>
      ) : null}
      {pastDue ? (
        <Banner tone="warn" testId="billing-banner-past-due" icon={<AlertTriangle className="h-3.5 w-3.5" />}>
          The last payment failed. Access continues while Stripe retries — update the card in Manage billing.
        </Banner>
      ) : null}
      {s.configured === false ? (
        <Banner tone="warn" testId="billing-banner-unconfigured" icon={<AlertTriangle className="h-3.5 w-3.5" />}>
          Stripe keys are missing on this deployment, so checkout will refuse. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID.
        </Banner>
      ) : null}

      <section className="paper p-4" data-testid="billing-plan">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="eyebrow text-[9px]">current plan</div>
            <h3 className="font-display text-2xl tracking-tight mt-0.5">
              {isPaid ? <>Hosted <span className="italic">— the whole ledger</span></> : <>Free <span className="italic">— three seats</span></>}
            </h3>
            <p className="text-sm font-serif text-ink-muted mt-1.5 max-w-prose">{PRICE_NOTE}</p>
          </div>
          <div className="text-right shrink-0">
            <div className="eyebrow text-[9px]">price</div>
            <div className="font-display text-3xl tracking-tight leading-none mt-0.5">
              ${s.priceUsd ?? 15}
              <span className="font-numeric text-sm text-ink-muted"> / {s.interval ?? "month"}</span>
            </div>
            <div className="eyebrow text-[9px] mt-1">per organization, flat</div>
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-rule flex flex-wrap items-center gap-2">
          {isOwner && !isPaid ? (
            <button
              type="button"
              onClick={() => upgrade.mutate()}
              disabled={upgrade.isPending}
              className="inline-flex items-center justify-center gap-2 px-4 h-[38px] border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
              data-testid="billing-upgrade"
            >
              {upgrade.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CreditCard className="h-3.5 w-3.5" />}
              <span className="eyebrow text-[10px] !text-current">upgrade — $15/month</span>
            </button>
          ) : null}

          {isOwner && s.portalAvailable ? (
            <button
              type="button"
              onClick={() => portal.mutate()}
              disabled={portal.isPending}
              className="inline-flex items-center justify-center gap-2 px-4 h-[38px] border border-ink/40 hover:border-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
              data-testid="billing-portal"
            >
              {portal.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
              <span className="eyebrow text-[10px] !text-current">manage billing</span>
            </button>
          ) : null}

          {isOwner ? (
            <button
              type="button"
              onClick={() => sync.mutate(undefined)}
              disabled={sync.isPending}
              className="inline-flex items-center gap-1.5 px-2 h-[38px] text-ink-muted hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
              data-testid="billing-sync"
              title="Re-read the subscription from Stripe"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", sync.isPending && "animate-spin")} />
              <span className="eyebrow text-[9px] !text-current">refresh</span>
            </button>
          ) : null}

          {!isOwner ? <p className="text-sm font-serif italic text-ink-muted">Only the owner can change the subscription.</p> : null}
        </div>
      </section>

      <section className="paper-flat" data-testid="billing-usage">
        <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
          <span className="microcaps">Seats in use</span>
          <span className="eyebrow text-[9px] font-numeric">
            {used}
            {limit !== null ? ` / ${limit}` : " · unlimited"}
          </span>
        </div>
        <div className="p-3 space-y-2">
          {limit !== null ? (
            <div className="h-1.5 bg-parchment-deep rounded-sm overflow-hidden" role="presentation">
              <div
                className={cn("h-full transition-[width]", atLimit ? "bg-vermilion" : "bg-ink")}
                style={{ width: `${Math.min(100, Math.round((used / Math.max(1, limit)) * 100))}%` }}
              />
            </div>
          ) : null}
          <p className="text-sm font-serif">
            {s.usage?.humans ?? Math.max(0, used - (s.usage?.agents ?? 0))} human{(s.usage?.humans ?? 0) === 1 ? "" : "s"}
            <span className="mx-2">·</span>
            {s.usage?.agents ?? 0} agent{(s.usage?.agents ?? 0) === 1 ? "" : "s"}
            {limit !== null ? (
              <>
                <span className="mx-2">·</span>
                <span className={cn(atLimit && "text-vermilion")}>
                  {atLimit ? "free limit reached — the next seat needs the hosted plan" : `${limit - used} seat${limit - used === 1 ? "" : "s"} left on free`}
                </span>
              </>
            ) : null}
          </p>
        </div>
      </section>

      {sub ? (
        <section className="paper-flat" data-testid="billing-subscription">
          <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
            <span className="microcaps">Subscription</span>
            <span className={cn("stamp", pastDue ? "border-vermilion text-vermilion" : "border-rule")} data-testid="billing-sub-status">
              {statusLabel(sub.status)}
            </span>
          </div>
          <dl className="divide-y divide-rule">
            <Row label={sub.cancelAtPeriodEnd ? "access until" : "renews"}>
              {sub.currentPeriodEnd ? format(new Date(sub.currentPeriodEnd), "d MMM yyyy") : "—"}
            </Row>
            {sub.cancelAtPeriodEnd ? (
              <Row label="cancellation">Scheduled — the plan drops to free at the end of this period.</Row>
            ) : null}
          </dl>
        </section>
      ) : null}

      {s.warning ? (
        <p className="text-[11px] font-mono text-ink-muted" data-testid="billing-warning">Stripe read failed: {s.warning}</p>
      ) : null}

      <p className="text-sm font-serif italic text-ink-muted">
        Self-hosting PTD stays free forever, with no seat limit — this page only exists on the hosted instance.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2 grid grid-cols-[110px_1fr] gap-3">
      <dt className="eyebrow text-[9px] pt-0.5">{label}</dt>
      <dd className="text-sm font-serif">{children}</dd>
    </div>
  );
}

function Banner({
  tone, children, icon, testId,
}: {
  tone: "ok" | "warn" | "muted";
  children: React.ReactNode;
  icon?: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className={cn(
        "paper-flat px-3 py-2.5 flex items-start gap-2 text-sm font-serif",
        tone === "ok" && "border-l-2 border-l-ink",
        tone === "warn" && "border-l-2 border-l-vermilion text-vermilion",
        tone === "muted" && "border-l-2 border-l-rule text-ink-muted",
      )}
      data-testid={testId}
      role="status"
    >
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <span>{children}</span>
    </div>
  );
}
