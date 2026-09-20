/**
 * Regenerates the action reference inside `docs/api.md` from the live registry.
 *
 *   npm run docs            # rewrite the generated block
 *   npm run docs -- --check # exit 1 if the block is stale (for CI)
 *
 * The registry is the single source of truth for names, titles, descriptions,
 * roles, surfaces and input schemas — the same objects `/api/actions`, `/mcp`,
 * `/openapi.json` and `/.well-known/ai-agent.json` serve — so the reference cannot
 * drift from the server the way a hand-written list would. Only the text between
 * the two markers is touched; the prose around it is written by hand.
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.resolve(here, "../docs/api.md");
export const BEGIN = "<!-- BEGIN GENERATED ACTIONS -->";
export const END = "<!-- END GENERATED ACTIONS -->";

/** Surfaces in the order the product presents them; anything new lands last. */
const SURFACE_ORDER = ["overview", "plan", "track", "org"] as const;
const SURFACE_TITLES: Record<string, string> = {
  overview: "Overview — backlog, apps, KPIs, webhooks",
  plan: "Plan — tasks, streams, scheduling, dependencies",
  track: "Track — the timer, the ledger, reports, invoices",
  org: "Org — members, imports, calendar, integrations, billing",
};

interface ActionLike {
  name: string;
  title: string;
  description: string;
  requiredRole: string;
  surface: string;
  input: z.ZodObject<z.ZodRawShape>;
}

/* ── zod → one line of Markdown ──────────────────────────────────────── */

interface Peeled {
  inner: z.ZodTypeAny;
  optional: boolean;
  nullable: boolean;
}

/** Strip optional/nullable/default wrappers in any order, as discovery.ts does. */
function peel(field: z.ZodTypeAny): Peeled {
  let inner = field;
  let optional = false;
  let nullable = false;
  for (let i = 0; i < 8; i++) {
    const def = inner._def as { typeName?: string; innerType?: z.ZodTypeAny };
    if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") {
      optional = true;
      inner = def.innerType!;
      continue;
    }
    if (def.typeName === "ZodNullable") {
      nullable = true;
      inner = def.innerType!;
      continue;
    }
    break;
  }
  return { inner, optional, nullable };
}

export function typeName(field: z.ZodTypeAny): string {
  const def = field._def as {
    typeName?: string;
    values?: readonly string[];
    value?: unknown;
    type?: z.ZodTypeAny;
    options?: z.ZodTypeAny[];
    checks?: { kind: string }[];
    valueType?: z.ZodTypeAny;
    innerType?: z.ZodTypeAny;
  };
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodDefault":
    case "ZodNullable":
      return typeName(def.innerType!);
    case "ZodString":
      return "string";
    case "ZodNumber":
      return (def.checks ?? []).some((c) => c.kind === "int") ? "integer" : "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
      return (def.values ?? []).map((v) => `\`${v}\``).join(" | ");
    case "ZodLiteral":
      return `\`${JSON.stringify(def.value)}\``;
    case "ZodArray":
      return `${typeName(def.type!)}[]`;
    case "ZodUnion":
      return (def.options ?? []).map(typeName).join(" | ");
    case "ZodRecord":
      return `object<string, ${typeName(def.valueType!)}>`;
    case "ZodObject":
      return "object";
    default:
      return def.typeName?.replace(/^Zod/, "").toLowerCase() ?? "unknown";
  }
}

/** Pipes and newlines would break the surrounding table. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function fieldRows(shape: z.ZodRawShape): string[] {
  return Object.entries(shape).map(([key, raw]) => {
    const field = raw as z.ZodTypeAny;
    const { optional, nullable } = peel(field);
    const flags = [optional ? "optional" : "required", nullable ? "nullable" : ""].filter(Boolean).join(", ");
    return `| \`${key}\` | ${cell(typeName(field))} | ${flags} | ${cell(field.description ?? "")} |`;
  });
}

/* ── rendering ───────────────────────────────────────────────────────── */

function renderAction(action: ActionLike): string {
  const lines = [`#### \`${action.name}\``, "", `**${action.title}** · role \`${action.requiredRole}\` and above`, "", cell(action.description)];
  const rows = fieldRows(action.input.shape);
  lines.push("");
  if (rows.length === 0) {
    lines.push("Takes no arguments.");
  } else {
    lines.push("| field | type | | meaning |", "|---|---|---|---|", ...rows);
  }
  return lines.join("\n");
}

export function renderReference(actions: ActionLike[], generatedAt = "the registry"): string {
  const bySurface = new Map<string, ActionLike[]>();
  for (const action of actions) {
    const list = bySurface.get(action.surface) ?? [];
    list.push(action);
    bySurface.set(action.surface, list);
  }
  const surfaces = [...SURFACE_ORDER.filter((s) => bySurface.has(s)), ...[...bySurface.keys()].filter((s) => !SURFACE_ORDER.includes(s as never)).sort()];

  const out: string[] = [
    `_${actions.length} actions, generated from ${generatedAt} by \`scripts/gen-docs.ts\` (\`npm run docs\`). Do not edit this block by hand._`,
    "",
    "| surface | actions | minimum role of each |",
    "|---|---|---|",
  ];
  for (const surface of surfaces) {
    const list = bySurface.get(surface)!;
    const roles = countRoles(list);
    out.push(`| ${surface} | ${list.length} | ${roles} |`);
  }

  for (const surface of surfaces) {
    const list = bySurface.get(surface)!.slice().sort((a, b) => a.name.localeCompare(b.name));
    out.push("", `### ${SURFACE_TITLES[surface] ?? surface}`, "");
    out.push(list.map((a) => `\`${a.name}\``).join(" · "));
    for (const action of list) out.push("", renderAction(action));
  }
  return out.join("\n");
}

function countRoles(actions: ActionLike[]): string {
  const order = ["member", "manager", "admin", "owner"];
  const counts = new Map<string, number>();
  for (const a of actions) counts.set(a.requiredRole, (counts.get(a.requiredRole) ?? 0) + 1);
  return order
    .filter((role) => counts.has(role))
    .map((role) => `${counts.get(role)} × \`${role}\``)
    .join(", ");
}

/** Swap the text between the markers, leaving the hand-written prose alone. */
export function splice(document: string, block: string): string {
  const start = document.indexOf(BEGIN);
  const end = document.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`docs/api.md must contain ${BEGIN} … ${END}`);
  }
  return `${document.slice(0, start + BEGIN.length)}\n\n${block}\n\n${document.slice(end)}`;
}

/* ── entry point ─────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  // The registry's modules import the drizzle client at load time. postgres.js
  // connects lazily, so a placeholder URL is enough to render docs with no
  // database anywhere in sight.
  process.env.DATABASE_URL ||= "postgres://docs:docs@127.0.0.1:5432/docs";
  const { allActions } = await import("../server/actions");

  const actions = allActions() as unknown as ActionLike[];
  if (actions.length === 0) throw new Error("the action registry is empty — nothing to document");

  const current = readFileSync(TARGET, "utf8");
  const next = splice(current, renderReference(actions));
  const check = process.argv.includes("--check");

  if (next === current) {
    console.log(`[gen-docs] docs/api.md is up to date (${actions.length} actions)`);
    return;
  }
  if (check) {
    console.error(`[gen-docs] docs/api.md is stale — run \`npm run docs\` (${actions.length} actions in the registry)`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(TARGET, next);
  console.log(`[gen-docs] wrote docs/api.md (${actions.length} actions)`);
}

// Only run when invoked directly, so tests can import the renderers.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (err) => {
      console.error("[gen-docs] failed:", err);
      process.exit(1);
    },
  );
}
