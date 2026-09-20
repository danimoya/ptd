// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyRow, ErrorNote, Field, KV, Note, Section, Submit } from "@/features/auth/bits";
import {
  acceptInvitation, exchangeOidc, getProviders, isMfaChallenge, keepSession, lookupInvitation, signIn, signUp,
  OIDC_ERRORS, type InviteInfo, type MfaChallenge, type ProviderSummary,
} from "@/features/auth/api";
import InvitePanel from "@/features/auth/InvitePanel";
import ForgotPanel from "@/features/auth/ForgotPanel";
import ResetPanel from "@/features/auth/ResetPanel";
import OidcButtons from "@/features/auth/OidcButtons";
import TotpPanel from "@/features/auth/TotpPanel";
import TotpSetupPanel from "@/features/auth/TotpSetupPanel";

/* ─────────────────────────────────────────────────────────────────────────
 * The way in.
 *
 * Five doors on one plate: sign in, open an organization, take an agent seat,
 * ask for a password-reset link, or set a new password from one. The public page
 * carries the argument; this page only takes credentials.
 *
 * Two of the five are reached by link rather than by choice. `?invite=<token>`
 * names the organization before anything is typed and joins it on the way in;
 * `?reset=<token>` opens straight into the new-password form. Both read their
 * token from the query string and never from storage, so a link forwarded to the
 * wrong person is still just a link.
 *
 * Two more arrive here without a mode of their own. `?oidc=<code>` is a provider
 * sign-in coming back: the code is traded for the session over POST and then
 * scrubbed from the URL, because the token must never be in a link and the code
 * works once. `?oidc_error=<reason>` is the same trip having failed, said in
 * words. And a password against an account with 2FA on does not open the door at
 * all — it swaps this page for one field and a five-minute deadline.
 * ───────────────────────────────────────────────────────────────────────── */

type Mode = "login" | "register" | "agent" | "forgot" | "reset" | "setup";

interface AgentSignupResult {
  user: { id: number; email: string };
  org: { id: number; name: string; role: string };
  token: { id: number; name: string; prefix: string; secret: string };
  auth_header_example: string;
  mcp_url: string;
  discovery_url: string;
  manifest?: { mcp?: { tools?: { name: string; title: string }[] } };
}

function modeFromQuery(params: URLSearchParams): Mode {
  // Where a member is sent when their organization requires a second factor they
  // do not have: the enrolment page cannot live behind the surface that is
  // refusing them, so it lives here.
  if (params.get("setup") === "2fa") return "setup";
  if (params.get("reset")) return "reset";
  const value = params.get("mode");
  if (value === "register") return "register";
  if (value === "agent") return "agent";
  if (value === "forgot") return "forgot";
  return "login";
}

