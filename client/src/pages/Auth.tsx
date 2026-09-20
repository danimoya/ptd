// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Check, Copy, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * The way in.
 *
 * Three doors on one plate: sign in, open an organization, or — if the
 * visitor is an agent — take a seat and walk away with a token. The public
 * page carries the argument; this page only takes credentials.
 * ───────────────────────────────────────────────────────────────────────── */

type Mode = "login" | "register" | "agent";

interface AgentSignupResult {
  user: { id: number; email: string };
  org: { id: number; name: string; role: string };
  token: { id: number; name: string; prefix: string; secret: string };
  auth_header_example: string;
  mcp_url: string;
  discovery_url: string;
  manifest?: { mcp?: { tools?: { name: string; title: string }[] } };
}

function modeFromQuery(value: string | null): Mode {
  if (value === "register") return "register";
  if (value === "agent") return "agent";
  return "login";
}

export default function Auth() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<Mode>(() => modeFromQuery(params.get("mode")));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [agentName, setAgentName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [agentEmail, setAgentEmail] = useState("");
  const [agentResult, setAgentResult] = useState<AgentSignupResult | null>(null);

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, string> = { email: email.trim(), password };
      if (mode === "register") {
        if (displayName.trim()) payload.displayName = displayName.trim();
        if (orgName.trim()) payload.orgName = orgName.trim();
      }
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || data.error || "Those credentials were not accepted");
      }
      const data = await response.json();
      if (!data.token) throw new Error("No token came back — try again");
      localStorage.setItem("token", data.token);
      if (data.user?.email) localStorage.setItem("userEmail", data.user.email);
      navigate("/");
      window.location.reload();
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
    : mode === "register"
      ? "Create an organization"
      : mode === "agent"
        ? "Take a seat"
        : "Sign in";

  const subhead = agentResult
    ? "It is shown exactly once. Copy it into the agent's config before you leave this page."
    : mode === "register"
      ? "One organization, four surfaces, every person and agent on the same roll."
      : mode === "agent"
        ? "Open a seat for an AI agent — bearer-token auth, ready for MCP, REST and the connectors."
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
          <h1 className="font-display text-[2rem] leading-tight tracking-[-0.025em] text-ink sm:text-[2.4rem]">
            {heading}
          </h1>
          <p className="mt-2 mb-8 text-[1rem] leading-relaxed text-ink-muted text-pretty">{subhead}</p>

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
              <Field label="Email">
                <input
                  type="email"
                  className="draft-input w-full"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </Field>

              <Field label="Password" hint={mode === "register" ? "At least six characters" : undefined}>
                <input
                  type="password"
                  className="draft-input w-full font-mono"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
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

              <Submit busy={busy} disabled={!email || !password}>
                {mode === "login" ? "Sign in" : "Create the organization"}
              </Submit>

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

function Submit({
  busy,
  disabled,
  children,
}: {
  busy: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className={cn(
        "focus-ink group flex w-full items-center justify-center gap-2 border border-ink bg-ink px-5 py-3",
        "font-numeric text-[11px] uppercase tracking-[0.18em] text-parchment transition-all duration-150",
        "hover:-translate-x-px hover:-translate-y-px hover:bg-parchment hover:text-ink hover:shadow-stamp",
        "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-x-0 disabled:hover:translate-y-0",
        "disabled:hover:bg-ink disabled:hover:text-parchment disabled:hover:shadow-none"
      )}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="border border-vermilion/50 bg-vermilion/5 px-3 py-2 text-[0.9rem] text-vermilion">
      {children}
    </p>
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

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-rule pt-3">
      <div className="eyebrow mb-2">{label}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[0.8rem]">
      <span className="eyebrow text-[10px]">{k}</span>
      <span className={cn("truncate text-right text-ink", mono && "font-numeric")}>{v}</span>
    </div>
  );
}

function CopyRow({
  value,
  onCopy,
  copied,
  mono,
  subtle,
}: {
  value: string;
  onCopy: () => void;
  copied: boolean;
  mono?: boolean;
  subtle?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2 border px-2.5 py-1.5", subtle ? "border-rule bg-card" : "border-ink bg-parchment-deep/50")}>
      <code className={cn("flex-1 truncate text-[11px]", mono && "font-mono", subtle ? "text-ink-muted" : "text-ink")} title={value}>
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="focus-ink inline-flex shrink-0 items-center gap-1 border border-rule px-2 py-1 font-numeric text-[10px] uppercase tracking-[0.12em] transition-colors hover:border-ink hover:text-ink"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="eyebrow">{label}</span>
        {hint && <span className="text-[0.75rem] text-ink-muted">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
