import { bodyFromFlags, stringFlag } from "../args.ts";
import { callAction, request } from "../api.ts";
import { dim } from "../color.ts";
import { CliError, UsageError } from "../errors.ts";
import { json, summarize, table } from "../table.ts";
import type { Ctx } from "../context.ts";

interface ActionRow {
  name: string;
  title: string;
  description: string;
  surface: string;
  requiredRole: string;
}

export async function actions(ctx: Ctx): Promise<void> {
  let rows = (await request(ctx.client, "/api/actions")) as ActionRow[];
  if (!Array.isArray(rows)) throw new CliError("Unexpected answer from GET /api/actions.");

  const surface = stringFlag(ctx.flags, "surface");
  const grep = stringFlag(ctx.flags, "grep");
  if (surface) rows = rows.filter((a) => a.surface === surface);
  if (grep) {
    const needle = grep.toLowerCase();
    rows = rows.filter((a) => `${a.name} ${a.title} ${a.description}`.toLowerCase().includes(needle));
  }

  if (ctx.raw) return ctx.print(json(rows));
  if (rows.length === 0) return ctx.print(dim("No actions match."));
  rows.sort((a, b) => a.surface.localeCompare(b.surface) || a.name.localeCompare(b.name));
  ctx.print(
    table(
      rows.map((a) => ({ action: a.name, surface: a.surface, role: a.requiredRole, title: a.title })),
      ["action", "surface", "role", { key: "title", max: 64 }],
    ),
  );
  ctx.print(dim(`\n${rows.length} actions available to your role. Call one with \`ptd run <action> --key=value\`.`));
}

/**
 * `ptd run <action> …`
 *
 * `--json '{…}'` (or `--body '{…}'`) supplies the whole request body. A bare
 * `--json` with nothing parseable after it is the output switch instead, which is
 * why the value is inspected rather than the flag name alone.
 */
export async function run(ctx: Ctx): Promise<void> {
  const name = ctx.args[0];
  if (!name) throw new UsageError("Name the action to run — `ptd actions` lists them.", "run");

  const { body, raw } = buildBody(ctx.flags, ctx.args.slice(1));
  const result = await callAction(ctx.client, name, body);
  if (raw || ctx.raw) return ctx.print(json(result));
  ctx.print(summarize(result));
}

export function buildBody(flags: Map<string, string | true>, extras: string[] = []): { body: Record<string, unknown>; raw: boolean } {
  let body: Record<string, unknown> = {};
  let raw = false;

  for (const key of ["json", "body"] as const) {
    const value = flags.get(key);
    if (value === undefined) continue;
    if (value === true) {
      // Bare `--json` (or `--body` with nothing) asks for raw output.
      raw = true;
      continue;
    }
    body = { ...body, ...parseObject(value, key) };
  }

  // --key=value pairs win over --json, so a canned body can be tweaked in place.
  body = { ...body, ...bodyFromFlags(flags) };

  // Refuse a stray positional rather than guessing which input field it is.
  if (extras.length > 0) throw new UsageError(`Unexpected argument "${extras[0]}" — pass inputs as --key=value or --json '{…}'.`, "run");
  return { body, raw };
}

function parseObject(value: string, flag: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new UsageError(`--${flag} is not valid JSON: ${(err as Error).message}`, "run");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`--${flag} must be a JSON object, got ${value}`, "run");
  }
  return parsed as Record<string, unknown>;
}