export default function Auth() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const resetToken = params.get("reset") ?? "";
  const inviteToken = params.get("invite") ?? "";
  const [mode, setMode] = useState<Mode>(() => modeFromQuery(params));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [joined, setJoined] = useState<string | null>(null);

  // The 2FA step. Its presence, not a `mode`, is what replaces the form: it can
  // be reached from a password *or* from a provider sign-in, and neither of those
  // is a door the person chose from the switcher.
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const [agentName, setAgentName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [agentEmail, setAgentEmail] = useState("");
  const [agentResult, setAgentResult] = useState<AgentSignupResult | null>(null);

  useEffect(() => {
    let live = true;
    getProviders().then((list) => live && setProviders(list));
    return () => {
      live = false;
    };
  }, []);

  // A provider sign-in coming back. The code is single-use and short-lived, so it
  // is spent once and dropped from the URL either way — a reload must not retry a
  // code the server has already burned.
  useEffect(() => {
    const failure = params.get("oidc_error");
    if (failure) {
      setError(OIDC_ERRORS[failure] ?? `That sign-in did not finish (${failure}).`);
      stripOidcParams();
      return;
    }
    const code = params.get("oidc");
    if (!code) return;
    let live = true;
    setBusy(true);
    exchangeOidc(code)
      .then((result) => {
        if (!live) return;
        if (isMfaChallenge(result)) {
          setChallenge(result);
          return;
        }
        keepSession(result.token, result.user?.email, result.orgId ?? undefined);
        enter();
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "That sign-in could not be completed"))
      .finally(() => {
        if (!live) return;
        setBusy(false);
        stripOidcParams();
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the invitation is for, and the address it is bound to. A token the
  // server will not vouch for simply produces no panel.
  useEffect(() => {
    if (!inviteToken) return;
    let live = true;
    lookupInvitation(inviteToken).then((info) => {
      if (!live || !info) return;
      setInvite(info);
      setEmail((current) => current || info.email);
      // An address with no account yet is a registration, not a sign-in; the
      // switcher is still there if that guess is wrong.
      if (info.accepted) setMode("login");
    });
    return () => {
      live = false;
    };
  }, [inviteToken]);

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  /** Land in the app. A reload so `useMe` refetches against the new token. */
  const enter = (to = "/") => {
    navigate(to);
    window.location.reload();
  };

  /** Take the one-time code (or the failure) out of the address bar. */
  const stripOidcParams = () => {
    const next = new URLSearchParams(window.location.search);
    next.delete("oidc");
    next.delete("oidc_error");
    const query = next.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "register"
          ? await signUp({
              email: email.trim(),
              password,
              ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
              ...(orgName.trim() ? { orgName: orgName.trim() } : {}),
            })
          : await signIn(email.trim(), password);
      if (isMfaChallenge(result)) {
        // Correct password, account has 2FA: nothing is stored yet — the pre-auth
        // token lives in component state only, and is not a session.
        setChallenge(result);
        setBusy(false);
        return;
      }
      if (!result.token) throw new Error("No token came back — try again");
      keepSession(result.token, result.user?.email ?? email.trim());

      // With an invitation in hand, joining is part of coming in. A refusal here
      // (wrong address, expired link) is reported without throwing the session
      // away — the caller is signed in either way, and can carry on.
      if (inviteToken && invite && !invite.accepted && !invite.expired) {
        try {
          const accepted = await acceptInvitation(inviteToken, result.token);
          keepSession(result.token, result.user?.email ?? email.trim(), accepted.orgId);
          setJoined(invite.orgName);
        } catch (e) {
          setError(
            `${e instanceof Error ? e.message : "The invitation could not be accepted"} — you are signed in, but not yet on that organization's roll.`
          );
          setBusy(false);
          return;
        }
      }
      enter();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign you in");
    } finally {
      setBusy(false);
    }
  };

  const submitAgent = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, string> = { name: agentName.trim() };
      if (inviteCode.trim()) payload.inviteCode = inviteCode.trim();
      if (agentEmail.trim()) payload.email = agentEmail.trim();
      const res = await fetch("/api/agent/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
      setAgentResult(body as AgentSignupResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the seat");
    } finally {
      setBusy(false);
    }
  };

  const heading = agentResult
    ? "Save the token"
    : mode === "setup"
      ? "Set up two-factor authentication"
      : challenge
      ? "One more step"
      : mode === "register"
      ? invite && !invite.accepted && !invite.expired
        ? `Join ${invite.orgName}`
        : "Create an organization"
      : mode === "agent"
        ? "Take a seat"
        : mode === "forgot"
          ? "Forgotten password"
          : mode === "reset"
            ? "Set a new password"
            : "Sign in";

  const subhead = agentResult
    ? "It is shown exactly once. Copy it into the agent's config before you leave this page."
    : mode === "setup"
      ? "An authenticator app, one scan, and six digits. Two minutes, once."
      : challenge
      ? "Your account has two-factor authentication on. The code from your authenticator, or one recovery code."
      : mode === "register"
      ? invite && !invite.accepted && !invite.expired
        ? `Create an account for ${invite.email} and you are on the roll as ${invite.role}.`
        : "One organization, four surfaces, every person and agent on the same roll."
      : mode === "agent"
        ? "Open a seat for an AI agent — bearer-token auth, ready for MCP, REST and the connectors."
        : mode === "forgot"
          ? "A single-use link, good for thirty minutes."
          : mode === "reset"
            ? "One password, and you are back where you left off."
            : "Your work is where you left it.";

  return (
    <div className="grain min-h-[100dvh]">
      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col px-5 py-8 sm:px-8 sm:py-12">
        <Link to="/welcome" className="focus-ink flex flex-col leading-none">
          <span className="eyebrow text-[9px] text-vermilion/90">Plan · Track · Done</span>
          <span className="font-display mt-1 text-[28px] font-light tracking-tight">
            <span className="font-semibold">PTD</span>
            <span className="text-vermilion">.</span>
          </span>
        </Link>

        <div className="my-8 flex items-center gap-3">
          <span className="h-px flex-1 bg-ink/70" />
          <span className="eyebrow text-[10px] text-ink">Same task, same source of truth — human or agent</span>
          <span className="h-px flex-1 bg-ink/70" />
        </div>

        <main className="flex-1">
          <h1 className="font-display text-[2rem] leading-tight tracking-[-0.025em] text-ink sm:text-[2.4rem]">{heading}</h1>
          <p className="mt-2 mb-8 text-[1rem] leading-relaxed text-ink-muted text-pretty">{subhead}</p>

          {notice && (
            <div className="mb-5">
              <Note testId="auth-notice">{notice}</Note>
            </div>
          )}

          {agentResult ? (
            <AgentResultPanel
              result={agentResult}
              onClose={() => {
                setAgentResult(null);
                setMode("login");
                setAgentName("");
                setInviteCode("");
                setAgentEmail("");
              }}
            />
          ) : mode === "setup" ? (
            <TotpSetupPanel onDone={() => enter()} />
          ) : challenge ? (
            <TotpPanel
              challenge={challenge}
              onSession={(token, addr, note) => {
                keepSession(token, addr ?? email.trim() ?? undefined);
                if (note) setNotice(note);
                enter();
              }}
              onCancel={() => {
                setChallenge(null);
                setPassword("");
                setError(null);
                setMode("login");
              }}
            />
          ) : mode === "reset" ? (
            <ResetPanel token={resetToken} onDone={enter} onBack={() => switchTo("login")} />
          ) : mode === "forgot" ? (
            <ForgotPanel email={email} onEmail={setEmail} onBack={() => switchTo("login")} />
          ) : mode === "agent" ? (
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                submitAgent();
              }}
            >
              <p className="border border-rule bg-card p-4 text-[0.9rem] leading-relaxed text-ink-muted">
                With an invite code the agent lands as a member of that organization. Without one it opens an
                organization of its own. Either way it gets a{" "}
                <span className="font-numeric text-[0.8rem] text-ink">ptd_</span> token to send on every call, and
                the role decides which of the 85 tools it may use.
              </p>

              <Field label="Agent name" hint="How it will appear on the roll">
                <input
                  className="draft-input w-full"
                  placeholder="Nightly Triage Bot"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  required
                />
              </Field>

              <Field label="Invite code" hint="Optional — from your organization's Org tab">
                <input
                  className="draft-input w-full font-mono text-sm"
                  placeholder="f9d9e8013717f6c0"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  autoComplete="off"
                />
              </Field>

              <Field label="Email" hint="Optional — lets a human take it over later">
                <input
                  type="email"
                  className="draft-input w-full"
                  placeholder="ops@example.com"
                  value={agentEmail}
                  onChange={(e) => setAgentEmail(e.target.value)}
                  autoComplete="off"
                />
              </Field>

              {error && <ErrorNote>{error}</ErrorNote>}

              <Submit busy={busy} disabled={!agentName.trim()}>
                Open the seat
              </Submit>

              <ModeSwitcher mode={mode} setMode={switchTo} />
            </form>
          ) : (
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              {invite && <InvitePanel invite={invite} />}

              <Field label="Email" hint={invite && !invite.accepted && !invite.expired ? "The invited address" : undefined}>
                <input
                  type="email"
                  className="draft-input w-full"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  data-testid="auth-email"
                />
              </Field>

              <Field
                label="Password"
                hint={
                  mode === "register" ? (
                    "At least eight characters"
                  ) : (
                    <button
                      type="button"
                      onClick={() => switchTo("forgot")}
                      className="focus-ink text-[0.75rem] text-ink-muted underline decoration-rule underline-offset-2 transition-colors hover:text-vermilion"
                      data-testid="forgot-link"
                    >
                      Forgot password?
                    </button>
                  )
                }
              >
                <input
                  type="password"
                  className="draft-input w-full font-mono"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === "register" ? 8 : 6}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  data-testid="auth-password"
                />
              </Field>

              {mode === "register" && (
                <>
                  <Field label="Your name" hint="Optional">
                    <input
                      className="draft-input w-full"
                      placeholder="Elena Draftworks"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      autoComplete="name"
                    />
                  </Field>
                  <Field label="Organization name" hint="Optional — you can rename it later">
                    <input
                      className="draft-input w-full"
                      placeholder="Atelier 14"
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      autoComplete="organization"
                    />
                  </Field>
                </>
              )}

              {error && <ErrorNote>{error}</ErrorNote>}
              {error && (
                <button
                  type="button"
                  onClick={() => enter()}
                  className="focus-ink font-numeric text-[11px] uppercase tracking-[0.18em] text-ink-muted hover:text-ink"
                >
                  Continue to PTD &rarr;
                </button>
              )}
              {joined && !error && <p className="eyebrow text-[10px] text-vermilion">Joined {joined} — taking you in…</p>}

              <Submit busy={busy} disabled={!email || !password}>
                {mode === "login" ? "Sign in" : invite && !invite.accepted && !invite.expired ? "Create the account" : "Create the organization"}
              </Submit>

              <OidcButtons
                providers={providers}
                inviteToken={inviteToken || undefined}
                label={mode === "register" ? "Or open one with" : "Or continue with"}
              />

              <ModeSwitcher mode={mode} setMode={switchTo} />
            </form>
          )}
        </main>

        <footer className="mt-10 flex items-center justify-between gap-3 border-t border-rule pt-4">
          <Link to="/welcome" className="focus-ink font-numeric text-[11px] text-ink-muted hover:text-ink">
            What PTD does
          </Link>
          <span className="eyebrow text-[10px]">Open core · MIT</span>
        </footer>
      </div>
    </div>
  );
}

