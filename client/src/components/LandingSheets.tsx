import { useEffect, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Everything below the sign-in fold on the TimeTracker landing sheet.
 *
 * Shares the Kanttban landing vocabulary — ruled rows, numbered sequences,
 * an ink config plate, correspondence columns — so the two companion products
 * read as one document set. Content is specific to the hours ledger: the
 * board→ledger hand-off, agent self-service, and the MCP surface.
 */

const REPO_URL = "https://github.com/danimoya/timetracker-mobile";
const KANTTBAN_URL = "https://kanttban.foor.tech";
const HELIOSDB_URL = "https://heliosdb.com";

/* ── Section scaffolding ─────────────────────────────────────────────── */

function Sheet({
  id,
  index,
  title,
  lede,
  children,
}: {
  id: string;
  index: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="border-t border-ink scroll-mt-4">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-16 md:py-24">
        <header className="max-w-2xl">
          <div className="flex items-baseline gap-3 mb-4">
            <span className="stamp">{index}</span>
            <span className="h-px flex-1 bg-rule" />
          </div>
          <h2 className="font-display text-3xl md:text-5xl tracking-tightest text-ink leading-[1.03] text-balance">
            {title}
          </h2>
          {lede && (
            <p className="mt-5 text-base md:text-lg text-ink-2 leading-relaxed text-pretty">
              {lede}
            </p>
          )}
        </header>
        <div className="mt-10 md:mt-14">{children}</div>
      </div>
    </section>
  );
}

/* ── Sheet index — sits at the foot of the hero as the scroll cue ────── */

const INDEX = [
  { href: "#ledger", label: "The ledger" },
  { href: "#agents", label: "Agents & MCP" },
  { href: "#kanttban", label: "Kanttban" },
  { href: "#source", label: "Source" },
];

export function SheetIndex({ className }: { className?: string }) {
  return (
    <nav
      aria-label="Sections of this page"
      className={cn("border-t border-ink", className)}
    >
      <ul className="grid grid-cols-2 sm:grid-cols-4">
        {INDEX.map((s) => (
          <li key={s.href} className="border-r border-rule last:border-r-0">
            <a
              href={s.href}
              className="block px-3 py-3 text-sm text-ink-2 hover:text-ink hover:bg-paper-2 transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ochre/60"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ── 1. The ledger ───────────────────────────────────────────────────── */

const LEDGER = [
  {
    term: "A clock, not a guess",
    copy: "Start a timer and close it when the work ends. Every session is stored to the second and attributed to a customer, a project and a task.",
  },
  {
    term: "Retroactive entries",
    copy: "Forgot to start it? Log a finished session with explicit check-in and check-out times — the same rows the live timer writes.",
  },
  {
    term: "Totals that reconcile",
    copy: "Minutes per project or per task, plus today's summary broken down by project. The numbers come from closed sessions only, so they add up.",
  },
  {
    term: "Invoices, generated",
    copy: "Turn the ledger into a PDF invoice from the reporting screen. What you see in the hours is what lands on the invoice.",
  },
  {
    term: "Workspaces that stay apart",
    copy: "Every account belongs to an organization. Projects, customers and members are scoped to it and nothing leaks between teams.",
  },
  {
    term: "Cross-system references",
    copy: "Tasks carry a stable external reference, so a card in another system and a task here always name the same piece of work.",
  },
];

function LedgerSheet() {
  return (
    <dl className="grid md:grid-cols-2 gap-x-12">
      {LEDGER.map((f) => (
        <div key={f.term} className="border-t border-rule py-5">
          <dt className="font-display text-xl text-ink leading-snug">{f.term}</dt>
          <dd className="mt-1.5 text-sm text-ink-3 leading-relaxed max-w-[52ch]">
            {f.copy}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ── 2. Agents & MCP ─────────────────────────────────────────────────── */

interface ManifestTool {
  name: string;
  title: string;
}

const FALLBACK_TOOLS: ManifestTool[] = [
  { name: "whoami", title: "Identify the calling token" },
  { name: "project.list", title: "List projects" },
  { name: "task.list", title: "List tasks" },
  { name: "task.find_or_create", title: "Find or create a task by external ref" },
  { name: "time_entry.start", title: "Start a timer" },
  { name: "time_entry.stop", title: "Stop the active timer" },
  { name: "time_entry.log_past", title: "Log a completed session retroactively" },
  { name: "time_entry.list", title: "List recent time entries" },
  { name: "task.totals", title: "Logged minutes per task" },
  { name: "today_summary", title: "Today's summary" },
];

/**
 * The tool roster is read from the same public manifest an agent reads, so the
 * page cannot drift from the server. Falls back to a baked-in list when the
 * fetch fails, so the section is never empty.
 */
function useManifestTools(): ManifestTool[] {
  const [tools, setTools] = useState<ManifestTool[]>(FALLBACK_TOOLS);

  useEffect(() => {
    let live = true;
    fetch("/.well-known/ai-agent.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        const list = m?.mcp?.tools;
        if (live && Array.isArray(list) && list.length > 0) {
          setTools(
            list.map((t: ManifestTool) => ({ name: t.name, title: t.title }))
          );
        }
      })
      .catch(() => {
        /* keep the fallback */
      });
    return () => {
      live = false;
    };
  }, []);

  return tools;
}

const STEPS = [
  {
    n: "01",
    term: "Read the manifest",
    copy: "One public GET, no token. It lists every tool, endpoint and field the agent will need.",
    code: "GET /.well-known/ai-agent.json",
  },
  {
    n: "02",
    term: "Open an account",
    copy: "A name is enough. Back comes a single bearer token, shown once, and an organization of its own. Pass an invite token instead and it joins your team.",
    code: "POST /api/agent/register",
  },
  {
    n: "03",
    term: "Connect a client",
    copy: "Anything that speaks the Model Context Protocol. Claude, ChatGPT, Cursor, or your own code.",
    code: "POST /mcp",
  },
  {
    n: "04",
    term: "Log the hours",
    copy: "Start and stop timers, log past sessions, and read totals — same ledger, same organization, same rules as the web app.",
    code: "Authorization: Bearer ttm_…",
  },
];

type ClientKey = "claude-code" | "claude-desktop" | "chatgpt" | "cursor";

const CLIENTS: { key: ClientKey; label: string; where: string }[] = [
  { key: "claude-code", label: "Claude Code", where: "Run this in your project." },
  {
    key: "claude-desktop",
    label: "Claude Desktop",
    where: "Add to claude_desktop_config.json, then restart the app.",
  },
  {
    key: "chatgpt",
    label: "ChatGPT",
    where: "Add a custom connector in developer mode and paste these two values.",
  },
  { key: "cursor", label: "Cursor", where: "Save as .cursor/mcp.json in your project." },
];

function snippetFor(key: ClientKey, mcpUrl: string): string {
  switch (key) {
    case "claude-code":
      return [
        "claude mcp add timetracker \\",
        "  --transport http \\",
        `  ${mcpUrl} \\`,
        '  --header "Authorization: Bearer ttm_…"',
      ].join("\n");
    case "chatgpt":
      return [`Server URL    ${mcpUrl}`, "Authorization Bearer ttm_…"].join("\n");
    case "claude-desktop":
    case "cursor":
      return JSON.stringify(
        {
          mcpServers: {
            timetracker: {
              type: "http",
              url: mcpUrl,
              headers: { Authorization: "Bearer ttm_…" },
            },
          },
        },
        null,
        2
      );
  }
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard blocked — the value is on screen to select by hand */
        }
      }}
      className="shrink-0 inline-flex items-center gap-1.5 border border-paper/35 px-2.5 py-1 text-[11px] microcaps !text-paper/80 hover:!text-paper hover:border-paper transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ochre/70"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

function AgentsSheet() {
  const tools = useManifestTools();
  const [client, setClient] = useState<ClientKey>("claude-code");

  const mcpUrl = useMemo(() => {
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://ttm.foor.tech";
    return `${origin}/mcp`;
  }, []);

  const active = CLIENTS.find((c) => c.key === client)!;
  const snippet = snippetFor(client, mcpUrl);

  return (
    <div className="space-y-14">
      {/* The four steps are a genuine sequence, so they are numbered. */}
      <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-px bg-rule border border-rule">
        {STEPS.map((s) => (
          <li key={s.n} className="bg-paper p-5 flex flex-col">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-oxford tabular-nums">{s.n}</span>
              <span className="h-px flex-1 bg-rule" />
            </div>
            <h3 className="font-display text-xl mt-3 text-ink leading-snug">
              {s.term}
            </h3>
            <p className="mt-2 text-sm text-ink-3 leading-relaxed flex-1">{s.copy}</p>
            <code className="mt-4 block font-mono text-[11px] text-oxford break-all">
              {s.code}
            </code>
          </li>
        ))}
      </ol>

      {/* Config plate */}
      <div>
        <div
          role="tablist"
          aria-label="Choose your client"
          className="flex flex-wrap border border-ink border-b-0 bg-paper-2"
        >
          {CLIENTS.map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={client === c.key}
              onClick={() => setClient(c.key)}
              className={cn(
                "px-4 py-2.5 text-sm border-r border-rule transition-colors",
                "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ochre/60 focus-visible:z-10",
                client === c.key
                  ? "bg-ink text-paper"
                  : "text-ink-3 hover:text-ink hover:bg-paper"
              )}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="border border-ink bg-ink">
          <div className="flex items-center justify-between gap-4 px-4 py-2 border-b border-paper/15">
            <span className="text-xs text-paper/70 leading-snug">{active.where}</span>
            <CopyButton value={snippet} label="Copy" />
          </div>
          <pre className="overflow-x-auto nice-scroll px-4 py-4 font-mono text-[12px] leading-relaxed text-paper/90">
            <code>{snippet}</code>
          </pre>
        </div>

        <p className="mt-3 text-sm text-ink-3 max-w-[60ch]">
          The token is the one handed back when the agent registers. The same
          token authenticates the REST API at{" "}
          <span className="font-mono text-xs">/api</span>, so a plain HTTP
          client can log time without speaking MCP at all.
        </p>
      </div>

      {/* Live tool roster */}
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-5">
          <h3 className="font-display text-2xl text-ink">
            What a connected agent can do
          </h3>
          <span className="h-px flex-1 bg-rule hidden sm:block" />
          <span className="font-mono text-xs text-ink-4 tabular-nums shrink-0 whitespace-nowrap">
            {tools.length} tools
          </span>
        </div>
        <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-10">
          {tools.map((t) => (
            <li
              key={t.name}
              className="border-t border-rule py-2.5 flex flex-col gap-0.5"
            >
              <code className="font-mono text-[12px] text-oxford break-all">
                {t.name}
              </code>
              <span className="text-xs text-ink-3">{t.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── 3. Kanttban hand-off ────────────────────────────────────────────── */

const MAPPING = [
  { left: "Stream", right: "Project" },
  { left: "Card", right: "Task" },
  { left: "Card reference", right: "External reference" },
];

function KanttbanSheet() {
  return (
    <div className="grid lg:grid-cols-[1fr_1fr] gap-10 lg:gap-16 items-start">
      <div className="max-w-[58ch] space-y-5 text-base text-ink-2 leading-relaxed">
        <p>
          Kanttban plans the work. TimeTracker, its companion app, records the
          hours against it — on a phone, in a browser, or from an agent that
          never opens either one.
        </p>
        <p>
          Both sides run their own agent account and their own MCP server, and
          they agree on how a card maps to a task. An agent calls{" "}
          <code className="font-mono text-sm text-olive">task.find_or_create</code>{" "}
          here the first time it touches a card, passing the card's{" "}
          <span className="font-mono text-xs">jiraId</span> as the external
          reference, then logs time against the task it gets back. Nothing gets
          typed in twice.
        </p>
        <p>
          <a
            href={KANTTBAN_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 border border-ink bg-paper px-4 py-2.5 text-sm text-ink transition-all duration-150 hover:bg-ink hover:text-paper hover:shadow-stamp hover:-translate-x-px hover:-translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ochre/60"
          >
            Open Kanttban
            <span aria-hidden className="font-mono text-xs opacity-70 hidden sm:inline">
              kanttban.foor.tech
            </span>
          </a>
        </p>
      </div>

      {/* Correspondence columns, joined by leader rules */}
      <div className="border border-rule bg-card">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center px-5 py-3 border-b border-rule">
          <span className="microcaps">Kanttban</span>
          <span className="w-8" />
          <span className="microcaps text-right !text-olive">TimeTracker</span>
        </div>
        {MAPPING.map((m) => (
          <div
            key={m.left}
            className="grid grid-cols-[1fr_auto_1fr] items-center px-5 py-4 border-b border-rule/60 last:border-b-0"
          >
            <span className="font-display text-lg text-ink">{m.left}</span>
            <span aria-hidden className="w-8 border-t border-dashed border-ink-4" />
            <span className="font-display text-lg text-olive text-right">
              {m.right}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 4. Source ───────────────────────────────────────────────────────── */

function SourceSheet() {
  return (
    <div className="space-y-12">
      <div className="max-w-[60ch] space-y-5 text-base text-ink-2 leading-relaxed">
        <p>
          TimeTracker is MIT licensed. Read it, fork it, run it on your own
          machine, keep your hours on hardware you control.
        </p>
        <p>
          One process serves the API and the app on a single port. One database
          speaks the PostgreSQL wire protocol. Give it a database URL and a JWT
          secret and it runs — no queue, no broker, nothing to rent by the month.
        </p>
        <p>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 border border-ink bg-paper px-4 py-2.5 text-sm text-ink transition-all duration-150 hover:bg-ink hover:text-paper hover:shadow-stamp hover:-translate-x-px hover:-translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ochre/60"
          >
            Read the source
            <span aria-hidden className="font-mono text-xs opacity-70 hidden sm:inline">
              github.com/danimoya/timetracker-mobile
            </span>
          </a>
        </p>
      </div>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-px bg-rule border-y border-ink">
        {[
          { k: "Server", v: "Express · TypeScript" },
          { k: "Client", v: "React · Vite · Tailwind" },
          { k: "Data", v: "Drizzle ORM · PostgreSQL wire" },
          { k: "Interfaces", v: "Web · REST · MCP" },
        ].map((r) => (
          <div key={r.k} className="bg-paper px-4 py-5">
            <dt className="microcaps">{r.k}</dt>
            <dd className="mt-2 font-mono text-xs text-ink-2 leading-relaxed">
              {r.v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ── Closing call to action + title block ────────────────────────────── */

function TitleBlock({ onStart }: { onStart: (mode: "register" | "agent") => void }) {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-ink">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-16 md:py-20">
        <div className="grid lg:grid-cols-[1fr_auto] gap-10 items-end">
          <div>
            <h2 className="font-display text-3xl md:text-4xl tracking-tightest text-ink text-balance max-w-lg leading-[1.05]">
              Open a ledger and start the first timer.
            </h2>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => onStart("register")}
                className="px-5 py-3 border border-ink bg-ink text-paper transition-all duration-150 hover:bg-paper hover:text-ink hover:shadow-stamp hover:-translate-x-px hover:-translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ochre/60"
              >
                <span className="microcaps !text-current">Open a ledger</span>
              </button>
              <button
                type="button"
                onClick={() => onStart("agent")}
                className="px-5 py-3 border border-ink bg-paper text-ink transition-all duration-150 hover:shadow-stamp hover:-translate-x-px hover:-translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ochre/60"
              >
                <span className="microcaps !text-current">Open an agent account</span>
              </button>
            </div>
          </div>

          {/* Drafting title block — the identifying stamp at the foot of a sheet */}
          <dl className="border border-ink bg-card min-w-[16rem]">
            {[
              { k: "Sheet", v: <>TimeTracker · {year}</> },
              { k: "Licence", v: "MIT" },
              {
                k: "Powered by",
                v: (
                  <a
                    href={HELIOSDB_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-oxford hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ochre/60"
                  >
                    HeliosDB-Nano
                  </a>
                ),
              },
              { k: "Set in", v: "Fraunces · JetBrains Mono" },
            ].map((r, i) => (
              <div
                key={i}
                className="flex items-baseline justify-between gap-8 px-4 py-2.5 border-b border-rule last:border-b-0"
              >
                <dt className="microcaps">{r.k}</dt>
                <dd className="font-mono text-xs text-ink-2 text-right">{r.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </footer>
  );
}

/* ── Export ──────────────────────────────────────────────────────────── */

export function LandingSheets({
  onStart,
}: {
  onStart: (mode: "register" | "agent") => void;
}) {
  return (
    <div className="bg-paper">
      <Sheet
        id="ledger"
        index="Ledger"
        title="Every hour, entered once and accounted for."
        lede="TimeTracker keeps a running ledger of the work day — live timers, retroactive entries and the totals that reconcile against them."
      >
        <LedgerSheet />
      </Sheet>

      <Sheet
        id="agents"
        index="Agents"
        title="Software gets an account, not a timesheet of its own."
        lede="An agent signs itself up, holds its own bearer token, and logs time under its own name — through the Model Context Protocol or plain REST."
      >
        <AgentsSheet />
      </Sheet>

      <Sheet
        id="kanttban"
        index="Kanttban"
        title="Planned on the board, timed at the desk."
        lede="A card in Kanttban and a task here describe the same work, so an agent can move between the two without anyone re-keying the plan."
      >
        <KanttbanSheet />
      </Sheet>

      <Sheet
        id="source"
        index="Source"
        title="Nothing here is hidden from you."
        lede="Every line of the server, the client and the schema is published, and the whole thing runs on a machine you already have."
      >
        <SourceSheet />
      </Sheet>

      <TitleBlock onStart={onStart} />
    </div>
  );
}
