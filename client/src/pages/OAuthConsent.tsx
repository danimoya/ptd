import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowRight, Check, Loader2, Plug, ShieldCheck, X } from "lucide-react";
import { StudioMasthead, StudioRibbon } from "@/components/StudioMasthead";
import { isTokenExpired, signOut } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  callbackHost, fetchActions, fetchClientInfo, fetchMe, login, missingConsentParams, postDecision,
  readConsentParams, scopeList, toolsBySurface,
  type ActionRow, type ClientInfo, type MeOrgs,
} from "@/features/oauth/api";

/**
 * OAuth consent screen — the one place a human decides that an MCP client
 * (a Claude.ai or ChatGPT connector) may act inside one of their organizations.
 *
 * The page never builds a callback URL itself: it posts the decision and
 * navigates to the URL the server returns, so an unvalidated redirect_uri in the
 * address bar can never turn PTD into an open redirect. It also never chooses a
 * permission level — the connector inherits the membership role the approver
 * already holds in the organization they pick, and the tool list shown here is
 * read back from /api/actions for exactly that role.
 */
export default function OAuthConsent() {
  const [search] = useSearchParams();
  const params = useMemo(() => readConsentParams(search), [search]);
  const missing = useMemo(() => missingConsentParams(params), [params]);

  const [token, setToken] = useState<string | null>(null);
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [me, setMe] = useState<MeOrgs | null>(null);
  const [orgId, setOrgId] = useState<number | null>(null);
  const [actions, setActions] = useState<ActionRow[] | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);

  // A stale session would otherwise trip the global 401 interceptor and throw
  // the authorize query away, so it is cleared before anything else runs.
  useEffect(() => {
    if (localStorage.getItem("token") && isTokenExpired()) signOut(false);
    setToken(isTokenExpired() ? null : localStorage.getItem("token"));
  }, []);

  useEffect(() => {
    if (missing.length > 0 || !params.clientId) return;
    let alive = true;
    fetchClientInfo(params.clientId)
      .then((info) => alive && setClient(info))
      .catch((e: Error) => alive && setFatal(e.message));
    return () => { alive = false; };
  }, [params.clientId, missing.length]);

  useEffect(() => {
    if (!token) { setMe(null); setOrgId(null); return; }
    let alive = true;
    fetchMe(token)
      .then((data) => {
        if (!alive) return;
        setMe(data);
        const remembered = Number(localStorage.getItem("orgId"));
        const pick = data.orgs.find((o) => o.orgId === remembered) ?? data.orgs[0];
        setOrgId(pick ? pick.orgId : null);
      })
      .catch(() => { if (alive) { setToken(null); setError("That session has expired — please sign in again."); } });
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    if (!token || orgId === null) { setActions(null); return; }
    let alive = true;
    fetchActions(token, orgId)
      .then((rows) => alive && setActions(rows))
      .catch(() => alive && setActions([]));
    return () => { alive = false; };
  }, [token, orgId]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await login(email.trim(), password);
      localStorage.setItem("token", data.token);
      if (data.user?.email) localStorage.setItem("userEmail", data.user.email);
      setToken(data.token);
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign you in");
    } finally {
      setBusy(false);
    }
  };

  const decide = useCallback(
    async (decision: "approve" | "deny") => {
      if (!token || orgId === null) return;
      setBusy(true);
      setError(null);
      try {
        const result = await postDecision(token, params, orgId, decision);
        localStorage.setItem("orgId", String(orgId));
        window.location.assign(result.redirect);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The authorization server refused the request");
        setBusy(false);
      }
    },
    [token, orgId, params]
  );

  const org = me?.orgs.find((o) => o.orgId === orgId) ?? null;
  const groups = actions ? toolsBySurface(actions) : [];
  const toolCount = actions?.length ?? 0;
  const scopes = scopeList(params.scope);

  /* ── request we must not act on at all ── */
  if (missing.length > 0 || fatal) {
    return (
      <Plate ribbon="Authorization error" heading="This request cannot be approved">
        <Notice tone="alert" icon={<AlertTriangle className="h-4 w-4" />}>
          {fatal ?? `The authorization request is incomplete: ${missing.join(", ")} missing or unsupported.`}
        </Notice>
        <p className="text-sm text-ink-3">
          Nothing was approved and no token was issued. Start the connection again from the application that sent you here —
          it must use the authorization code flow with an S256 PKCE challenge.
        </p>
      </Plate>
    );
  }

  if (denied) {
    return (
      <Plate ribbon="Declined" heading="Nothing was approved">
        <p className="text-sm text-ink-3">
          You declined the request{client ? <> from <em className="italic text-ink">{client.client_name}</em></> : null}. No token was issued and you
          can close this tab.
        </p>
      </Plate>
    );
  }

  return (
    <Plate
      ribbon="Connector authorization"
      heading={client ? `Allow ${client.client_name}?` : "Authorize a connector"}
      subhead={
        client
          ? "An MCP client is asking to work inside one of your organizations. It will act with the role you already hold there — never more."
          : "Reading the client registration…"
      }
    >
      <Section label="The client">
        <Row k="name" v={client?.client_name ?? "…"} />
        <Row k="client_id" v={params.clientId} mono />
        <Row k="returns you to" v={callbackHost(params.redirectUri)} mono />
        <Row k="proof of possession" v={`PKCE ${params.codeChallengeMethod}`} mono />
        {params.resource ? <Row k="audience" v={params.resource} mono /> : null}
      </Section>

      {!token ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            signIn();
          }}
        >
          <div className="border border-rule bg-paper p-4 text-xs text-ink-3 leading-relaxed">
            Sign in to decide. PTD never shows your credentials to the client — it only hands back a short-lived token.
          </div>
          <Field label="Correspondence">
            <input
              type="email"
              className="draft-input w-full"
              placeholder="name@house.domain"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              data-testid="consent-email"
            />
          </Field>
          <Field label="Secret hand">
            <input
              type="password"
              className="draft-input w-full font-mono"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              data-testid="consent-password"
            />
          </Field>
          {error ? <Notice tone="alert">{error}</Notice> : null}
          <Primary busy={busy} disabled={!email || !password} label="Sign in to continue" />
          <button
            type="button"
            onClick={() => setDenied(true)}
            className="w-full text-sm text-ink-3 hover:text-ink transition-colors py-1"
          >
            Cancel — do not connect anything
          </button>
        </form>
      ) : (
        <>
          <Section label="Acting as">
            <Row k="signed in" v={me?.user.email ?? "…"} />
            {me && me.orgs.length > 1 ? (
              <Field label="Organization" hint="the connector only ever sees this one">
                <select
                  className="draft-input w-full"
                  value={orgId ?? ""}
                  onChange={(e) => setOrgId(Number(e.target.value))}
                  data-testid="consent-org"
                >
                  {me.orgs.map((o) => (
                    <option key={o.orgId} value={o.orgId}>
                      {o.name} — {o.role}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Row k="organization" v={org ? org.name : "…"} />
            )}
            <div className="flex items-baseline justify-between gap-3 text-xs pt-1">
              <span className="microcaps">your role there</span>
              <span className="stamp stamp-strong" data-testid="consent-role">{org?.role ?? "…"}</span>
            </div>
            {scopes.length > 0 ? (
              <div className="flex items-baseline justify-between gap-3 text-xs pt-1">
                <span className="microcaps">scope requested</span>
                <span className="flex flex-wrap gap-1 justify-end">
                  {scopes.map((s) => (
                    <span key={s} className="stamp">{s}</span>
                  ))}
                </span>
              </div>
            ) : null}
          </Section>

          <Section label={`What it will be able to do (${toolCount} tool${toolCount === 1 ? "" : "s"})`}>
            {actions === null ? (
              <div className="flex items-center gap-2 text-xs text-ink-3">
                <Loader2 className="h-3 w-3 animate-spin" /> reading the tool list for this role…
              </div>
            ) : (
              <>
                {groups.map((g) => {
                  const shown = showAllTools ? g.names : g.names.slice(0, 4);
                  return (
                    <div key={g.surface} className="text-xs">
                      <div className="microcaps mb-1">{g.surface}</div>
                      <ul className="flex flex-wrap gap-1">
                        {shown.map((n) => (
                          <li key={n} className="font-mono text-[11px] border border-rule bg-paper px-1.5 py-0.5 text-ink-2">{n}</li>
                        ))}
                        {!showAllTools && g.names.length > shown.length ? (
                          <li className="text-[11px] text-ink-3 px-1 py-0.5">+{g.names.length - shown.length}</li>
                        ) : null}
                      </ul>
                    </div>
                  );
                })}
                {toolCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowAllTools((v) => !v)}
                    className="text-[11px] text-ink-3 hover:text-ink transition-colors"
                  >
                    {showAllTools ? "show fewer" : "show every tool"}
                  </button>
                ) : null}
                <div className="flex items-start gap-2 pt-2 text-[11px] text-ink-3 leading-relaxed">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-sage" />
                  <span>
                    The token expires in an hour and is refreshed silently; revoke it any time with <span className="font-mono">oauth.revoke_grant</span> or
                    from Org → Tokens. The role above is enforced on every call — the scope cannot widen it.
                  </span>
                </div>
              </>
            )}
          </Section>

          {error ? <Notice tone="alert">{error}</Notice> : null}

          <div className="space-y-3 pt-1">
            <button
              type="button"
              onClick={() => decide("approve")}
              disabled={busy || orgId === null}
              data-testid="consent-approve"
              className={cn(
                "group relative w-full px-5 py-3 bg-ink text-paper font-medium border border-ink transition-all duration-150",
                "hover:bg-paper hover:text-ink hover:shadow-stamp hover:-translate-x-px hover:-translate-y-px",
                "disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              )}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              <span className="microcaps !text-current">Approve the connection</span>
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={() => decide("deny")}
              disabled={busy}
              data-testid="consent-deny"
              className="w-full px-5 py-2.5 border border-rule text-ink-2 hover:border-ink hover:text-ink transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <X className="h-4 w-4" />
              <span className="microcaps !text-current">Deny</span>
            </button>
          </div>
        </>
      )}
    </Plate>
  );
}

