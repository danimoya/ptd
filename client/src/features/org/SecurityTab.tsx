// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { KeyRound, Link2, Loader2, RefreshCw, ShieldAlert, ShieldCheck, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useMe, canAccess } from "@/hooks/use-me";
import CopyBlock from "./CopyBlock";
import Explainer from "./Explainer";
import { Hint } from "./Hint";
import {
  ORG_SECURITY_KEY, SECURITY_KEY, confirmTotp, disableTotp, getOrgSecurity, getSecurity, newRecoveryCodes,
  setOrgSecurity, startTotpSetup, svgDataUri, unlinkIdentity,
  type Enrolment, type OrgSecurityPolicy, type SecurityState,
} from "./security/api";

const day = (v: string | null | undefined) => (v ? format(new Date(v), "d MMM yyyy") : "—");

/**
 * Org → Security. One tab, two scopes: the second factor on *your* account, and
 * the policy the organization imposes on everyone's.
 *
 * They sit together because that is the order the work happens in — an admin who
 * wants to require 2FA has to enrol first, and the server refuses the policy until
 * they have. The tab makes that sequence visible rather than answering an error.
 */
export default function SecurityTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { role, org } = useMe();
  const isAdmin = canAccess(role, "admin");

  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState("");
  const [offCode, setOffCode] = useState("");
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  const security = useQuery<SecurityState>({ queryKey: SECURITY_KEY, queryFn: getSecurity });
  const policy = useQuery<OrgSecurityPolicy>({ queryKey: ORG_SECURITY_KEY, queryFn: getOrgSecurity, enabled: isAdmin });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: SECURITY_KEY });
    qc.invalidateQueries({ queryKey: ORG_SECURITY_KEY });
  };

  const begin = useMutation({
    mutationFn: startTotpSetup,
    onSuccess: (data) => {
      setEnrolment(data);
      setCode("");
    },
    onError: (err: Error) => toast({ title: "Could not start enrolment", description: err.message, variant: "destructive" }),
  });

  const confirm = useMutation({
    mutationFn: () => confirmTotp(code.replace(/\D/g, "")),
    onSuccess: (data) => {
      setEnrolment(null);
      setCode("");
      setFreshCodes(data.recoveryCodes);
      refresh();
      toast({ title: "Two-factor authentication is on", description: "Save the recovery codes before you leave this page." });
    },
    onError: (err: Error) => toast({ title: "That code was not accepted", description: err.message, variant: "destructive" }),
  });

  const turnOff = useMutation({
    mutationFn: () => disableTotp(offCode.trim()),
    onSuccess: () => {
      setOffCode("");
      setFreshCodes(null);
      refresh();
      toast({ title: "Two-factor authentication is off", description: "Your password alone signs you in again." });
    },
    onError: (err: Error) => toast({ title: "Could not turn it off", description: err.message, variant: "destructive" }),
  });

  const regenerate = useMutation({
    mutationFn: () => newRecoveryCodes(offCode.trim()),
    onSuccess: (data) => {
      setOffCode("");
      setFreshCodes(data.recoveryCodes);
      refresh();
    },
    onError: (err: Error) => toast({ title: "Could not mint new codes", description: err.message, variant: "destructive" }),
  });

  const unlink = useMutation({
    mutationFn: ({ id, confirm }: { id: number; confirm?: boolean }) => unlinkIdentity(id, confirm),
    onSuccess: (data) => {
      refresh();
      toast({ title: `${data.provider ?? "Provider"} unlinked` });
    },
    onError: (err: Error) => toast({ title: "Could not unlink", description: err.message, variant: "destructive" }),
  });

  const policyMutation = useMutation({
    mutationFn: (requireTotp: boolean) => setOrgSecurity(requireTotp),
    onSuccess: (data) => {
      refresh();
      toast({
        title: data.requireTotp ? "Two-factor authentication is now required" : "The requirement is off",
        description: data.requireTotp
          ? "Members without it are refused on this organization until they enrol."
          : "Members can sign in with a password alone again.",
      });
    },
    onError: (err: Error) => toast({ title: "Could not change the policy", description: err.message, variant: "destructive" }),
  });

  const state = security.data;
  const linked = state?.identities ?? [];
  const available = (state?.providers ?? []).filter((p) => !linked.some((i) => i.provider === p.provider));

  return (
    <div className="space-y-5">
      <Explainer
        testId="security-explainer"
        why={
          <>
            A password is one secret, and secrets leak — reused on another site, typed into a convincing page, read out of a
            breach dump. A second factor means the leak is not enough: signing in also needs the six digits that only the app on
            your phone can produce, thirty seconds at a time. Recovery codes are the way back in when that phone is lost, which
            is why they are shown once and worth printing. An organization can require all of this of everyone.
          </>
        }
        technical={
          <>
            <li>
              TOTP, <code>RFC 6238</code>: HMAC-SHA1 over a 160-bit shared secret, 30-second steps, six digits, ±1 step accepted
              for clock drift. Any authenticator app works — there is nothing PTD-specific in the QR code.
            </li>
            <li>
              The secret is sealed with <code>AES-256-GCM</code> under <code>PTD_SECRET_KEY</code> before it is stored, and is
              never returned to a client again after enrolment.
            </li>
            <li>
              Ten recovery codes, each 50 bits, sealed the same way. Each works once: using one rewrites the stored list without
              it.
            </li>
            <li>
              Sign-in becomes two calls: <code>POST /api/auth/login</code> answers{" "}
              <code>{"{ mfaRequired: true, preAuthToken }"}</code> — a five-minute token that is *not* a session — and{" "}
              <code>POST /api/auth/totp/login</code> trades it plus a code for the real one. Five wrong codes in five minutes and
              that account's step-up stops answering.
            </li>
            <li>
              A linked provider is a <code>(provider, subject)</code> pair, not an address: renaming a GitHub login or changing a
              work address does not make you a different person. Linking only ever happens on an address the provider says it has
              verified.
            </li>
            <li>
              With the org policy on, every org-scoped call from a human without 2FA answers <code>403 totp_required</code>. The
              account surface <code>/api/auth/**</code> keeps working, so this page still does. Agent seats are exempt — their
              credential is a revocable <code>ptd_</code> token.
            </li>
          </>
        }
      />

      {security.isLoading ? (
        <div className="py-10 text-center" data-testid="security-loading">
          <Loader2 className="mx-auto h-4 w-4 animate-spin text-ink-muted" />
        </div>
      ) : (
        <>
          {state?.blocked && (
            <section className="paper border-vermilion/50 bg-vermilion/5 p-4" data-testid="security-blocked">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-vermilion" />
                <span className="microcaps text-vermilion">Required here</span>
              </div>
              <p className="mt-1 max-w-prose font-serif text-sm text-ink-muted">
                {state.orgs.filter((o) => o.requireTotp).map((o) => o.name).join(", ")} requires two-factor authentication. Until
                you finish the setup below, calls into that organization are refused.
              </p>
            </section>
          )}

          {/* ── Your second factor ─────────────────────────────────────── */}
          <section className="paper p-4" data-testid="security-totp">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="eyebrow text-[9px]">Personal · sign-in</div>
                <h3 className="font-display mt-0.5 flex items-center gap-2 text-xl tracking-tight">
                  {state?.totpEnabled ? <ShieldCheck className="h-4 w-4 text-vermilion" /> : <ShieldAlert className="h-4 w-4" />}
                  Two-factor authentication
                </h3>
                <p className="mt-1 max-w-prose font-serif text-sm text-ink-muted">
                  {state?.totpEnabled
                    ? `On. Signing in asks for a code after your password. ${state.recoveryCodesLeft} recovery code${state.recoveryCodesLeft === 1 ? "" : "s"} left.`
                    : "Off. Your password alone signs you in."}
                </p>
              </div>
              <span className={cn("stamp shrink-0 font-numeric", state?.totpEnabled && "text-vermilion")}>
                {state?.totpEnabled ? "on" : "off"}
              </span>
            </div>

            {!state?.totpEnabled && !enrolment && (
              <button
                type="button"
                onClick={() => begin.mutate()}
                disabled={begin.isPending}
                className="focus-ink mt-4 inline-flex items-center gap-2 border border-ink bg-ink px-4 py-2 font-numeric text-[11px] uppercase tracking-[0.16em] text-parchment transition-all hover:-translate-x-px hover:-translate-y-px hover:bg-parchment hover:text-ink hover:shadow-stamp disabled:opacity-60"
                data-testid="totp-begin"
              >
                {begin.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                Set it up
              </button>
            )}

            {enrolment && (
              <div className="mt-4 space-y-4 border-t border-rule pt-4" data-testid="totp-enrolment">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <img
                    src={svgDataUri(enrolment.qrSvg)}
                    alt="QR code for the authenticator app"
                    width={180}
                    height={180}
                    className="shrink-0 border border-rule bg-white p-1"
                    data-testid="totp-qr"
                  />
                  <div className="min-w-0 flex-1 space-y-3">
                    <p className="font-serif text-sm leading-relaxed text-ink-muted">
                      Scan this with an authenticator app, or type the secret in by hand. Then enter the six digits it shows.
                    </p>
                    <CopyBlock label="Secret" body={enrolment.secret} testId="totp-secret" />
                    <div className="text-[0.78rem] text-ink-muted">
                      {enrolment.account} · SHA1 · {enrolment.digits} digits · {enrolment.period}s
                    </div>
                  </div>
                </div>

                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    confirm.mutate();
                  }}
                >
                  <label className="block">
                    <span className="eyebrow mb-1.5 block">Code from the app</span>
                    <input
                      className="draft-input w-40 text-center font-mono text-lg tracking-[0.35em]"
                      placeholder="000000"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      data-testid="totp-confirm-input"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={code.length !== 6 || confirm.isPending}
                    className="focus-ink inline-flex items-center gap-2 border border-ink bg-ink px-4 py-2.5 font-numeric text-[11px] uppercase tracking-[0.16em] text-parchment transition-all hover:bg-parchment hover:text-ink disabled:opacity-60"
                    data-testid="totp-confirm"
                  >
                    {confirm.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Turn it on
                  </button>
                  <button
                    type="button"
                    onClick={() => setEnrolment(null)}
                    className="focus-ink px-2 py-2.5 font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                </form>
              </div>
            )}

            {freshCodes && (
              <div className="mt-4 border border-vermilion/40 bg-vermilion/5 p-4" data-testid="recovery-codes">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-vermilion" />
                  <span className="microcaps text-vermilion">Shown once</span>
                </div>
                <p className="mt-1 max-w-prose font-serif text-sm text-ink-muted">
                  Ten recovery codes. Each works once, in place of a code from the app. Print them, or put them somewhere that is
                  not the phone they are meant to replace.
                </p>
                <CopyBlock className="mt-3" body={freshCodes.join("\n")} testId="recovery-codes-block" />
                <button
                  type="button"
                  onClick={() => setFreshCodes(null)}
                  className="focus-ink mt-3 font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink"
                  data-testid="recovery-codes-dismiss"
                >
                  I have saved them
                </button>
              </div>
            )}

            {state?.totpEnabled && (
              <form
                className="mt-4 flex flex-wrap items-end gap-2 border-t border-rule pt-4"
                onSubmit={(e) => e.preventDefault()}
                data-testid="totp-manage"
              >
                <label className="block">
                  <span className="eyebrow mb-1.5 flex items-center gap-1.5">
                    Current code
                    <Hint text="Either the six digits from the app, or one unused recovery code. Turning 2FA off or replacing the codes both require it, so a borrowed session cannot do either." />
                  </span>
                  <input
                    className="draft-input w-44 font-mono tracking-[0.2em]"
                    placeholder="000000"
                    value={offCode}
                    onChange={(e) => setOffCode(e.target.value)}
                    autoComplete="one-time-code"
                    data-testid="totp-current-code"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => regenerate.mutate()}
                  disabled={offCode.trim().length < 6 || regenerate.isPending}
                  className="focus-ink inline-flex items-center gap-2 border border-rule px-3 py-2.5 font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted transition-colors hover:border-ink hover:text-ink disabled:opacity-50"
                  data-testid="totp-regenerate"
                >
                  {regenerate.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  New recovery codes
                </button>
                <button
                  type="button"
                  onClick={() => turnOff.mutate()}
                  disabled={offCode.trim().length < 6 || turnOff.isPending}
                  className="focus-ink inline-flex items-center gap-2 border border-vermilion/60 px-3 py-2.5 font-numeric text-[11px] uppercase tracking-[0.16em] text-vermilion transition-colors hover:bg-vermilion/10 disabled:opacity-50"
                  data-testid="totp-disable"
                >
                  {turnOff.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Turn off
                </button>
              </form>
            )}
          </section>

          {/* ── Linked providers ───────────────────────────────────────── */}
          <section className="paper p-4" data-testid="security-identities">
            <div className="eyebrow text-[9px]">Personal · providers</div>
            <h3 className="font-display mt-0.5 flex items-center gap-2 text-xl tracking-tight">
              <Link2 className="h-4 w-4" /> Linked sign-in providers
            </h3>
            <p className="mt-1 max-w-prose font-serif text-sm text-ink-muted">
              Accounts that can sign you in without typing a password. PTD reads a verified email address and a display name from
              them, and nothing else.
            </p>

            {linked.length === 0 ? (
              <p className="mt-3 text-sm text-ink-muted">Nothing linked. Your password is the only way in.</p>
            ) : (
              <ul className="mt-3 divide-y divide-rule border-y border-rule">
                {linked.map((identity) => (
                  <li key={identity.id} className="flex items-center justify-between gap-3 py-2.5" data-testid={`identity-${identity.provider}`}>
                    <div className="min-w-0">
                      <div className="font-display text-base capitalize tracking-tight">{identity.provider}</div>
                      <div className="truncate text-[0.8rem] text-ink-muted">
                        {identity.email ?? "no address reported"} · linked {day(identity.createdAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => unlink.mutate({ id: identity.id, confirm: linked.length === 1 })}
                      disabled={unlink.isPending}
                      className="focus-ink inline-flex shrink-0 items-center gap-1.5 border border-rule px-2.5 py-1.5 font-numeric text-[10px] uppercase tracking-[0.12em] text-ink-muted transition-colors hover:border-vermilion hover:text-vermilion disabled:opacity-50"
                      data-testid={`identity-unlink-${identity.provider}`}
                    >
                      <Unlink className="h-3 w-3" /> unlink
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {available.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="eyebrow text-[9px]">Link another</span>
                {available.map((p) => (
                  <a
                    key={p.provider}
                    href={`${p.startUrl}?redirectTo=${encodeURIComponent("/org/security")}`}
                    className="focus-ink inline-flex items-center gap-1.5 border border-rule px-2.5 py-1.5 font-numeric text-[10px] uppercase tracking-[0.12em] text-ink-muted transition-colors hover:border-ink hover:text-ink"
                    data-testid={`identity-link-${p.provider}`}
                  >
                    <Link2 className="h-3 w-3" /> {p.label}
                  </a>
                ))}
              </div>
            )}
          </section>

          {/* ── Organization policy ────────────────────────────────────── */}
          {isAdmin && (
            <section className="paper p-4" data-testid="security-policy">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="eyebrow text-[9px]">Organization · policy</div>
                  <h3 className="font-display mt-0.5 text-xl tracking-tight">Require two-factor authentication</h3>
                  <p className="mt-1 max-w-prose font-serif text-sm text-ink-muted">
                    Every human member of {org?.name ?? "this organization"} must have 2FA on. Anyone who does not is refused —
                    with a clear message and a link here — until they enrol. Agent seats are exempt: they sign in with a token an
                    admin can revoke.
                  </p>
                  {policy.data?.updatedAt && (
                    <p className="mt-1 text-[0.78rem] text-ink-muted">Last changed {day(policy.data.updatedAt)}.</p>
                  )}
                </div>
                <span className={cn("stamp shrink-0 font-numeric", policy.data?.requireTotp && "text-vermilion")}>
                  {policy.data?.requireTotp ? "required" : "optional"}
                </span>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-rule pt-4">
                <button
                  type="button"
                  onClick={() => policyMutation.mutate(!policy.data?.requireTotp)}
                  disabled={policyMutation.isPending || policy.isLoading}
                  className={cn(
                    "focus-ink inline-flex items-center gap-2 border px-4 py-2 font-numeric text-[11px] uppercase tracking-[0.16em] transition-all disabled:opacity-60",
                    policy.data?.requireTotp
                      ? "border-rule text-ink-muted hover:border-ink hover:text-ink"
                      : "border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink",
                  )}
                  data-testid="policy-toggle"
                >
                  {policyMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {policy.data?.requireTotp ? "Stop requiring it" : "Require it"}
                </button>
                {!state?.totpEnabled && !policy.data?.requireTotp && (
                  <span className="text-[0.8rem] text-ink-muted">
                    Turn it on for your own account first — otherwise this would lock you out immediately.
                  </span>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