function ModeSwitcher({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const options: { key: Mode; label: string }[] = [
    { key: "login", label: "Already have an account? Sign in" },
    { key: "register", label: "Need an organization? Create one" },
    { key: "agent", label: "Are you an agent? Take a seat" },
  ];
  return (
    <div className="flex flex-col items-start gap-1 border-t border-rule pt-3">
      {options
        .filter((o) => o.key !== mode)
        .map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => setMode(o.key)}
            className="focus-ink py-1 text-[0.9rem] text-ink-muted transition-colors hover:text-ink"
            data-testid={`mode-${o.key}`}
          >
            {o.label}
          </button>
        ))}
    </div>
  );
}

function AgentResultPanel({ result, onClose }: { result: AgentSignupResult; onClose: () => void }) {
  const [copied, setCopied] = useState<"token" | "header" | "discovery" | null>(null);

  const copy = async (key: "token" | "header" | "discovery", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* clipboard can be blocked — the value is on screen either way */
    }
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const mcpUrl = result.mcp_url.startsWith("http") ? result.mcp_url : `${origin}${result.mcp_url}`;
  const discoveryUrl = `${origin}${result.discovery_url}`;
  const toolCount = result.manifest?.mcp?.tools?.length ?? 0;

  return (
    <div className="space-y-5">
      <p className="border border-vermilion/60 bg-vermilion/5 p-4 text-[0.9rem] leading-relaxed text-ink-muted">
        <span className="eyebrow mb-1 block text-vermilion">Shown once</span>
        The token below cannot be recovered after you leave this page. If it is lost, mint a new one from the Org
        tab.
      </p>

      <Section label="Seat">
        <KV k="email" v={result.user.email} />
        <KV k="organization" v={`${result.org.name} · ${result.org.role}`} />
      </Section>

      <Section label="Bearer token">
        <CopyRow mono value={result.token.secret} copied={copied === "token"} onCopy={() => copy("token", result.token.secret)} />
        <CopyRow
          mono
          subtle
          value={result.auth_header_example}
          copied={copied === "header"}
          onCopy={() => copy("header", result.auth_header_example)}
        />
      </Section>

      <Section label="Endpoints">
        <KV k="mcp" v={mcpUrl} mono />
        <CopyRow
          mono
          subtle
          value={discoveryUrl}
          copied={copied === "discovery"}
          onCopy={() => copy("discovery", discoveryUrl)}
        />
      </Section>

      {toolCount > 0 && (
        <Section label={`Tools this role may call (${toolCount})`}>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-[0.8rem]">
            {result.manifest!.mcp!.tools!.map((t) => (
              <li key={t.name} className="flex gap-2">
                <span className="font-numeric whitespace-nowrap text-[0.75rem] text-vermilion">{t.name}</span>
                <span className="truncate text-ink-muted">{t.title}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <button
        type="button"
        onClick={onClose}
        className={cn(
          "focus-ink group flex w-full items-center justify-center gap-2 border border-ink bg-ink px-5 py-3",
          "font-numeric text-[11px] uppercase tracking-[0.18em] text-parchment transition-all duration-150",
          "hover:-translate-x-px hover:-translate-y-px hover:bg-parchment hover:text-ink hover:shadow-stamp"
        )}
      >
        I have saved the token
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </button>
    </div>
  );
}
