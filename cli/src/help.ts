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