/* ─────────────────────────────── furniture ─────────────────────────────── */

function Plate({
  ribbon,
  heading,
  subhead,
  children,
}: {
  ribbon: string;
  heading: string;
  subhead?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen w-full bg-paper-2/60 px-6 py-10 md:py-16 flex justify-center">
      <div className="w-full max-w-xl">
        <div className="flex items-center justify-between gap-4 mb-8">
          <StudioMasthead size="sm" />
          <span className="microcaps hidden sm:inline">Connector desk</span>
        </div>
        <div className="border border-rule bg-paper p-6 md:p-8 shadow-stamp">
          <StudioRibbon label={ribbon} className="mb-5" />
          <h2 className="font-display text-3xl md:text-4xl tracking-tightest text-ink flex items-start gap-3">
            <Plug className="h-6 w-6 mt-1.5 shrink-0 text-vermilion" />
            <span>{heading}</span>
          </h2>
          {subhead ? <p className="text-ink-3 mt-3 mb-6 text-sm leading-relaxed">{subhead}</p> : <div className="mb-6" />}
          <div className="space-y-5">{children}</div>
        </div>
        <p className="microcaps mt-6 text-center">OAuth 2.1 · authorization code + PKCE · MCP 2025-06-18</p>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-rule pt-3">
      <div className="microcaps mb-2">{label}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-ink-3 microcaps shrink-0">{k}</span>
      <span className={cn("text-ink text-right break-all", mono && "font-mono text-[11px]")} title={v}>{v}</span>
    </div>
  );
}

function Notice({ tone, icon, children }: { tone: "alert" | "plain"; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "px-3 py-2 text-sm flex items-start gap-2",
        tone === "alert" ? "border border-vermilion/40 bg-vermilion/10 font-serif italic text-vermilion" : "border border-rule bg-paper text-ink-3"
      )}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="microcaps">{label}</span>
        {hint ? <span className="text-[11px] text-ink-4">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

function Primary({ busy, disabled, label }: { busy: boolean; disabled: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className={cn(
        "group relative w-full px-5 py-3 bg-ink text-paper font-medium border border-ink transition-all duration-150",
        "hover:bg-paper hover:text-ink hover:shadow-stamp hover:-translate-x-px hover:-translate-y-px",
        "disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      )}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      <span className="microcaps !text-current">{label}</span>
      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
