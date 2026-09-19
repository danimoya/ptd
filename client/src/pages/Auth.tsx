import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Check, Copy, Loader2 } from "lucide-react";
import { StudioMasthead, StudioRibbon } from "@/components/StudioMasthead";
import { LandingSheets, SheetIndex } from "@/components/LandingSheets";
import { FloatingLoginBar } from "@/components/FloatingLoginBar";
import { DemoChronograph } from "@/components/DemoChronograph";
import { cn } from "@/lib/utils";

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

export default function Auth() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Agent self-service
  const [agentName, setAgentName] = useState("");
  const [agentEmail, setAgentEmail] = useState("");
  const [agentResult, setAgentResult] = useState<AgentSignupResult | null>(null);
  const [pastFold, setPastFold] = useState(false);
  const [barBusy, setBarBusy] = useState(false);

  const formRef = useRef<HTMLElement>(null);

  // Once the form plate has scrolled completely out of view, a short sign-in
  // form floats into the top navigation so the visitor never has to scroll back.
  useEffect(() => {
    const el = formRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setPastFold(entry.boundingClientRect.bottom <= 0),
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The closing call to action sends the visitor back up to the form with the
  // right tab already selected.
  const startWith = useCallback((next: "signin" | "register" | "agent") => {
    setAgentResult(null);
    setMode(next === "signin" ? "login" : next);
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    formRef.current?.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
  }, []);

  // Sign-in from the floating top bar. Same token hand-off as the form plate's
  // login path, without touching the shared form state.
  const barSignIn = async (loginEmail: string, loginPassword: string) => {
    setBarBusy(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        return {
          ok: false as const,
          message: (data.error as string) || "Authentication failed",
        };
      }
      const data = await response.json();
      if (!data.token) {
        return { ok: false as const, message: "No token received" };
      }
      localStorage.setItem("token", data.token);
      if (data.user?.email) localStorage.setItem("userEmail", data.user.email);
      navigate("/");
      window.location.reload();
      return { ok: true as const };
    } finally {
      setBarBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Authentication failed");
      }
      const data = await response.json();
      if (data.token) {
        localStorage.setItem("token", data.token);
        if (data.user?.email) localStorage.setItem("userEmail", data.user.email);
        navigate("/");
        window.location.reload();
      } else {
        throw new Error("No token received");
      }
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
      if (agentEmail.trim()) payload.email = agentEmail.trim();
      const res = await fetch("/api/agent/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
      }
      setAgentResult(body as AgentSignupResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not provision agent");
    } finally {
      setBusy(false);
    }
  };

  const ribbon = agentResult
    ? "Service account opened"
    : mode === "register"
      ? "New ledger"
      : mode === "agent"
        ? "Agent service account"
        : "Open ledger";

  const heading = agentResult
    ? "Save the token"
    : mode === "register"
      ? "Begin a ledger"
      : mode === "agent"
        ? "Open an agent account"
        : "Welcome back";

  const subhead = agentResult
    ? "It is shown exactly once. Copy it into your agent's config now."
    : mode === "register"
      ? "Create credentials and start keeping the hours."
      : mode === "agent"
        ? "Provision a service account for an AI agent — bearer-token auth, MCP-ready."
        : "Sign in to your ledger. Your hours are exactly where you left them.";

  return (
    <div className="w-full">
      <FloatingLoginBar
        visible={pastFold && !agentResult}
        busy={barBusy}
        onSignIn={barSignIn}
        onOpenFull={startWith}
      />
      <div className="min-h-screen w-full grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr]">
        {/* ─────────── LEFT — Editorial masthead pane ─────────── */}
        <aside className="relative overflow-hidden border-b lg:border-b-0 lg:border-r border-rule px-8 pt-12 md:px-16 md:pt-20 flex flex-col justify-between">
          <div className="reveal reveal-1 flex items-center justify-between gap-4">
            <StudioMasthead size="sm" />
            <span className="microcaps hidden md:inline">Hours ledger</span>
          </div>

          <div className="my-12 lg:my-14 max-w-2xl">
            <h2 className="font-display reveal reveal-2 text-5xl md:text-6xl xl:text-7xl leading-[0.95] tracking-tightest text-ink">
              Time the work.
              <br />
              Keep the{" "}
              <em className="italic text-vermilion">ledger</em>.
            </h2>
            <p className="reveal reveal-3 mt-7 text-lg text-ink-2 max-w-lg leading-relaxed text-pretty">
              A private chronicle of hours spent — live timers, retroactive
              entries and the totals that reconcile against them. For the people
              working the day and the agents you let log alongside them.
            </p>

            <DemoChronograph className="reveal reveal-4 mt-9 max-w-xl" />
          </div>

          <SheetIndex className="reveal reveal-5 -mx-8 md:-mx-16" />
        </aside>

        {/* ─────────── RIGHT — Form plate ─────────── */}
        <section
          id="start"
          ref={formRef}
          className="relative flex items-start justify-center px-6 py-12 md:px-12 md:py-16 bg-paper-2/60 scroll-mt-0"
        >
          <div className="w-full max-w-md reveal reveal-3 lg:sticky lg:top-12">
            <StudioRibbon label={ribbon} className="mb-6" />

            <h3 className="font-display text-4xl md:text-5xl tracking-tightest text-ink mb-2">
              {heading}
            </h3>
            <p className="text-ink-3 mb-8">{subhead}</p>

            {agentResult ? (
              <AgentResultPanel
                result={agentResult}
                onClose={() => {
                  setAgentResult(null);
                  setMode("login");
                  setAgentName("");
                  setAgentEmail("");
                }}
              />
            ) : mode === "agent" ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitAgent();
                }}
                className="space-y-5"
              >
                <div className="border border-rule bg-paper p-4 text-xs text-ink-3 leading-relaxed">
                  Open a service account for an AI agent. Returns a single bearer
                  token (<span className="font-mono">ttm_…</span>) it should send
                  on every MCP / REST call. The token is shown once. Discovery
                  lives at{" "}
                  <a
                    href="/.well-known/ai-agent.json"
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-oxford hover:underline"
                  >
                    /.well-known/ai-agent.json
                  </a>
                  .
                </div>

                <Field label="Agent name" hint="Free-form label, e.g. 'Helios Scribe'">
                  <input
                    className="draft-input w-full"
                    placeholder="Helios Scribe"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    required
                  />
                </Field>

                <Field
                  label="Email"
                  hint="Optional — for human takeover via password reset"
                >
                  <input
                    type="email"
                    className="draft-input w-full"
                    placeholder="ops@studio.cv"
                    value={agentEmail}
                    onChange={(e) => setAgentEmail(e.target.value)}
                    autoComplete="off"
                  />
                </Field>

                {error && (
                  <div className="border border-vermilion/40 bg-vermilion/10 px-3 py-2 text-sm font-serif italic text-vermilion">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy || !agentName.trim()}
                  className={cn(
                    "group relative w-full px-5 py-3 bg-ink text-paper font-medium",
                    "border border-ink transition-all duration-150",
                    "hover:bg-paper hover:text-ink hover:shadow-stamp hover:-translate-x-px hover:-translate-y-px",
                    "disabled:opacity-60 disabled:cursor-not-allowed",
                    "flex items-center justify-center gap-2"
                  )}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  <span className="microcaps !text-current">
                    Provision service account
                  </span>
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </button>

                <ModeSwitcher mode={mode} setMode={setMode} />
              </form>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
                className="space-y-5"
              >
                <Field label="Correspondence" hint="Used to sign in">
                  <input
                    type="email"
                    className="draft-input w-full"
                    placeholder="name@house.domain"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </Field>

                <Field
                  label="Secret hand"
                  hint={mode === "register" ? "At least six letters" : ""}
                >
                  <input
                    type="password"
                    className="draft-input w-full font-mono"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                  />
                </Field>

                {error && (
                  <div className="border border-vermilion/40 bg-vermilion/10 px-3 py-2 text-sm font-serif italic text-vermilion">
                    {error}
                  </div>
                )}

                <div className="pt-2 space-y-3">
                  <button
                    type="submit"
                    disabled={busy || !email || !password}
                    className={cn(
                      "group relative w-full px-5 py-3 bg-ink text-paper font-medium",
                      "border border-ink transition-all duration-150",
                      "hover:bg-paper hover:text-ink hover:shadow-stamp hover:-translate-x-px hover:-translate-y-px",
                      "disabled:opacity-60 disabled:cursor-not-allowed",
                      "flex items-center justify-center gap-2"
                    )}
                  >
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    <span className="microcaps !text-current">
                      {mode === "login" ? "Open the ledger" : "Begin your chronicle"}
                    </span>
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </button>

                  <ModeSwitcher mode={mode} setMode={setMode} />
                </div>
              </form>
            )}
          </div>
        </section>
      </div>

      <LandingSheets onStart={startWith} />
    </div>
  );
}

