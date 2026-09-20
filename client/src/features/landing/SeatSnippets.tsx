// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Form, QuietButton } from "./chrome";

/* ─────────────────────────────────────────────────────────────────────────
 * Glimpse V — give your agent a seat.
 *
 * Three steps, in order, so the numbering here is a sequence and not
 * decoration: the agent registers itself with an invite code, the client
 * gets pointed at /mcp, and the token proves which tools it may call.
 * ───────────────────────────────────────────────────────────────────────── */

export type Client = "code" | "desktop" | "cursor";

const ORIGIN = "https://ptd.example.com";
const INVITE = "f9d9e8013717f6c0";

export const REGISTER = [
  `curl -sX POST ${ORIGIN}/api/agent/register \\`,
  "  -H 'Content-Type: application/json' \\",
  `  -d '{"name":"Nightly Triage Bot","inviteCode":"${INVITE}"}'`,
].join("\n");

export const VERIFY = [
  `curl -sX POST ${ORIGIN}/mcp \\`,
  "  -H 'Authorization: Bearer ptd_…' \\",
  "  -H 'Content-Type: application/json' \\",
  "  -H 'Accept: application/json, text/event-stream' \\",
  `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
].join("\n");

export const CLIENTS: Record<Client, { label: string; where: string; lang: string; snippet: string }> = {
  code: {
    label: "Claude Code",
    where: "run it in the project",
    lang: "bash",
    snippet: [
      `claude mcp add --transport http ptd ${ORIGIN}/mcp \\`,
      '  --header "Authorization: Bearer ptd_…"',
    ].join("\n"),
  },
  desktop: {
    label: "Claude Desktop",
    where: "claude_desktop_config.json",
    lang: "json",
    snippet: [
      "{",
      '  "mcpServers": {',
      '    "ptd": {',
      '      "type": "http",',
      `      "url": "${ORIGIN}/mcp",`,
      '      "headers": { "Authorization": "Bearer ptd_…" }',
      "    }",
      "  }",
      "}",
    ].join("\n"),
  },
  cursor: {
    label: "Cursor",
    where: "~/.cursor/mcp.json",
    lang: "json",
    snippet: [
      "{",
      '  "mcpServers": {',
      '    "ptd": {',
      `      "url": "${ORIGIN}/mcp",`,
      '      "headers": { "Authorization": "Bearer ptd_…" }',
      "    }",
      "  }",
      "}",
    ].join("\n"),
  },
};

export default function SeatSnippets({ className }: { className?: string }) {
  const [client, setClient] = useState<Client>("code");
  const active = CLIENTS[client];

  return (
    <Form title="Give your agent a seat" meta="member role · same gate as a person" className={className}>
      <ol className="space-y-5">
        <Step n={1} title="The agent registers itself" note={`invite code · ${INVITE}`}>
          <CodeBlock label="bash" code={REGISTER} />
          <p className="mt-2 text-[0.9rem] leading-relaxed text-ink-muted">
            It comes back with a <span className="font-numeric text-[0.8rem]">ptd_</span> token and a member seat
            in your organization — no special path, the same role gate a person gets.
          </p>
        </Step>

        <Step n={2} title="Point the client at the seat">
          <div className="mb-2 flex flex-wrap gap-1">
            {(Object.keys(CLIENTS) as Client[]).map((k) => (
              <QuietButton key={k} active={client === k} onClick={() => setClient(k)}>
                {CLIENTS[k].label}
              </QuietButton>
            ))}
          </div>
          <CodeBlock label={`${active.lang} · ${active.where}`} code={active.snippet} testId="seat-snippet" />
        </Step>

        <Step n={3} title="Check what it may call" note="85 tools, filtered by role">
          <CodeBlock label="bash" code={VERIFY} />
        </Step>
      </ol>
    </Form>
  );
}

function Step({
  n,
  title,
  note,
  children,
}: {
  n: number;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="border-t border-rule pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-display text-[1.15rem] tracking-[-0.015em] text-ink">
          <span className="font-numeric mr-2 text-[11px] tabular-nums text-vermilion">{n}</span>
          {title}
        </h3>
        {note && <span className="font-numeric text-[10px] text-ink-muted">{note}</span>}
      </div>
      <div className="mt-2.5">{children}</div>
    </li>
  );
}

function CodeBlock({ label, code, testId }: { label: string; code: string; testId?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be blocked — the snippet is on screen either way */
    }
  };

  return (
    <div className="border border-rule bg-parchment-deep/50">
      <div className="flex items-center justify-between gap-3 border-b border-rule px-3 py-1.5">
        <span className="font-numeric truncate text-[10px] uppercase tracking-[0.12em] text-ink-muted">{label}</span>
        <button
          type="button"
          onClick={copy}
          className={cn(
            "focus-ink inline-flex shrink-0 items-center gap-1 font-numeric text-[10px] uppercase tracking-[0.12em]",
            copied ? "text-vermilion" : "text-ink-muted hover:text-ink"
          )}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre
        data-testid={testId}
        className="nice-scroll overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-ink"
      >
        {code}
      </pre>
    </div>
  );
}
