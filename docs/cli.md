# `ptd` — the command-line client

A single-file Node client for PTD. Zero runtime dependencies, Node ≥ 20. Every
command is one registry action over HTTPS, so the CLI can do exactly what your role
allows in the web app — no more, no less.

## Install

```bash
npx ptd-cli --help          # no install
npm i -g ptd-cli            # then just `ptd`
```

From a checkout of this repository:

```bash
npm install --prefix cli
npm run build --prefix cli
node cli/dist/ptd.js --help
```

## Log in

```bash
ptd login --url https://ptd.example          # prompts for email and password
ptd login --url https://ptd.example --token ptd_…   # paste an agent token instead
```

The email/password path stores the 7-day JWT from `POST /api/auth/login`; the
password is read without echo and never appears in the shell history or the
scrollback. `--url` defaults to whatever is already configured, else
`https://ptd.danimoya.com`.

Either way, `login` then calls `whoami` and stores the organization the server
actually resolved, so the credential and the organization can never disagree.

### Configuration file

`~/.config/ptd/config.json`, created inside a `0700` directory and written `0600`:

```json
{
  "baseUrl": "https://ptd.example",
  "token": "ptd_…",
  "orgId": 1
}
```

`ptd whoami` warns if the file's mode is looser than `0600`. `ptd logout` removes
the credential and keeps the URL.

Three environment variables override the file without writing to it — the right
way to authenticate in CI:

| Variable | Overrides |
|---|---|
| `PTD_URL` | `baseUrl` |
| `PTD_TOKEN` | `token` |
| `PTD_ORG_ID` | `orgId` |

`PTD_CONFIG` points at a different config file altogether.

## Commands

| Command | Action it calls |
|---|---|
| `ptd login [--url <base>] [--token ptd_…] [--email <address>]` | `POST /api/auth/login`, then `whoami` |
| `ptd logout` | *(local only)* |
| `ptd whoami` | `whoami` |
| `ptd orgs` | `GET /api/orgs` |
| `ptd use <orgId>` | *(local, after checking membership)* |
| `ptd actions [--surface <s>] [--grep <text>]` | `GET /api/actions` |
| `ptd run <action> [--json '{…}'] [--key=value …]` | any action |
| `ptd next [--stream <id>] [--app <id>] [--assignee me\|any\|none\|<id>]` | `next_task` |
| `ptd tasks [--status <s>] [--stream <id>] [--app <id>] [--mine] [--all]` | `task.list` |
| `ptd start <KEY\|id> [notes…]` | `time_entry.start` |
| `ptd stop [--tokens <n>] [--cost <usd>] [notes…]` | `time_entry.stop` |
| `ptd log <45m\|1h30m> <KEY\|id> [notes…]` | `time_entry.log_past` |
| `ptd today` | `today_summary` |
| `ptd done <KEY\|id> [note…]` | `task.complete` |
| `ptd stats` | `stats` *(manager and above)* |

`ptd --help` lists them; `ptd <command> --help` gives one command's arguments.

### Task keys

Every command that takes `<KEY|id>` accepts either. A bare number is a task id;
anything else is resolved against `externalKey` through `task.list` (completed cards
included, case-insensitively as a fallback). An unknown key is an error that names
some of the keys that do exist rather than a silent miss:

```
$ ptd start NOPE-9
No task with external key "NOPE-9" in this organization. Known keys include: SEC-2, SEC-4, CHK-1, …
```

### `ptd run` — the generic escape hatch

Everything the API can do, whether or not the CLI has a verb for it:

```bash
ptd run task.totals --taskId=3
ptd run task.create --title='Ship the CLI' --urgency=8 --impact=7 --effort=2
ptd run tasks.query --json '{"status":["backlog"],"limit":5}'
ptd run webhook.create --url=https://example.com/hook --events='["task.completed"]'
```

`--key=value` builds the JSON body, coercing as a person would expect:

| You type | It sends |
|---|---|
| `--taskId=3` | `3` (number) |
| `--cost=0.04` | `0.04` (number) |
| `--includeCompleted` | `true` |
| `--includeCompleted=false` | `false` |
| `--streamId=null` | `null` |
| `--tags='["a","b"]'` | `["a","b"]` (array) |
| `--externalKey=SEC-3` | `"SEC-3"` (string — a key is never read as a number) |
| `--code='"0012"'` | `"0012"` (a JSON string stays a string) |

`--json '{…}'` supplies a whole body; `--key=value` pairs given alongside it win
field by field. `--body` is an unambiguous alias for the same thing.

`--json` is otherwise the raw-output switch, so `ptd stop --json finished the sweep`
keeps its notes: the flag only takes a value when the next token opens a JSON
object.

### Output

Aligned tables and key/value blocks by default, with the header ruled and numeric
columns right-aligned:

```
$ ptd tasks
key    id  pri  status       due         title
─────  ──  ───  ───────────  ──────────  ────────────────────────────────────────
SEC-4   4   32  in-progress  2026-09-20  Pin TLS 1.3 + PQC hybrid on the API edge
API-2  15   28  in-progress  2026-09-17  Generate OpenAPI 3.1 spec from routes
API-4  17   24  backlog                  Deprecation headers on v1
```

`--json` (or `-j`) prints the API's answer verbatim, which is what to pipe into
`jq`. An action the CLI has no verb for renders generically: scalars as a
key/value block, arrays of objects as tables with nested buckets flattened into
dotted columns (`bySource.agent.tokens`), so a newly added server action is useful
immediately.

Color is used only when stdout is a TTY. `NO_COLOR`, `TERM=dumb` and `--no-color`
turn it off; `FORCE_COLOR` forces it on.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error — the API refused, the network is down, the task does not exist |
| 2 | Usage — unknown command, missing or malformed argument |
| 3 | Forbidden — the credential is valid but your role is too low |

Errors from the API are printed plainly, as `code: message`:

```
$ ptd stats
forbidden: stats requires role manager or higher (you are member)
Your role in this organization does not allow that action.
```

## A session

```bash
$ ptd next
API-4 · #17 Deprecation headers on v1
status    backlog
priority  24 (low)
why       urgency 4 × impact 6 ÷ effort 1 = 24
stream    API v2
app       api
assignee  unclaimed

$ ptd start API-4 adding the Sunset header
Started entry #24 on API-4 · #17 Deprecation headers on v1
source  agent
since   2026-09-20T16:15:35.052Z

$ ptd stop --tokens 1200 --cost 0.04 shipped it
Stopped entry #24 after 47m.
tokens  1200
cost    $0.0400

$ ptd done API-4
Completed API-4 · #17 Deprecation headers on v1.
```

Called with a human credential, that same `stop` reports what it discarded —
tokens and cost only mean something for agent work:

```
Stopped entry #22 after 47m.
Ignored tokensUsed, apiCostUsd — tokensUsed and apiCostUsd are recorded only for
entries whose entry_source is 'agent'. …
```

## For agents

The CLI is a reasonable tool for an agent that already has a shell. Give it the
agent's own token — not a human's — or its work is recorded as human work and its
tokens and cost are dropped:

```bash
export PTD_URL=https://ptd.example PTD_TOKEN=ptd_…
ptd next --json | jq -r '.task.externalKey'
```

An agent with an MCP client should use the MCP server instead; see
[agents.md](agents.md).

## Development

```bash
npm install --prefix cli     # esbuild, typescript, vitest — dev only
npm test  --prefix cli       # unit tests
npm run check --prefix cli   # tsc --noEmit
npm run build --prefix cli   # bundle to cli/dist/ptd.js
```

Sources are in `cli/src`; the build is a single ESM file with a shebang, produced
by esbuild.
