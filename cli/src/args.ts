/**
 * Argument parsing.
 *
 * One grammar for every command: positionals in order, `--flag=value`,
 * `--flag value` (when the next token is not itself a flag) and bare `--flag`
 * for booleans. `--` ends flag parsing. Flags are collected verbatim; coercion
 * happens later, only where an action's JSON body is being built.
 */

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
  /** Flag names in the order they appeared, so a caller can tell `--json` apart from a leftover. */
  order: string[];
}

const SHORT: Record<string, string> = { h: "help", j: "json", v: "version" };

/**
 * `--json` is a boolean output switch *unless* the next token opens a JSON
 * object. That one exception is what lets `ptd run <action> --json '{…}'` supply
 * a whole request body while `ptd stop --json some notes` still keeps its notes.
 * The `--json={…}` form is always a value.
 */
const JSON_BODY_FLAGS = new Set(["json"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const order: string[] = [];
  let literal = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }
    if (token.startsWith("--") && token.length > 2) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        const name = body.slice(0, eq);
        flags.set(name, body.slice(eq + 1));
        order.push(name);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !isFlag(next) && (!JSON_BODY_FLAGS.has(body) || next.trimStart().startsWith("{"))) {
        flags.set(body, next);
        i++;
      } else {
        flags.set(body, true);
      }
      order.push(body);
      continue;
    }
    if (/^-[a-zA-Z]$/.test(token)) {
      const name = SHORT[token[1]] ?? token.slice(1);
      flags.set(name, true);
      order.push(name);
      continue;
    }
    positionals.push(token);
  }

  return { positionals, flags, order };
}

/** A token that opens a flag. A lone `-` and negative numbers are values. */
export function isFlag(token: string): boolean {
  if (token === "-" || token === "--") return false;
  if (!token.startsWith("-")) return false;
  return !/^-\d/.test(token);
}

/**
 * Turn a command-line string into the JSON value an action's schema wants:
 * integers and floats become numbers, `true`/`false` booleans, `null` null, and
 * anything starting with `{`, `[` or `"` is parsed as JSON. Everything else
 * stays a string — so `--externalKey=SEC-3` and `--taskId=3` both land right.
 */
export function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  const first = raw[0];
  if (first === "{" || first === "[" || first === '"') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Flags every command understands and that must never leak into an action body. */
export const RESERVED_FLAGS = new Set(["json", "raw", "help", "version", "url", "token", "org", "body", "no-color"]);

/** `--key=value …` → the body of an action call. Reserved flags are left out. */
export function bodyFromFlags(flags: Map<string, string | true>, skip: Set<string> = RESERVED_FLAGS): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of flags) {
    if (skip.has(key)) continue;
    body[key] = value === true ? true : coerce(value);
  }
  return body;
}

/** `--tokens 1200` → 1200, with a clear complaint instead of a NaN. */
export function numberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error(`--${name} needs a value`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${raw}"`);
  return n;
}

export function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error(`--${name} needs a value`);
  return raw;
}

/**
 * `45m`, `1h30m`, `1.5h`, `90s`, `2h`, or a bare `45` (minutes) → minutes.
 * Returns null when the text is not a duration at all.
 */
export function parseDuration(text: string): number | null {
  const compact = text.trim().toLowerCase().replace(/\s+/g, "");
  if (compact === "") return null;
  if (/^\d+(?:\.\d+)?$/.test(compact)) return round(Number(compact));
  // Longest unit spellings first, so "45min" is not read as "45m" plus junk.
  const pattern = /(\d+(?:\.\d+)?)(hours?|hrs|hr|h|minutes?|mins|min|m|seconds?|secs|sec|s)/g;
  let total = 0;
  let matched = 0;
  let consumed = 0;
  for (const m of compact.matchAll(pattern)) {
    matched++;
    consumed += m[0].length;
    const value = Number(m[1]);
    const unit = m[2][0];
    total += unit === "h" ? value * 60 : unit === "s" ? value / 60 : value;
  }
  // Reject "45mx" or "tomorrow": every character has to belong to a unit.
  if (matched === 0 || consumed !== compact.length) return null;
  return round(total);
}

const round = (minutes: number) => Math.round(minutes * 100) / 100;
