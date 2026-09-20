import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Link2Off, Loader2, PlugZap, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import Explainer from "../Explainer";
import { Hint } from "../Hint";
import {
  connectProvider,
  disconnectProvider,
  lastMonth,
  listProviders,
  listReconciliations,
  PROVIDER_HINT,
  PROVIDER_LABEL,
  reconcile,
  STATUS_CHIP,
  STATUS_LABEL,
  type ProviderView,
  type ReconciliationRow,
  type UsageProvider,
} from "./api";

/**
 * Verified usage, the strongest form: the provider's own billing against the
 * ledger.
 *
 * The admin key is what makes this evidence rather than another self-report, so
 * two things are deliberate here. It is sealed on the server and never returned
 * — this card only ever shows the last four characters — and connecting one is
 * admin-only, which means the agents being measured cannot reach the credential
 * doing the measuring.
 *
 * The verdict is coarse on purpose. A provider bill covers keys PTD never sees
 * (somebody's laptop, another product) and PTD's ledger may cover a provider
 * this reconciliation did not query, so `under_reported` is a prompt to look
 * rather than a finding. Every row carries that caveat with it.
 */

const fmtTokens = (n: number | null | undefined) => (typeof n === "number" ? n.toLocaleString("en-GB") : "—");
const fmtUsd = (n: number | null | undefined) => (typeof n === "number" ? `$${n.toFixed(2)}` : "—");
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function ConnectRow({ view, onConnected }: { view: ProviderView; onConnected: () => void }) {
  const { toast } = useToast();
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [open, setOpen] = useState(false);

  const connect = useMutation({
    mutationFn: () => connectProvider({ provider: view.provider, adminApiKey: key.trim(), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) }),
    onSuccess: (result) => {
      setKey("");
      setOpen(false);
      onConnected();
      toast({ title: `${PROVIDER_LABEL[view.provider]} connected`, description: `Key ${result.keyHint} sealed. PTD can now read this organization's usage and cost reports.` });
    },
    onError: (err: Error) => toast({ title: "Could not connect", description: err.message, variant: "destructive" }),
  });

  const forget = useMutation({
    mutationFn: () => disconnectProvider(view.provider),
    onSuccess: () => {
      onConnected();
      toast({ title: `${PROVIDER_LABEL[view.provider]} disconnected`, description: "Past reconciliations are kept — they are evidence. No new one can run until a key is connected again." });
    },
    onError: (err: Error) => toast({ title: "Could not disconnect", description: err.message, variant: "destructive" }),
  });

  return (
    <li className="px-3 py-2.5" data-testid={`provider-${view.provider}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="font-serif">{PROVIDER_LABEL[view.provider]}</span>
          {view.connected ? (
            <span className="stamp border-sage/60 font-mono normal-case tracking-normal text-sage">{view.keyHint}</span>
          ) : (
            <span className="eyebrow text-[9px]">not connected</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {view.connected ? (
            <>
              <span className="eyebrow text-[9px]">{view.connectedAt ? `since ${fmtDay(view.connectedAt)}` : ""}</span>
              <Hint side="left" text="Forgets the stored key. Reconciliations already recorded are kept.">
                <button
                  onClick={() => forget.mutate()}
                  disabled={forget.isPending}
                  className="inline-flex items-center gap-1.5 rounded-sm border border-rule px-2 py-1 text-ink-muted transition-colors hover:text-vermilion focus-ink disabled:opacity-60"
                  data-testid={`disconnect-${view.provider}`}
                >
                  {forget.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2Off className="h-3 w-3" />}
                  <span className="eyebrow text-[9px] !text-current">forget</span>
                </button>
              </Hint>
            </>
          ) : null}
          <button
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 rounded-sm border border-ink/60 px-2 py-1 transition-colors hover:bg-ink hover:text-parchment focus-ink"
            data-testid={`connect-${view.provider}`}
          >
            <PlugZap className="h-3 w-3" />
            <span className="eyebrow text-[9px] !text-current">{view.connected ? "replace key" : "connect"}</span>
          </button>
        </span>
      </div>

      {view.baseUrl ? <p className="eyebrow mt-1 text-[9px]">reading {view.baseUrl}</p> : null}

      {open ? (
        <div className="mt-2 space-y-2">
          <p className="max-w-prose font-serif text-xs italic text-ink-muted">{PROVIDER_HINT[view.provider]}</p>
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
            <label className="block">
              <span className="eyebrow text-[9px]">admin key — sealed on arrival, never shown again</span>
              <input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                type="password"
                spellCheck={false}
                autoComplete="off"
                placeholder={view.provider === "anthropic" ? "sk-ant-admin01-…" : "sk-…"}
                className="draft-input mt-1 w-full font-mono text-sm focus-ink"
                data-testid={`key-${view.provider}`}
              />
            </label>
            <label className="block">
              <span className="eyebrow text-[9px]">base URL — only for a proxy</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                spellCheck={false}
                placeholder={view.provider === "anthropic" ? "api.anthropic.com" : "api.openai.com"}
                className="draft-input mt-1 w-full font-mono text-sm focus-ink"
                data-testid={`base-url-${view.provider}`}
              />
            </label>
          </div>
          <button
            onClick={() => connect.mutate()}
            disabled={connect.isPending || key.trim().length < 8}
            className="inline-flex items-center gap-2 rounded-sm border border-ink bg-ink px-3 py-1.5 text-parchment transition-colors hover:bg-parchment hover:text-ink focus-ink disabled:opacity-60"
            data-testid={`save-key-${view.provider}`}
          >
            {connect.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            <span className="eyebrow text-[10px] !text-current">seal and store</span>
          </button>
        </div>
      ) : null}
    </li>
  );
}

function HistoryRow({ row }: { row: ReconciliationRow }) {
  const delta = row.detail?.deltaTokens ?? row.providerTokens - row.reportedTokens;
  return (
    <li className="px-3 py-2.5" data-testid={`reconciliation-${row.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="eyebrow text-[9px]">{PROVIDER_LABEL[row.provider]}</span>
          <span className="font-serif text-sm">
            {fmtDay(row.periodStart)} – {fmtDay(row.periodEnd)}
          </span>
        </span>
        <span className={cn("stamp shrink-0", STATUS_CHIP[row.status])}>{STATUS_LABEL[row.status]}</span>
      </div>
      <div className="eyebrow font-numeric mt-1 text-[9px] tabular-nums">
        provider {fmtTokens(row.providerTokens)} tok · {row.detail?.providerCostAvailable === false ? "cost unavailable" : fmtUsd(row.providerCostUsd)}
        <span className="mx-1.5">vs</span>
        ledger {fmtTokens(row.reportedTokens)} tok · {fmtUsd(row.reportedCostUsd)}
      </div>
      <div className="eyebrow font-numeric mt-0.5 text-[9px] tabular-nums">
        gap {delta > 0 ? "+" : ""}
        {fmtTokens(delta)} tok
        {typeof row.detail?.deltaPct === "number" ? ` · ${row.detail.deltaPct}%` : ""}
        {typeof row.detail?.allowanceTokens === "number" ? ` · tolerance ±${fmtTokens(row.detail.allowanceTokens)}` : ""}
        {typeof row.detail?.coveragePct === "number" ? ` · ${row.detail.coveragePct}% of sessions attested` : ""}
      </div>
      {row.detail?.providerError ? <p className="mt-1 font-serif text-xs italic text-vermilion">{row.detail.providerError}</p> : null}
      {row.detail?.note ? <p className="mt-1 max-w-prose font-serif text-xs italic text-ink-muted">{row.detail.note}</p> : null}
    </li>
  );
}

export default function ProviderCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const period = lastMonth();
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const [provider, setProvider] = useState<UsageProvider>("anthropic");

  const providers = useQuery({ queryKey: ["/api/actions/usage.providers"], queryFn: listProviders, retry: false });
  const history = useQuery({ queryKey: ["/api/actions/usage.reconciliations"], queryFn: () => listReconciliations(20), retry: false });

  const run = useMutation({
    mutationFn: () => reconcile({ provider, from, to }),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["/api/actions/usage.reconciliations"] });
      toast({
        title: `${PROVIDER_LABEL[row.provider]}: ${STATUS_LABEL[row.status]}`,
        description: row.detail?.note ?? "",
        variant: row.status === "under_reported" ? "destructive" : undefined,
      });
    },
    onError: (err: Error) => toast({ title: "Reconciliation failed", description: err.message, variant: "destructive" }),
  });

  const connected = (providers.data ?? []).filter((p) => p.connected);
  const rows = history.data ?? [];

  return (
    <section className="space-y-3" data-testid="verified-usage-card">
      <Explainer
        testId="verified-usage-explainer"
        why={
          <>
            An agent reporting its own token count is a promise, not a fact. PTD keeps the promise and the fact in separate
            columns: what the seat said, and what something else measured — the Claude Code hook that read the session
            transcript, the CI job that wrapped the run, or, strongest of all, the provider's own invoice. Connect an admin key
            here and PTD can compare a whole month's billing against the ledger, and tell you the difference.
          </>
        }
        technical={
          <>
            <li>
              <code>usage.connect_provider</code> (admin) seals the key with AES-256-GCM under <code>PTD_SECRET_KEY</code> in{" "}
              <code>org_integrations</code> (kind <code>usage_anthropic</code> / <code>usage_openai</code>). No action ever
              returns it — only its last four characters.
            </li>
            <li>
              <code>usage.reconcile</code> (admin) reads the provider's usage and cost reports for the period, compares the
              token total with what agents booked into <code>time_entries</code>, and stores a <code>usage_reconciliations</code>{" "}
              row: <code>match</code> · <code>under_reported</code> · <code>over_reported</code> · <code>unavailable</code>.
            </li>
            <li>
              Tolerance is 5% of the provider's figure or 10,000 tokens, whichever is larger. The two totals are not
              commensurable to the token — a provider bill includes keys PTD never sees — so a verdict is a signal to look, and
              the row's <code>detail</code> carries the gap, the coverage and the per-agent split to look with.
            </li>
            <li>
              Admin-only by design: the agents being measured must not be able to reach the credential doing the measuring.
              Both provider actions are recorded in the audit log.
            </li>
            <li>
              Per-session evidence comes from <code>time_entry.attest</code>, and <code>usage.summary</code> (manager) is the
              reported-vs-verified roll-up on Overview → Agents.
            </li>
          </>
        }
      />

      <div className="paper-flat">
        <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
          <ShieldCheck className="h-3.5 w-3.5" />
          <span className="microcaps">Provider keys</span>
        </div>
        {providers.isLoading ? (
          <div className="py-8 text-center">
            <Loader2 className="mx-auto h-4 w-4 animate-spin text-ink-muted" />
          </div>
        ) : providers.error ? (
          <div className="px-3 py-6 text-center" data-testid="providers-unavailable">
            <TriangleAlert className="mx-auto h-4 w-4 text-ink-muted" />
            <p className="mt-2 font-serif text-sm italic text-ink-muted">{(providers.error as Error).message}</p>
            <p className="eyebrow mt-1 text-[9px]">usage.providers — admin and above.</p>
          </div>
        ) : (
          <ul className="divide-y divide-rule">
            {(providers.data ?? []).map((p) => (
              <ConnectRow key={p.provider} view={p} onConnected={() => qc.invalidateQueries({ queryKey: ["/api/actions/usage.providers"] })} />
            ))}
          </ul>
        )}
      </div>

      <div className="paper-flat">
        <div className="flex items-center justify-between border-b border-rule px-3 py-2">
          <span className="microcaps">Reconcile a period</span>
          <span className="eyebrow text-[9px]">{connected.length === 0 ? "connect a key first" : `${connected.length} key${connected.length === 1 ? "" : "s"} available`}</span>
        </div>
        <div className="flex flex-wrap items-end gap-3 px-3 py-3">
          <label className="block">
            <span className="eyebrow text-[9px]">provider</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as UsageProvider)}
              className="draft-input mt-1 w-32 text-sm focus-ink"
              data-testid="reconcile-provider"
            >
              {(providers.data ?? []).map((p) => (
                <option key={p.provider} value={p.provider} disabled={!p.connected}>
                  {PROVIDER_LABEL[p.provider]}
                  {p.connected ? "" : " — no key"}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="eyebrow text-[9px]">from</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="draft-input font-numeric mt-1 text-sm focus-ink" data-testid="reconcile-from" />
          </label>
          <label className="block">
            <span className="eyebrow text-[9px]">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="draft-input font-numeric mt-1 text-sm focus-ink" data-testid="reconcile-to" />
          </label>
          <Hint text="Reads the provider's usage and cost report for this period and stores the comparison. A read on their side; nothing is changed there.">
            <button
              onClick={() => run.mutate()}
              disabled={run.isPending || connected.length === 0}
              className="inline-flex items-center gap-2 rounded-sm border border-ink bg-ink px-4 py-2 text-parchment transition-colors hover:bg-parchment hover:text-ink focus-ink disabled:opacity-60"
              data-testid="run-reconcile"
            >
              {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              <span className="eyebrow text-[10px] !text-current">reconcile</span>
            </button>
          </Hint>
        </div>

        <div className="border-t border-rule">
          <div className="flex items-center justify-between bg-parchment-deep/40 px-3 py-1.5">
            <span className="microcaps">History</span>
            <span className="eyebrow font-numeric text-[9px]">{rows.length}</span>
          </div>
          {history.isLoading ? (
            <div className="py-8 text-center">
              <Loader2 className="mx-auto h-4 w-4 animate-spin text-ink-muted" />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-3 py-6 text-center font-serif text-sm italic text-ink-muted">
              Nothing reconciled yet. Pick a finished month above — the last complete one is filled in for you.
            </p>
          ) : (
            <ul className="divide-y divide-rule" data-testid="reconciliation-history">
              {rows.map((row) => (
                <HistoryRow key={row.id} row={row} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