function ModeSwitcher({
  mode,
  setMode,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
}) {
  return (
    <div className="flex flex-col gap-1 pt-1">
      {mode !== "login" && (
        <button
          type="button"
          onClick={() => setMode("login")}
          className="w-full text-sm text-ink-3 hover:text-ink transition-colors py-1"
        >
          Already have a ledger? Sign in instead →
        </button>
      )}
      {mode !== "register" && (
        <button
          type="button"
          onClick={() => setMode("register")}
          className="w-full text-sm text-ink-3 hover:text-ink transition-colors py-1"
        >
          Need a ledger? Open one →
        </button>
      )}
      {mode !== "agent" && (
        <button
          type="button"
          onClick={() => setMode("agent")}
          className="w-full text-sm text-ink-3 hover:text-oxford transition-colors py-1"
        >
          Are you an AI agent? Open a service account →
        </button>
      )}
    </div>
  );
}

function AgentResultPanel({
  result,
  onClose,
}: {
  result: AgentSignupResult;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<"token" | "header" | "discovery" | null>(
    null
  );
  const copy = async (
    key: "token" | "header" | "discovery",
    value: string
  ) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* clipboard might be blocked — value is on screen */
    }
  };

  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://ttm.foor.tech";
  const mcpUrl = result.mcp_url.startsWith("http")
    ? result.mcp_url
    : `${origin}${result.mcp_url}`;
  const discoveryUrl = `${origin}${result.discovery_url}`;
  const toolCount = result.manifest?.mcp?.tools?.length ?? 0;

  return (
    <div className="space-y-5">
      <div className="border border-vermilion/60 bg-vermilion/5 p-4 text-xs text-ink-2 leading-relaxed">
        <span className="microcaps text-vermilion block mb-1">One-time</span>
        The bearer token below is shown <em>only on this screen</em>. After you
        leave it cannot be recovered — mint a new one if it is lost.
      </div>

      <Section label="Account">
        <KV k="email" v={result.user.email} />
        <KV k="organization" v={`${result.org.name} (id ${result.org.id}, ${result.org.role})`} />
      </Section>

      <Section label="Bearer token">
        <CopyRow
          mono
          value={result.token.secret}
          copied={copied === "token"}
          onCopy={() => copy("token", result.token.secret)}
        />
        <CopyRow
          mono
          subtle
          value={result.auth_header_example}
          copied={copied === "header"}
          onCopy={() => copy("header", result.auth_header_example)}
        />
      </Section>

      <Section label="Endpoints">
        <KV k="MCP" v={mcpUrl} mono />
        <KV k="Discovery" v={result.discovery_url} mono />
        <CopyRow
          mono
          subtle
          value={discoveryUrl}
          copied={copied === "discovery"}
          onCopy={() => copy("discovery", discoveryUrl)}
        />
      </Section>

      {toolCount > 0 && (
        <Section label={`Tools available (${toolCount})`}>
          <ul className="text-xs text-ink-2 space-y-1">
            {result.manifest!.mcp!.tools!.map((t) => (
              <li key={t.name} className="flex gap-2">
                <span className="font-mono text-oxford whitespace-nowrap">
                  {t.name}
                </span>
                <span className="text-ink-3 truncate">— {t.title}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <button
        type="button"
        onClick={onClose}
        className={cn(
          "group relative w-full px-5 py-3 bg-ink text-paper font-medium",
          "border border-ink transition-all duration-150",
          "hover:bg-paper hover:text-ink hover:shadow-stamp hover:-translate-x-px hover:-translate-y-px",
          "flex items-center justify-center gap-2"
        )}
      >
        <span className="microcaps !text-current">I have saved the token</span>
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </button>
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

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-ink-3 microcaps">{k}</span>
      <span className={cn("text-ink truncate text-right", mono && "font-mono")}>
        {v}
      </span>
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
    <div
      className={cn(
        "flex items-center gap-2 border px-2.5 py-1.5",
        subtle ? "border-rule bg-paper" : "border-ink bg-paper-2"
      )}
    >
      <code
        className={cn(
          "flex-1 truncate text-[11px]",
          mono && "font-mono",
          subtle ? "text-ink-3" : "text-ink"
        )}
        title={value}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className={cn(
          "shrink-0 inline-flex items-center gap-1 text-[11px] microcaps px-2 py-1 border border-rule",
          "hover:border-ink hover:text-ink transition-colors"
        )}
      >
        {copied ? (
          <>
            <Check className="h-3 w-3" /> copied
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" /> copy
          </>
        )}
      </button>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="microcaps">{label}</span>
        {hint && <span className="text-[11px] text-ink-4">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
