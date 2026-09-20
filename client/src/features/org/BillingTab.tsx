// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, CreditCard, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useMe } from "@/hooks/use-me";
import Explainer from "./Explainer";
import { Hint } from "./Hint";
import {
  BILLING_STATUS_KEY,
  centsToMoney,
  changePlan,
  getBillingStatus,
  intervalWord,
  isPaidPlan,
  money,
  moneyExact,
  normalisePlan,
  openPortal,
  perInterval,
  perMonthOnAnnual,
  startCheckout,
  statusLabel,
  syncBilling,
  type BillingPlan,
  type BillingStatus,
  type Interval,
  type PaidPlan,
  type PlanDescription,
} from "./billing/api";
import { capLine, planIncludes, seatLine, PLAN_GIST } from "./billing/copy";
import { Banner, INK_BUTTON, IntervalSwitch, Meter, OUTLINE_BUTTON, QUIET_BUTTON, Row, StatementRow } from "./billing/parts";

/**
 * Org → Billing. Exists only on the hosted instance: `billing.status` answers
 * `{ hosted: false }` on a self-hosted PTD and this component renders nothing,
 * so a self-hoster never sees a paywall even if the tab is linked by accident.
 *
 * The page is one printed price list rather than a wall of cards: three columns
 * on a single sheet, the plan you are on stamped, the plan you are considering
 * marked in the margin, and one action under the sheet that says in words what
 * pressing it will cost. Every figure — prices, seat allowances, the plan list
 * itself — comes from `billing.status`, so the tab cannot disagree with Stripe.
 */
