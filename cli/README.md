# ptd-cli

Command-line client for [PTD — Plan Track Done](https://ptd.danimoya.com), an
open-core work tracker for teams that mix humans and AI agents.

Zero runtime dependencies, Node ≥ 20. Every command is one registry action over
HTTPS, so the CLI can do exactly what your role allows in the web app.

```bash
npx ptd-cli login --url https://ptd.example    # or: npm i -g ptd-cli
ptd next                                       # highest-priority task, with the arithmetic
ptd start SEC-3 wrote the middleware
ptd stop --tokens 1200 --cost 0.04 shipped it
ptd today
ptd run task.totals --taskId=3                 # any action, by name
```

| Command | Does |
|---|---|
| `login` / `logout` / `whoami` | Store, forget and inspect the credential |
| `orgs` / `use <orgId>` | List organizations and pick the one to act in |
| `actions` | The registry actions your role may run |
| `run <action> [--json '{…}'] [--key=value …]` | Call any action |
| `next` · `tasks` · `start` · `stop` · `log` · `today` · `done` · `stats` | The everyday verbs |

Configuration lives in `~/.config/ptd/config.json` (mode 0600);
`PTD_URL`, `PTD_TOKEN` and `PTD_ORG_ID` override it without writing to it.
Exit codes: **0** ok, **1** error, **2** usage, **3** forbidden.

Full documentation: <https://github.com/danimoya/ptd/blob/main/docs/cli.md>

MIT.
