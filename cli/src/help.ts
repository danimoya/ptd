import { bold, dim } from "./color.ts";

export const VERSION = "0.1.0";

interface Entry {
  usage: string;
  summary: string;
  detail?: string[];
}

export const COMMANDS: Record<string, Entry> = {
  login: {
    usage: "ptd login [--url <base>] [--token ptd_…] [--email <address>]",
    summary: "store a credential for a PTD deployment",
    detail: [
      "With --token the pasted agent token is stored as is. Without it you are asked",
      "for an e-mail and a password (never echoed) and the 7-day JWT from",
      "POST /api/auth/login is stored instead.",
      "--url defaults to the URL already in the config, else https://ptd.danimoya.com.",
    ],
  },
  logout: { usage: "ptd logout", summary: "forget the stored credential (the URL is kept)" },
  whoami: { usage: "ptd whoami", summary: "identity, organization, role and human-vs-agent auth type" },
  orgs: { usage: "ptd orgs", summary: "organizations this credential belongs to" },
  use: { usage: "ptd use <orgId>", summary: "pick the organization every later command acts on" },
  actions: {
    usage: "ptd actions [--surface <s>] [--grep <text>]",
    summary: "the registry actions this role may run",
  },
  run: {
    usage: "ptd run <action> [--json '{…}'] [--key=value …]",
    summary: "call any action by name",
    detail: [
      "The body is built from --key=value pairs, with numbers, booleans, null and",
      "JSON literals coerced. --json '{…}' passes a whole body instead (--body is an",
      "unambiguous alias); a bare --json with no JSON after it means \"print raw JSON\".",
      "",
      "  ptd run task.totals --taskId=3",
      "  ptd run task.create --title='Ship the CLI' --urgency=8 --impact=7 --effort=2",
      "  ptd run tasks.query --json '{\"status\":[\"backlog\"],\"limit\":5}'",
    ],
  },
  next: { usage: "ptd next [--stream <id>] [--app <id>] [--assignee me|any|none|<id>]", summary: "the highest-priority task worth starting, with the arithmetic behind it" },
  tasks: { usage: "ptd tasks [--status <s>] [--stream <id>] [--app <id>] [--mine] [--all]", summary: "the organization's open cards, highest priority first" },
  start: { usage: "ptd start <KEY|id> [notes…]", summary: "open a time entry on a task" },
  stop: { usage: "ptd stop [--tokens <n>] [--cost <usd>] [notes…]", summary: "close the running entry (agents may report tokens and cost)" },
  log: { usage: "ptd log <45m|1h30m> <KEY|id> [notes…]", summary: "record a finished session that ended just now" },
  today: { usage: "ptd today", summary: "your day so far: minutes by stream, human vs agent, what is running" },
  done: { usage: "ptd done <KEY|id> [note…]", summary: "mark a task complete" },
  stats: { usage: "ptd stats", summary: "organization KPI roll-up (manager and above)" },
  "agent-run": {
    usage: "ptd agent-run [--task KEY] [--source ci] -- <command…>",
    summary: "time a command, report its tokens, and attest them",
    detail: [
      "Opens a time entry, runs the command, closes the entry with whatever usage the",
      "command reported, then writes a `time_entry.attest` for it. The command's exit",
      "code becomes the CLI's, so this can stand in for the command it wraps.",
      "",
      "The card comes from --task, else $PTD_TASK, else a .ptd-task file at or above",
      "the working directory, else next_task {assignee:\"me\"}. --no-next skips that",
      "last step and times the run without a card.",
      "",
      "How the command reports its usage (first one wins):",
      "  1. write {\"tokens\":N,\"model\":\"claude-opus-5\"} to $PTD_TOKENS_FILE — set for",
      "     the child automatically when you have not set it yourself",
      "  2. print  PTD_USAGE {\"tokens\":N,\"model\":\"…\"}  on stdout (last line wins)",
      "Both accept camelCase or snake_case, a nested `usage` object, and derive the",
      "total from inputTokens/outputTokens/cache* when no total is given.",
      "",
      "The child also gets $PTD_ENTRY_ID and $PTD_TASK_ID.",
      "",
      "  ptd agent-run --task SEC-3 -- python fix_forms.py",
      "  ptd agent-run -- claude -p 'fix the failing test'",
    ],
  },
  "ci-report": {
    usage: "ptd ci-report [--task KEY] [--tokens N] [--cost USD] [--model M] [--minutes N] [--entry ID]",
    summary: "log and attest usage from a CI job (reads GITHUB_* for evidence)",
    detail: [
      "For work that has already happened. With --entry it attests that entry; without",
      "one it logs a finished session of --minutes (default 1) and attests that.",
      "",
      "The usage figure comes from --tokens/--cost, else --usage-file or",
      "$PTD_TOKENS_FILE, else a PTD_USAGE marker on piped stdin. With no figure the",
      "session is still logged but nothing is attested.",
      "",
      "GITHUB_REPOSITORY, GITHUB_WORKFLOW, GITHUB_JOB, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,",
      "GITHUB_SHA, GITHUB_REF_NAME and GITHUB_ACTOR are recorded as the attestation's",
      "evidence, with a link to the run, so the figure can be traced to the job.",
      "",
      "Needs an agent seat's token: PTD dropped tokens and cost on a human session.",
      "",
      "  ptd ci-report --task SEC-3 --tokens 143793 --model claude-opus-5 --minutes 4",
      "  cat build.log | ptd ci-report --entry 41",
    ],
  },
};

const GLOBAL = [
  ["--json, -j", "print the raw JSON the API returned"],
  ["--url <base>", "override the stored base URL for this one command"],
  ["--token <t>", "override the stored credential for this one command"],
  ["--org <id>", "override the stored organization for this one command"],
  ["--no-color", "never colorize (NO_COLOR is honored too)"],
  ["--help, -h", "this text, or a command's own usage"],
  ["--version, -v", "print the CLI version"],
];

export function mainHelp(): string {
  const names = Object.keys(COMMANDS);
  const width = Math.max(...names.map((n) => n.length));
  const rows = names.map((n) => `  ${n.padEnd(width)}  ${dim(COMMANDS[n].summary)}`);
  const globals = GLOBAL.map(([flag, text]) => `  ${flag.padEnd(14)}  ${dim(text)}`);
  return [
    bold("ptd") + ` — command-line client for PTD (Plan Track Done), v${VERSION}`,
    "",
    "Every command is one registry action over HTTPS, so the CLI can do exactly what",
    "your role allows on the web app, over MCP or in Slack — no more, no less.",
    "",
    bold("Commands") + dim("  (`ptd <command> --help` for its arguments)"),
    ...rows,
    "",
    bold("Global flags"),
    ...globals,
    "",
    bold("Environment"),
    `  ${dim("PTD_URL, PTD_TOKEN, PTD_ORG_ID override the stored config without writing to it.")}`,
    `  ${dim("Config: ~/.config/ptd/config.json (mode 0600).")}`,
    "",
    bold("Exit codes"),
    `  ${dim("0 ok · 1 error · 2 usage · 3 forbidden (role too low)")}`,
  ].join("\n");
}

export function commandHelp(name: string): string {
  const entry = COMMANDS[name];
  if (!entry) return mainHelp();
  const lines = [bold(entry.usage), "", entry.summary];
  if (entry.detail) lines.push("", ...entry.detail);
  return lines.join("\n");
}
