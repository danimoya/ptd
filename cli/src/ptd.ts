/**
 * `ptd` — the entry point.
 *
 * Dispatch only: every command lives in ./commands, the HTTP client in ./api and
 * the stored session in ./config. Errors are printed as one plain line — the API
 * already explains itself in `{error, message}` — and turned into the exit code
 * the docs promise (0 ok, 1 error, 2 usage, 3 forbidden).
 */
import { numberFlag, parseArgs, stringFlag } from "./args.ts";
import type { Client } from "./api.ts";
import { colorEnabled, dim, red, setColor, yellow } from "./color.ts";
import { DEFAULT_BASE_URL, readConfig, stripTrailingSlash } from "./config.ts";
import type { Ctx, Handler } from "./context.ts";
import { ApiError, CliError, exitCodeFor, UsageError } from "./errors.ts";
import { commandHelp, mainHelp, VERSION } from "./help.ts";
import { actions, run } from "./commands/registry.ts";
import { login, logout, orgs, use, whoami } from "./commands/session.ts";
import { done, log, next, start, stats, stop, tasks, today } from "./commands/work.ts";

const HANDLERS: Record<string, Handler> = {
  login,
  logout,
  whoami,
  orgs,
  use,
  actions,
  run,
  next,
  tasks,
  start,
  stop,
  log,
  today,
  done,
  stats,
};

/** Commands that work before `ptd login` has ever run. */
const NO_CREDENTIAL = new Set(["login", "logout"]);

export async function main(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  if (flags.has("no-color")) setColor(false);
  const print = (text: string) => console.log(text);

  const command = positionals[0];

  if (flags.has("version") && !command) {
    print(VERSION);
    return 0;
  }
  if (!command || flags.has("help")) {
    print(command && HANDLERS[command] ? commandHelp(command) : mainHelp());
    return command && !HANDLERS[command] ? 2 : 0;
  }

  const handler = HANDLERS[command];
  if (!handler) {
    console.error(red(`Unknown command "${command}".`));
    console.error(dim("Run `ptd --help` for the list."));
    return 2;
  }

  const config = readConfig();
  const client: Client = {
    baseUrl: stripTrailingSlash(stringFlag(flags, "url") ?? config.baseUrl ?? DEFAULT_BASE_URL),
    token: stringFlag(flags, "token") ?? config.token,
    orgId: numberFlag(flags, "org") ?? config.orgId,
  };

  if (!client.token && !NO_CREDENTIAL.has(command)) {
    console.error(red("Not logged in."));
    console.error(dim(`Run \`ptd login --url ${client.baseUrl}\`, or set PTD_TOKEN.`));
    return 1;
  }

  const ctx: Ctx = {
    client,
    flags,
    args: positionals.slice(1),
    raw: flags.get("json") === true || flags.has("raw"),
    print,
  };

  try {
    await handler(ctx);
    return 0;
  } catch (err) {
    report(err, command);
    return exitCodeFor(err);
  }
}

function report(err: unknown, command: string): void {
  if (err instanceof UsageError) {
    console.error(red(err.message));
    console.error("");
    console.error(commandHelp(err.command ?? command));
    return;
  }
  if (err instanceof ApiError) {
    console.error(red(err.code === "network" ? err.message : `${err.code}: ${err.message}`));
    if (err.status === 401) console.error(dim("The credential was refused — `ptd login` again, or check --url."));
    if (err.status === 403) console.error(dim("Your role in this organization does not allow that action."));
    return;
  }
  if (err instanceof CliError) {
    console.error(red(err.message));
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(red(message));
  if (process.env.PTD_DEBUG && err instanceof Error && err.stack) console.error(dim(err.stack));
}

// `--no-color` is handled inside main(), but NO_COLOR must already be honored for
// the failure paths above; colorEnabled() reads the environment at import time.
if (!colorEnabled() && process.env.PTD_DEBUG) console.error(yellow("(color disabled)"));

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  },
);
