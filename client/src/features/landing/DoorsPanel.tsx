// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { Form, QuietButton } from "./chrome";

/* ─────────────────────────────────────────────────────────────────────────
 * Glimpse IV — one action, every door.
 *
 * An action is defined once, with the role it needs, and every door serves
 * it: MCP, REST, Slack, and the connectors that attach over OAuth. Change
 * the role and the same call either goes through or comes back a 403.
 * ───────────────────────────────────────────────────────────────────────── */

export type Role = "member" | "manager" | "admin";
export type Door = "mcp" | "rest" | "slack" | "connector";

export const RANK: Record<string, number> = { member: 1, manager: 2, admin: 3, owner: 4 };

export function allows(role: Role, required: string): boolean {
  return RANK[role] >= RANK[required];
}

export interface DoorAction {
  name: string;
  required: Role;
  args: Record<string, string | number>;
  slack: string;
  ask: string;
  surface: string;
}

/** The roll, with the roles the server actually requires. */
export const ACTIONS: DoorAction[] = [
  {
    name: "time_entry.stop",
    required: "member",
    args: { tokensUsed: 15400, apiCostUsd: 0.21 },
    slack: "/ptd stop tokens=15400 cost=0.21",
    ask: "Stop my timer — 15,400 tokens, 21 cents.",
    surface: "track",
  },
  {
    name: "task.complete",
    required: "member",
    args: { taskId: 118 },
    slack: "/ptd done 118",
    ask: "Mark task 118 done.",
    surface: "plan",
  },
  {
    name: "task.schedule",
    required: "manager",
    args: { taskId: 118, startDate: "2026-09-24", estimatedDuration: 3 },
    slack: "/ptd schedule 118 2026-09-24 3d",
    ask: "Put task 118 on the timeline for 24 September, three days.",
    surface: "plan",
  },
  {
    name: "task.set_priority",
    required: "manager",
    args: { taskId: 118, urgency: 8, impact: 8, effort: 2 },
    slack: "/ptd priority 118 u=8 i=8 e=2",
    ask: "Score task 118 at urgency 8, impact 8, effort 2.",
    surface: "plan",
  },
  {
    name: "webhook.create",
    required: "admin",
    args: { url: "https://hooks.example.com/ptd", events: "task.completed" },
    slack: "/ptd webhook add https://hooks.example.com/ptd",
    ask: "Send task completions to our hooks endpoint.",
    surface: "org",
  },
];

const DOORS: { key: Door; label: string; meta: string }[] = [
  { key: "mcp", label: "MCP", meta: "POST /mcp · JSON-RPC 2.0" },
  { key: "rest", label: "REST", meta: "POST /api/actions/<name>" },
  { key: "slack", label: "Slack", meta: "/ptd · linked identity" },
  { key: "connector", label: "Connector", meta: "Claude.ai · ChatGPT · OAuth 2.1" },
];

const ORIGIN = "https://ptd.example.com";

export function renderCall(door: Door, action: DoorAction): string {
  const args = JSON.stringify(action.args);
  switch (door) {
    case "mcp":
      return [
        "{",
        '  "jsonrpc": "2.0",',
        '  "id": 7,',
        '  "method": "tools/call",',
        '  "params": {',
        `    "name": "${action.name}",`,
        `    "arguments": ${args}`,
        "  }",
        "}",
      ].join("\n");
    case "rest":
      return [
        `curl -sX POST ${ORIGIN}/api/actions/${action.name} \\`,
        "  -H 'Authorization: Bearer ptd_…' \\",
        "  -H 'Content-Type: application/json' \\",
        `  -d '${args}'`,
      ].join("\n");
    case "slack":
      return action.slack;
    case "connector":
      return [
        `# attached once over OAuth 2.1 — ${ORIGIN}/mcp`,
        `you → ${action.ask}`,
        `↳ ${action.name} ${args}`,
      ].join("\n");
  }
}

