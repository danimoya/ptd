import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Loader2, PlugZap, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { getCurrentOrg, getInviteCode } from "@/lib/api";
import CopyBlock from "./CopyBlock";
import Explainer from "./Explainer";
import { Hint } from "./Hint";
import { buildSnippets, TOKEN_PLACEHOLDER } from "./snippets";
import { probeMcp, type McpProbeResult } from "./api";
import HookPack from "./usage/HookPack";
import ProviderCard from "./usage/ProviderCard";

/**
 * Agent onboarding. Everything on this tab is a real, runnable artefact: the
 * invite code is this org's, the origin is where the page is served from, and the
 * test button sends the same JSON-RPC request an MCP client would.
 */
export default function AgentsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [agentName, setAgentName] = useState("");
  const [token, setToken] = useState("");
  const [probe, setProbe] = useState<McpProbeResult | null>(null);

  const org = useQuery({ queryKey: ["/api/orgs/current"], queryFn: getCurrentOrg });
  // POST with regenerate:false is idempotent — it mints a code the first time and
  // returns the existing one after that, so reading it is safe on mount.
  const code = useQuery({ queryKey: ["/api/orgs/current/invite-code"], queryFn: () => getInviteCode(false) });

  const regenerate = useMutation({
    mutationFn: () => getInviteCode(true),
    onSuccess: (data) => {
      qc.setQueryData(["/api/orgs/current/invite-code"], data);
      qc.invalidateQueries({ queryKey: ["/api/orgs/current"] });
      toast({ title: "Invite code regenerated", description: "The previous code stops working immediately. Agents already registered keep their tokens." });
    },
    onError: (err: Error) => toast({ title: "Could not regenerate", description: err.message, variant: "destructive" }),
  });

  const test = useMutation({
    mutationFn: () => probeMcp(token),
    onSuccess: (result) => {
      setProbe(result);
      if (result.ok) toast({ title: "Connected", description: `${result.toolCount} tools available to this token.` });
      else toast({ title: "Connection failed", description: result.error ?? `HTTP ${result.status}`, variant: "destructive" });
    },
  });

  const inviteCode = code.data?.inviteCode ?? org.data?.inviteCode ?? "";
  const origin = window.location.origin;
  const snippets = buildSnippets({ origin, inviteCode: inviteCode || "<invite-code>", token, agentName });

  return (
    <div className="space-y-5">
      <Explainer
        testId="agents-explainer"
        why={
          <>
            An agent is a teammate, not a plug-in: it takes a seat, holds a role and carries its own token, and everything it
            does lands in the same ledger as your people's work. The invite code below is how an agent lets itself in — its role
            then decides which parts of PTD it can even see. Time an agent logs is stamped as an agent's, and can carry the
            tokens and dollars it spent, so you can read what the robots cost you next to what they finished.
          </>
        }
        technical={
          <>
            <li>
              <code>POST /api/agent/register {"{ name, inviteCode }"}</code> creates the seat and answers once with a{" "}
              <code>ptd_…</code> bearer token. A code-based registration always joins as <code>member</code> — it can never mint
              itself a higher role.
            </li>
            <li>Regenerating the code invalidates the old one immediately; agents that already registered keep their tokens and their seats.</li>
            <li>
              The agent then speaks MCP over Streamable HTTP at <code>POST /mcp</code>. The tool list is filtered by its role, so
              a member-token agent is offered fewer tools than a manager one.
            </li>
            <li>
              Discovery lives at <code>/.well-known/ai-agent.json</code>. Claude.ai and ChatGPT connectors use OAuth 2.1 instead
              of a pasted token — metadata at <code>/.well-known/oauth-authorization-server</code>.
            </li>
            <li>
              “Test connection” POSTs a JSON-RPC <code>tools/list</code> to <code>/mcp</code> with the token in the field above.
              It reads; it writes nothing.
            </li>
            <li>
              Time logged by an agent is stamped <code>entry_source = "agent"</code> by the server, not by the agent, and may
              carry token counts and USD cost. Monthly per-stream budgets (<code>streams.agent_budget_usd</code>) are what the
              budget alerts measure against — and in <code>enforce</code> mode what <code>next_task</code> refuses work over.
            </li>
            <li>
              Those token counts are self-reported, so PTD keeps a second set of columns for what somebody else measured:{" "}
              <code>time_entry.attest</code> writes <code>verifiedTokens</code> / <code>verifiedCostUsd</code> /{" "}
              <code>verifiedSource</code>. The hook pack and the CI reporters below fill them in; the “Verified usage” section
              reconciles the lot against the provider's own billing.
            </li>
          </>
        }
      />

      {/* ---------- invite code ---------- */}
      <section className="paper p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="eyebrow text-[9px]">Invite code</div>
            <h3 className="font-display text-xl tracking-tight mt-0.5">How an agent <span className="italic">joins</span></h3>
            <p className="text-sm font-serif text-ink-muted mt-1 max-w-prose">
              An agent registers itself with this code and lands as an ordinary <b>member</b> — same role gate as a human, no special path.
            </p>
          </div>
          <Hint
            side="left"
            text="Mints a new invite code and kills the old one on the spot. Agents already registered keep working; anything still holding the old code cannot join."
          >
            <button
              onClick={() => regenerate.mutate()}
              disabled={regenerate.isPending}
              className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 border border-vermilion/60 text-vermilion hover:bg-vermilion hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
              data-testid="regenerate-invite-code"
            >
              {regenerate.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              <span className="eyebrow text-[10px] !text-current">regenerate</span>
            </button>
          </Hint>
        </div>
        <div className="mt-3">
          {code.isLoading ? (
            <div className="h-10 bg-ink/10 rounded-sm animate-pulse" />
          ) : inviteCode ? (
            <CopyBlock body={inviteCode} testId="invite-code" />
          ) : (
            <p className="font-serif italic text-ink-muted text-sm">No code yet — regenerate to mint one.</p>
          )}
        </div>
      </section>

      {/* ---------- snippets ---------- */}
      <section className="space-y-3">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="block">
            <span className="eyebrow text-[9px]">agent name — used in the snippets</span>
            <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Nightly Triage Bot" className="draft-input w-full mt-1 text-sm focus-ink" data-testid="agent-name" />
          </label>
          <label className="block">
            <span className="eyebrow text-[9px] inline-flex items-center gap-1.5">
              token — paste one to make the snippets runnable
              <Hint text="Only filled into the snippets in your browser. Nothing is sent anywhere until you press Test connection." />
            </span>
            <input
              value={token}
              onChange={(e) => { setToken(e.target.value); setProbe(null); }}
              placeholder={TOKEN_PLACEHOLDER}
              spellCheck={false}
              autoComplete="off"
              className="draft-input w-full mt-1 text-sm font-mono focus-ink"
              data-testid="agent-token"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Hint text="Asks /mcp for the tool list with the token above — a read, never a write. It proves the token works and shows exactly which tools that role may call.">
            <button
              onClick={() => test.mutate()}
              disabled={test.isPending || !token.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
              data-testid="test-connection"
            >
              {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
              <span className="eyebrow text-[10px] !text-current">test connection</span>
            </button>
          </Hint>
          {probe ? (
            <span
              className={cn("inline-flex items-center gap-1.5 text-sm font-serif", probe.ok ? "text-sage" : "text-vermilion")}
              data-testid="probe-result"
            >
              {probe.ok ? <Check className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
              {probe.ok ? `${probe.toolCount} tools available` : probe.error ?? `HTTP ${probe.status}`}
            </span>
          ) : (
            <span className="eyebrow text-[9px]">POSTs a JSON-RPC tools/list to {origin}/mcp</span>
          )}
        </div>

        {probe?.ok && probe.tools ? (
          <div className="paper-flat p-3">
            <div className="eyebrow text-[9px] mb-1.5">tools this token may call</div>
            <div className="flex flex-wrap gap-1">
              {probe.tools.map((t) => (
                <span key={t} className="stamp border-rule font-mono normal-case tracking-normal">{t}</span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-2 min-w-0">
          {snippets.map((s) => (
            <div key={s.id} className="paper-flat p-3 min-w-0" data-testid={`snippet-${s.id}`}>
              <div className="flex items-baseline gap-2">
                <Bot className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                <span className="microcaps">{s.title}</span>
                <span className="stamp border-rule text-ink-muted ml-auto shrink-0">{s.lang}</span>
              </div>
              <p className="text-xs font-serif italic text-ink-muted mt-1.5 mb-2">{s.note}</p>
              <CopyBlock body={s.body} testId={`snippet-body-${s.id}`} />
            </div>
          ))}
        </div>
      </section>

      {/* ---------- verified usage ---------- */}
      <div className="rule-t pt-5">
        <div className="eyebrow text-[9px]">Verified usage</div>
        <h3 className="font-display text-xl tracking-tight mt-0.5">
          Not the agent&apos;s <span className="italic">word</span>
        </h3>
        <p className="text-sm font-serif text-ink-muted mt-1 max-w-prose">
          An agent reports its own tokens and its own dollars. These two mechanisms let something else say the same number: a
          hook that read the session transcript, a build that wrapped the run, or the provider&apos;s own invoice for the month.
        </p>
      </div>

      <ProviderCard />

      <HookPack origin={origin} token={token} />
    </div>
  );
}