export default function BillingTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { role } = useMe();
  const [params, setParams] = useSearchParams();
  const checkout = params.get("checkout");
  const portalReturn = params.get("portal") === "return";
  const sessionId = params.get("session_id");
  const syncedOnce = useRef(false);
  /** null means "whatever the subscription is billed on". */
  const [cycle, setCycle] = useState<Interval | null>(null);
  const [picked, setPicked] = useState<BillingPlan | null>(null);

  const status = useQuery<BillingStatus>({ queryKey: BILLING_STATUS_KEY, queryFn: getBillingStatus });

  const refreshOrg = () => {
    qc.invalidateQueries({ queryKey: BILLING_STATUS_KEY });
    qc.invalidateQueries({ queryKey: ["/api/orgs/current"] });
    qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
  };

  const sync = useMutation({
    mutationFn: (id?: string) => syncBilling(id),
    onSuccess: refreshOrg,
    onError: (err: Error) => toast({ title: "Could not read the subscription", description: err.message, variant: "destructive" }),
  });

  const upgrade = useMutation({
    mutationFn: (choice: { plan: PaidPlan; interval: Interval }) => startCheckout(choice),
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
      else toast({ title: "Checkout unavailable", description: "Stripe returned no checkout URL.", variant: "destructive" });
    },
    onError: (err: Error) => toast({ title: "Could not start checkout", description: err.message, variant: "destructive" }),
  });

  const change = useMutation({
    mutationFn: (choice: { plan: PaidPlan; interval: Interval }) => changePlan(choice),
    onSuccess: (data) => {
      refreshOrg();
      toast({
        title: `Now on ${data.plan === "business" ? "Business" : "Team"}`,
        description: `Billed ${data.interval === "year" ? "yearly" : "monthly"}${
          typeof data.priceUsd === "number" ? ` at ${money(data.priceUsd)} ${intervalWord(data.interval ?? "month")}` : ""
        }. Stripe puts the difference on your next invoice.`,
      });
    },
    onError: (err: Error) => toast({ title: "Could not change the plan", description: err.message, variant: "destructive" }),
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
  const plan = normalisePlan(s.plan);
  const isOwner = role === "owner";
  const sub = s.subscription ?? null;
  const subscribed = Boolean(sub);
  const pastDue = Boolean(sub?.pastDue) || sub?.status === "past_due";
  const interval: Interval = cycle ?? s.interval ?? "month";
  // What the *cards* price (the period you are looking at) and what the
  // organization is actually billed are two different things: the seat overage and
  // the seats-in-use prose describe today's invoice, so they follow the
  // subscription, not the switch above them.
  const billedInterval: Interval = s.interval ?? "month";
  const plans = s.plans ?? [];
  const teamDesc = plans.find((p) => p.plan === "team");

  // What the buttons act on. An organization already paying starts on its own
  // plan (so the sheet shows what it has); everyone else starts on Team, which
  // is the plan the public price list recommends.
  const selected: BillingPlan = picked ?? (isPaidPlan(plan) ? plan : "team");
  const selectedDesc = plans.find((p) => p.plan === selected);
  const currentDesc = plans.find((p) => p.plan === plan);

  const limits = s.limits ?? currentDesc?.limits ?? null;
  const usage = s.usage ?? { humans: 0, agents: 0, members: 0 };
  const total = usage.total ?? usage.members;
  const humanAllowance = limits?.humanSeats ?? limits?.includedHumanSeats ?? null;
  const memberLimit = limits?.totalMembers ?? s.memberCap ?? null;
  // On Free both figures are the same three seats; one bar tells that truth better
  // than two identical ones.
  const showHumanMeter = humanAllowance !== null && humanAllowance !== memberLimit;
  const seatPrice = s.seatPrices?.[billedInterval] ?? null;
  const overage = usage.seatOverage ?? 0;
  const overageCost = usage.seatCostUsd ?? (seatPrice !== null ? overage * seatPrice : 0);
  const addons = s.addons ?? null;
  const certMetered = plan === "team";
  const basePrice = isPaidPlan(plan) && s.prices ? s.prices[plan][s.interval ?? "month"] : null;
  const selectedPrice = selectedDesc?.prices ? selectedDesc.prices[interval] : null;
  const samePlanAndInterval = selected === plan && interval === (s.interval ?? "month");

  return (
    <div className="space-y-5" data-testid="billing-tab">
      {checkout === "success" ? (
        <Banner tone="ok" testId="billing-banner-success" icon={<CheckCircle2 className="h-3.5 w-3.5" />}>
          Payment received. {sync.isPending ? "Confirming with Stripe…" : `This organization is on ${s.planLabel ?? "the hosted plan"}.`}
        </Banner>
      ) : null}
      {checkout === "cancelled" ? (
        <Banner tone="muted" testId="billing-banner-cancelled">
          Checkout cancelled — nothing was charged. The organization stays on {s.planLabel ?? "its current plan"}.
        </Banner>
      ) : null}
      {portalReturn ? (
        <Banner tone="muted" testId="billing-banner-portal">
          Back from Stripe. Anything you changed there is read below; press refresh if it has not landed yet.
        </Banner>
      ) : null}
      {pastDue ? (
        <Banner tone="warn" testId="billing-banner-past-due" icon={<AlertTriangle className="h-3.5 w-3.5" />}>
          The last payment failed. Access continues while Stripe retries — update the card in Manage billing.
        </Banner>
      ) : null}
      {s.configured === false ? (
        <Banner tone="warn" testId="billing-banner-unconfigured" icon={<AlertTriangle className="h-3.5 w-3.5" />}>
          Stripe is not fully configured on this deployment, so checkout will refuse. Set <code className="font-mono text-[11.5px]">STRIPE_SECRET_KEY</code> and all
          four plan prices: <code className="font-mono text-[11.5px]">STRIPE_PRICE_TEAM_MONTHLY</code>, <code className="font-mono text-[11.5px]">STRIPE_PRICE_TEAM_YEARLY</code>,{" "}
          <code className="font-mono text-[11.5px]">STRIPE_PRICE_BUSINESS_MONTHLY</code>, <code className="font-mono text-[11.5px]">STRIPE_PRICE_BUSINESS_YEARLY</code>.
        </Banner>
      ) : null}

      <Explainer
        testId="billing-explainer"
        why={
          <>
            One flat price per organization, and agent seats are free — they pay their own API bill, so charging for their chair
            as well would be charging twice. Team is {money(s.prices?.team.month ?? 15)} a month and covers up to{" "}
            {teamDesc?.limits.humanSeats ?? 10} people. Business is {money(s.prices?.business.month ?? 49)} and covers{" "}
            {plans.find((p) => p.plan === "business")?.limits.includedHumanSeats ?? 50} before a seat costs anything, for the
            organizations that have to hand their numbers to somebody else. Paying yearly gives you two months free. Free covers
            three seats so you can run a real project first, and self-hosting stays free for ever with no seat limit at all. Only
            the owner can start, change or cancel the subscription.
          </>
        }
        technical={
          <>
            <li>
              Hosted only: <code>billing.status</code> answers <code>{"{ hosted: false }"}</code> on a self-hosted install and
              this tab renders nothing at all — a self-hoster never meets a paywall.
            </li>
            <li>
              Every figure on this page is served by <code>billing.status</code> — the price list, the seat allowances and the
              plans themselves. The client holds no copy of the prices to drift out of date.
            </li>
            <li>
              Seats are counted twice over, for two different reasons. <strong>Human</strong> seats are what a plan allows: Free
              3, Team {teamDesc?.limits.humanSeats ?? 10}, Business {plans.find((p) => p.plan === "business")?.limits.includedHumanSeats ?? 50}{" "}
              included and {seatPrice !== null ? money(seatPrice) : "$2"} {intervalWord(billedInterval)} each after that. The{" "}
              <strong>member cap</strong> ({memberLimit ?? 100}) counts humans and agents together and is a hard ceiling — past
              it a hosted organization wants hosting of its own.
            </li>
            <li>
              Buying goes through <code>billing.checkout</code> (Stripe Checkout, where promotion codes are typed); moving
              between plans or intervals afterwards goes through <code>billing.change_plan</code>, which edits the subscription
              in place and lets Stripe prorate. “Manage billing” is Stripe's own portal for the card, invoices and cancellation.
            </li>
            <li>
              Metered add-ons ride on the same subscription: one certified invoice is{" "}
              {s.certInvoiceUsd ? money(s.certInvoiceUsd) : "$1"} on Team and included on Business, and PTD-provided AI is
              metered in whole cents at cost plus {Math.round(((s.aiMarkup ?? 1.2) - 1) * 100)}%. With your own provider key
              nothing is metered.
            </li>
            <li>The plan flips when Stripe's webhook arrives; the success redirect often beats it, so “refresh” re-reads the subscription directly.</li>
            <li>Cancelling keeps access to the end of the period already paid for, then drops the organization back to Free.</li>
          </>
        }
      />

      <section className="paper" data-testid="billing-plan">
        <div className="flex flex-wrap items-end justify-between gap-4 px-4 pt-4 pb-3">
          <div className="min-w-0">
            <div className="eyebrow text-[9px]">what it costs</div>
            <h3 className="font-display text-2xl tracking-tight mt-0.5">
              Hosted plans <span className="italic text-ink-muted">— one price per organization</span>
            </h3>
            <p className="text-sm font-serif text-ink-muted mt-1.5 max-w-prose">
              This organization is on <span className="text-ink">{s.planLabel ?? currentDesc?.label ?? "Free"}</span>
              {basePrice !== null ? (
                <>
                  , {money(basePrice)} {intervalWord(s.interval ?? "month")}
                </>
              ) : null}
              . Agent seats are free — they pay their own API bill.
            </p>
          </div>
          <IntervalSwitch value={interval} onChange={setCycle} />
        </div>

        <div className="grid gap-px border-y border-rule bg-rule lg:grid-cols-3">
          {plans.map((desc) => (
            <PlanColumn
              key={desc.plan}
              desc={desc}
              base={desc.plan === "business" ? teamDesc : undefined}
              interval={interval}
              current={desc.plan === plan}
              currentInterval={desc.plan === plan ? s.interval ?? null : null}
              selected={desc.plan === selected}
              onSelect={() => setPicked(desc.plan)}
            />
          ))}
        </div>

        <div className="px-4 py-3 flex flex-wrap items-center gap-2" data-testid="billing-actions">
          {isOwner && selected === "free" ? (
            <p className="text-sm font-serif italic text-ink-muted" data-testid="billing-free-note">
              {subscribed
                ? "To go back to Free, cancel in Manage billing — access runs to the end of the period you have paid for."
                : "Free costs nothing and needs no card. Pick Team or Business to buy one."}
            </p>
          ) : null}

          {isOwner && isPaidPlan(selected) && !subscribed ? (
            <Hint text="Takes you to Stripe Checkout with this plan and period. Nothing is charged until you confirm there, and you come back to this page either way.">
              <button
                type="button"
                onClick={() => upgrade.mutate({ plan: selected, interval })}
                disabled={upgrade.isPending}
                className={INK_BUTTON}
                data-testid="billing-upgrade"
              >
                {upgrade.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CreditCard className="h-3.5 w-3.5" />}
                <span className="eyebrow text-[10px] !text-current">
                  upgrade to {selectedDesc?.label ?? selected}
                  {selectedPrice !== null ? ` — ${money(selectedPrice)} ${intervalWord(interval)}` : ""}
                </span>
              </button>
            </Hint>
          ) : null}

          {isOwner && isPaidPlan(selected) && subscribed ? (
            <>
              <Hint text="Moves the subscription you already have onto this plan and period. Stripe prorates the difference onto your next invoice; the card is not asked for again.">
                <button
                  type="button"
                  onClick={() => change.mutate({ plan: selected, interval })}
                  disabled={change.isPending || samePlanAndInterval}
                  className={INK_BUTTON}
                  data-testid="billing-change-plan"
                >
                  {change.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5" />}
                  <span className="eyebrow text-[10px] !text-current">
                    change to {selectedDesc?.label ?? selected}
                    {selectedPrice !== null ? ` — ${money(selectedPrice)} ${intervalWord(interval)}` : ""}
                  </span>
                </button>
              </Hint>
              {samePlanAndInterval ? (
                <span className="text-sm font-serif italic text-ink-muted" data-testid="billing-change-idle">
                  Already on {currentDesc?.label ?? s.planLabel}, billed {(s.interval ?? "month") === "year" ? "yearly" : "monthly"} — choose another plan or period to change it.
                </span>
              ) : null}
            </>
          ) : null}

          {isOwner && s.portalAvailable ? (
            <Hint text="Opens Stripe's own portal in place of this page: change the card, download invoices, or cancel at the end of the period.">
              <button
                type="button"
                onClick={() => portal.mutate()}
                disabled={portal.isPending}
                className={OUTLINE_BUTTON}
                data-testid="billing-portal"
              >
                {portal.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                <span className="eyebrow text-[10px] !text-current">manage billing</span>
              </button>
            </Hint>
          ) : null}

          {isOwner ? (
            <Hint text="Re-reads the subscription straight from Stripe. Useful when a payment has gone through but this page has not caught up yet.">
              <button
                type="button"
                onClick={() => sync.mutate(undefined)}
                disabled={sync.isPending}
                className={QUIET_BUTTON}
                data-testid="billing-sync"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", sync.isPending && "animate-spin")} />
                <span className="eyebrow text-[9px] !text-current">refresh</span>
              </button>
            </Hint>
          ) : null}

          {!isOwner ? <p className="text-sm font-serif italic text-ink-muted">Only the owner can change the subscription.</p> : null}
        </div>

        {s.foundingCode ? (
          <p className="px-4 pb-4 text-[13px] font-serif text-ink-muted" data-testid="billing-founding">
            Founding members: 40% off for the first 100 organizations. Type{" "}
            <code className="font-mono text-[11.5px] text-ink">{s.foundingCode}</code> in the promotion-code field at Checkout.
          </p>
        ) : null}
      </section>

      <section className="paper-flat" data-testid="billing-usage">
        <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
          <span className="microcaps">Seats in use</span>
          <span className="eyebrow text-[9px] font-numeric">
            {total} member{total === 1 ? "" : "s"}
          </span>
        </div>
        <div className="p-3 space-y-4">
          {showHumanMeter ? (
            <Meter
              testId="billing-meter-humans"
              label="humans"
              value={usage.humans}
              limit={humanAllowance}
              over={limits?.billableSeats ? false : undefined}
              note={
                limits?.billableSeats ? (
                  <>
                    {humanAllowance} human seats are included; past that each one is {seatPrice !== null ? money(seatPrice) : "$2"}{" "}
                    {intervalWord(billedInterval)} and is billed, not refused.
                  </>
                ) : usage.humans >= (humanAllowance ?? 0) ? (
                  <>The human seats on {currentDesc?.label ?? s.planLabel} are full — the next invitation is refused. Business includes 50.</>
                ) : (
                  <>
                    {(humanAllowance ?? 0) - usage.humans} human seat{(humanAllowance ?? 0) - usage.humans === 1 ? "" : "s"} left. Agents do not
                    use them.
                  </>
                )
              }
            />
          ) : null}

          <Meter
            testId="billing-meter-members"
            label="members, humans and agents"
            value={total}
            limit={memberLimit}
            note={
              plan === "free" ? (
                <>
                  Humans and agents share these {memberLimit ?? 3} seats. At the limit the next invitation — or the next agent
                  registration — is refused with a plan error rather than billed.
                </>
              ) : (
                <>A hosted organization is capped at {memberLimit ?? 100} members. Past that we host it differently — talk to us.</>
              )
            }
          />

          <p className="text-sm font-serif rule-t pt-2.5">
            <span className="font-numeric">{usage.humans}</span> human{usage.humans === 1 ? "" : "s"}
            <span className="mx-2 text-ink-muted">·</span>
            <span className="font-numeric">{usage.agents}</span> agent{usage.agents === 1 ? "" : "s"}
            <span className="mx-2 text-ink-muted">·</span>
            <span className="font-numeric">{total}</span> member{total === 1 ? "" : "s"} in all
          </p>

          {overage > 0 ? (
            <p className="text-sm font-serif text-vermilion" data-testid="billing-overage">
              {overage} human seat{overage === 1 ? "" : "s"} past the {limits?.includedHumanSeats ?? 50} included
              {seatPrice !== null ? ` × ${money(seatPrice)}` : ""} = <span className="font-numeric">{moneyExact(overageCost)}</span>{" "}
              {intervalWord(billedInterval)}, on top of the flat {basePrice !== null ? money(basePrice) : money(s.prices?.business.month ?? 49)}.
            </p>
          ) : null}
        </div>
      </section>

      {addons ? (
        <section className="paper-flat" data-testid="billing-addons">
          <div className="px-3 py-2 border-b border-rule flex items-center justify-between gap-3">
            <span className="microcaps">Add-ons this period</span>
            <span className="eyebrow text-[9px] font-numeric" data-testid="billing-addons-since">
              since {safeDate(addons.since)}
            </span>
          </div>
          <div className="divide-y divide-rule">
            <StatementRow
              testId="billing-addon-invoices"
              label="Certified invoices"
              detail={
                certMetered
                  ? `${addons.certifiedInvoices} × ${money(s.certInvoiceUsd ?? 1)}`
                  : plan === "business"
                    ? `${addons.certifiedInvoices} issued`
                    : "Free cannot issue one"
              }
              amount={certMetered ? moneyExact(addons.certifiedInvoicesUsd) : plan === "business" ? "included" : "—"}
            />
            <StatementRow
              testId="billing-addon-ai"
              label="PTD-provided AI"
              detail={`${addons.aiCalls} call${addons.aiCalls === 1 ? "" : "s"} · cost + ${Math.round(((s.aiMarkup ?? 1.2) - 1) * 100)}%`}
              amount={centsToMoney(addons.aiCents)}
            />
          </div>
          <p className="px-3 py-2.5 rule-t text-[13px] font-serif text-ink-muted">
            Business includes certified invoices and their verifiable links; on Team each one is {money(s.certInvoiceUsd ?? 1)} and Free
            cannot issue them at all. AI is metered only when the organization uses PTD's key — with your own provider key nothing here is
            metered and the provider bills you directly.
          </p>
        </section>
      ) : null}

      {sub ? (
        <section className="paper-flat" data-testid="billing-subscription">
          <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
            <span className="microcaps">Subscription</span>
            <span className={cn("stamp", pastDue ? "border-vermilion text-vermilion" : "border-rule")} data-testid="billing-sub-status">
              {statusLabel(sub.status)}
            </span>
          </div>
          <dl className="divide-y divide-rule">
            <Row label="plan">
              {s.planLabel ?? currentDesc?.label ?? "—"}
              {basePrice !== null ? `, ${money(basePrice)} ${intervalWord(s.interval ?? "month")}` : ""}
            </Row>
            {sub.seatQuantity ? (
              <Row label="seats billed">
                {sub.seatQuantity} human seat{sub.seatQuantity === 1 ? "" : "s"} past what the plan includes
                {seatPrice !== null ? `, at ${money(seatPrice)} ${intervalWord(s.interval ?? "month")} each` : ""}
              </Row>
            ) : null}
            {sub.items && (sub.items.cert || sub.items.ai) ? (
              <Row label="meters">
                {[sub.items.cert ? "certified invoices" : null, sub.items.ai ? "AI usage" : null].filter(Boolean).join(" · ")} — charged as used
              </Row>
            ) : null}
            <Row label={sub.cancelAtPeriodEnd ? "access until" : "renews"}>
              {sub.currentPeriodEnd ? safeDate(sub.currentPeriodEnd) : "—"}
            </Row>
            {sub.cancelAtPeriodEnd ? (
              <Row label="cancellation">Scheduled — the plan drops to Free at the end of this period.</Row>
            ) : null}
          </dl>
        </section>
      ) : null}

      {s.warning ? (
        <p className="text-[11px] font-mono text-ink-muted" data-testid="billing-warning">Stripe read failed: {s.warning}</p>
      ) : null}

      <p className="text-sm font-serif italic text-ink-muted" data-testid="billing-selfhost-note">
        Self-hosting PTD stays free for ever, with no seat limit — this page only exists on the hosted instance.
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────── one plan column */

/**
 * A column of the price list. The whole column is the control — a radio, so a
 * keyboard reaches it — because "choose Business" and "read what Business is"
 * are the same gesture on a price list.
 */
function PlanColumn({
  desc, base, interval, current, currentInterval, selected, onSelect,
}: {
  desc: PlanDescription;
  base?: PlanDescription;
  interval: Interval;
  current: boolean;
  currentInterval: Interval | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const price = desc.prices ? desc.prices[interval] : 0;
  const lines = planIncludes(desc, base);
  const cap = capLine(desc);

  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "min-w-0 cursor-pointer bg-card p-4 transition-colors focus-ink",
        selected ? "border-l-2 border-l-vermilion bg-parchment-deep/30" : "border-l-2 border-l-transparent hover:bg-parchment-deep/20",
      )}
      data-testid={`billing-plan-${desc.plan}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="font-display text-[1.3rem] tracking-tight">{desc.label}</h4>
        {current ? <span className="stamp stamp-strong" data-testid={`billing-current-${desc.plan}`}>current</span> : null}
        {selected && !current ? <span className="eyebrow text-[9px]">chosen</span> : null}
      </div>

      <p className="font-display text-[2.1rem] leading-none tracking-tight mt-2.5">
        {desc.prices ? money(price) : "$0"}
        <span className="font-numeric text-[11px] uppercase tracking-[0.12em] text-ink-muted ml-1.5 align-middle">
          {desc.prices ? perInterval(interval) : "for ever"}
        </span>
      </p>
      <p className="font-numeric text-[10px] leading-relaxed text-ink-muted mt-1.5">
        {desc.prices
          ? interval === "year"
            ? `${money(perMonthOnAnnual(desc.prices))} a month — two months free`
            : "flat, not per seat"
          : "one organization"}
      </p>

      <p className="text-[13px] font-serif mt-3">{seatLine(desc, interval)}</p>
      {cap ? <p className="font-numeric text-[10px] text-ink-muted mt-1">{cap}</p> : null}
      {current && currentInterval && currentInterval !== interval ? (
        <p className="font-numeric text-[10px] text-vermilion mt-1">
          billed {currentInterval === "year" ? "yearly" : "monthly"} right now
        </p>
      ) : null}

      <p className="text-sm font-serif text-ink-muted mt-3 max-w-prose">{PLAN_GIST[desc.plan] ?? ""}</p>

      <ul className="mt-3 divide-y divide-rule border-y border-rule">
        {lines.map((line) => (
          <li
            key={line.text}
            className={cn("py-2 text-[0.9rem] leading-snug", line.absent ? "text-ink-muted italic" : "text-ink")}
          >
            {line.absent ? <span className="text-ink-muted mr-1.5">—</span> : null}
            {line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Dates arrive from Stripe and can be null or nonsense; never throw over one. */
function safeDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : format(d, "d MMM yyyy");
}
