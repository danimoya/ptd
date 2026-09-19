import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { listActions } from "@/lib/api";
import CopyBlock from "./CopyBlock";
import type { Role } from "../../../../db/schema";

const SURFACE_ORDER = ["overview", "plan", "track", "org"] as const;
const SURFACE_BLURB: Record<string, string> = {
  overview: "The ledger: backlog queries, app inventory, cross-app streams, KPIs.",
  plan: "The board: tasks, dependencies, streams, scheduling.",
  track: "The timer: time entries, breaks, templates, human vs agent totals.",
  org: "The organization: membership, integrations, identity.",
};

const ROLE_CHIP: Record<Role, string> = {
  member: "border-rule text-ink-muted",
  manager: "border-ink/50 text-ink",
  admin: "border-[#9a6a12]/60 text-[#9a6a12] dark:border-[#d6a243]/60 dark:text-[#d6a243]",
  owner: "border-vermilion/70 text-vermilion",
};

/**
 * The API reference, generated from the live registry rather than written by hand —
 * so it cannot drift from what the server actually exposes, and it shows the caller
 * exactly the subset their own role may run.
 */
export default function ApiTab() {
  const actions = useQuery({ queryKey: ["/api/actions"], queryFn: listActions });
  const origin = window.location.origin;

  const grouped = useMemo(() => {
    const rows = actions.data ?? [];
    const bySurface = new Map<string, typeof rows>();
    for (const a of rows) {
      const list = bySurface.get(a.surface) ?? [];
      list.push(a);
      bySurface.set(a.surface, list);
    }
    const known = SURFACE_ORDER.filter((s) => bySurface.has(s));
    const extra = [...bySurface.keys()].filter((s) => !(SURFACE_ORDER as readonly string[]).includes(s)).sort();
    return [...known, ...extra].map((surface) => ({
      surface,
      actions: [...bySurface.get(surface)!].sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [actions.data]);

  return (
    <div className="space-y-5">
      <section className="paper p-4">
        <div className="eyebrow text-[9px]">One registry, three faces</div>
        <h3 className="font-display text-xl tracking-tight mt-0.5 flex items-center gap-2">
          <BookOpen className="h-4 w-4" /> API and MCP tools
        </h3>
        <p className="text-sm font-serif text-ink-muted mt-1 max-w-prose">
          Every action below is reachable three ways with one role gate behind all of them: as an MCP tool over{" "}
          <code className="font-mono text-xs">POST /mcp</code>, as{" "}
          <code className="font-mono text-xs">POST /api/actions/&lt;name&gt;</code>, and from this web client. This page lists
          only what <b>your</b> role may call — an agent on a member token sees a shorter list.
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          {[
            { href: "/.well-known/ai-agent.json", label: "ai-agent.json" },
            { href: "/llms.txt", label: "llms.txt" },
            { href: "/api/actions", label: "/api/actions" },
          ].map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noreferrer noopener"
              className="stamp inline-flex items-center gap-1.5 hover:shadow-stamp transition-shadow focus-ink"
              data-testid={`link-${l.label}`}
            >
              {l.label}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ))}
        </div>
        <div className="mt-3">
          <CopyBlock
            body={`curl -sX POST ${origin}/api/actions/stats \\\n  -H 'Authorization: Bearer ptd_…' \\\n  -H 'Content-Type: application/json' -d '{}'`}
            label="calling an action over REST"
            testId="api-curl"
          />
        </div>
      </section>

      {actions.isLoading ? (
        <div className="py-12 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></div>
      ) : actions.error ? (
        <p className="py-12 text-center font-serif italic text-vermilion">{(actions.error as Error).message}</p>
      ) : (
        grouped.map((g) => (
          <section key={g.surface} className="paper-flat" data-testid={`api-surface-${g.surface}`}>
            <div className="px-3 py-2 border-b border-rule">
              <div className="flex items-center justify-between">
                <span className="microcaps">{g.surface}</span>
                <span className="eyebrow text-[9px] font-numeric">{g.actions.length}</span>
              </div>
              {SURFACE_BLURB[g.surface] ? <p className="text-xs font-serif italic text-ink-muted mt-0.5">{SURFACE_BLURB[g.surface]}</p> : null}
            </div>
            <ul className="divide-y divide-rule">
              {g.actions.map((a) => (
                <li key={a.name} className="px-3 py-2.5" data-testid={`api-action-${a.name}`}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <code className="font-mono text-sm">{a.name}</code>
                    <span className={cn("stamp shrink-0", ROLE_CHIP[a.requiredRole] ?? "border-rule")}>{a.requiredRole}+</span>
                    <span className="eyebrow text-[9px] ml-auto">{a.title}</span>
                  </div>
                  <p className="text-sm font-serif text-ink-muted mt-1">{a.description}</p>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