export function renderResult(role: Role, action: DoorAction): { ok: boolean; body: string } {
  if (!allows(role, action.required)) {
    return {
      ok: false,
      body: [
        "403 forbidden",
        "{",
        '  "error": "forbidden",',
        `  "message": "${action.name} needs ${action.required}; this credential is a ${role}."`,
        "}",
      ].join("\n"),
    };
  }
  if (action.name === "time_entry.stop") {
    return {
      ok: true,
      body: [
        "200 ok",
        "{",
        '  "entry": {',
        '    "id": 4411, "minutes": 22,',
        '    "entrySource": "agent",',
        '    "tokensUsed": 15400, "apiCostUsd": 0.21',
        "  }",
        "}",
      ].join("\n"),
    };
  }
  return { ok: true, body: ["200 ok", "{", `  "${action.surface}": "updated"`, "}"].join("\n") };
}

export default function DoorsPanel({ className }: { className?: string }) {
  const [role, setRole] = useState<Role>("member");
  const [door, setDoor] = useState<Door>("mcp");
  const [selected, setSelected] = useState(ACTIONS[0].name);

  const action = ACTIONS.find((a) => a.name === selected) ?? ACTIONS[0];
  const doorMeta = DOORS.find((d) => d.key === door)!;
  const result = renderResult(role, action);

  return (
    <Form title="One action, every door" meta="85 actions · one definition" className={className}>
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="min-w-0">
          <legend className="eyebrow mb-2">Your credential</legend>
          <div className="flex flex-wrap gap-1">
            {(["member", "manager", "admin"] as Role[]).map((r) => (
              <QuietButton key={r} data-testid={`role-${r}`} active={role === r} onClick={() => setRole(r)}>
                {r}
              </QuietButton>
            ))}
          </div>
        </fieldset>
        <fieldset className="min-w-0">
          <legend className="eyebrow mb-2">The door</legend>
          <div className="flex flex-wrap gap-1">
            {DOORS.map((d) => (
              <QuietButton key={d.key} data-testid={`door-${d.key}`} active={door === d.key} onClick={() => setDoor(d.key)}>
                {d.label}
              </QuietButton>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="mt-5 border-t border-rule pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="font-numeric text-[11px] text-ink">{action.name}</span>
          <span className="font-numeric text-[10px] text-ink-muted">{doorMeta.meta}</span>
        </div>
        <pre
          data-testid="door-call"
          className="nice-scroll mt-2 overflow-x-auto border border-rule bg-parchment-deep/50 p-3 font-mono text-[11px] leading-relaxed text-ink"
        >
          {renderCall(door, action)}
        </pre>
        <pre
          data-testid="door-result"
          className={cn(
            "nice-scroll mt-2 overflow-x-auto border p-3 font-mono text-[11px] leading-relaxed",
            result.ok ? "border-rule bg-parchment-deep/30 text-ink-muted" : "border-vermilion/60 bg-vermilion/5 text-vermilion"
          )}
        >
          {result.body}
        </pre>
      </div>

      <div className="mt-5 border-t border-rule pt-4">
        <div className="eyebrow mb-2">What this credential may call</div>
        <ul className="divide-y divide-rule border-y border-rule">
          {ACTIONS.map((a) => {
            const ok = allows(role, a.required);
            const isOn = a.name === selected;
            return (
              <li key={a.name}>
                <button
                  type="button"
                  onClick={() => setSelected(a.name)}
                  aria-pressed={isOn}
                  data-testid={`roll-${a.name}`}
                  className={cn(
                    "focus-ink flex w-full items-baseline gap-3 px-1 py-2 text-left transition-colors",
                    isOn && "bg-parchment-deep/40",
                    ok ? "text-ink hover:bg-parchment-deep/30" : "text-ink-muted/45 hover:text-ink-muted"
                  )}
                >
                  <span className="font-numeric min-w-0 flex-1 truncate text-[11px]">{a.name}</span>
                  <span
                    className={cn(
                      "font-numeric shrink-0 whitespace-nowrap text-[10px] uppercase tracking-[0.12em]",
                      ok ? "text-ink-muted" : "text-vermilion/70"
                    )}
                  >
                    {ok ? "allowed" : `403 · needs ${a.required}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-[0.95rem] leading-relaxed text-ink-muted text-pretty">
          The human-or-agent stamp on every line is decided server-side, from the credential that made the
          call. A request cannot claim to be human.
        </p>
      </div>
    </Form>
  );
}
