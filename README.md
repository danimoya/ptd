# PTD — Plan Track Done

> Plan the work in one view, log the work in the other — same task, same source
> of truth, whether a human or an agent did it.

PTD is an open-core work tracker for hybrid human + AI-agent teams. One
organization, one shared **Task**, four surfaces:

| Surface | What it is | Who lands there |
|---|---|---|
| **Overview** | KPI strip, prioritised backlog (0–100 score), apps, cross-app streams, `next task` queue for agents | owner / admin / manager |
| **Plan** | Backlog ⇄ Gantt timeline, dependencies, cascade scheduler, **Cascade mode** dependency tree | owner / admin / manager |
| **Track** | Chronograph timer, break tiles, day ledger, calendar, reports, invoices | everyone (members land here) |
| **Org** | Members, roles, invitations, agent seats, integrations, billing (hosted only) | owner / admin |

Every time entry records whether a **human or an agent** did the work, and agent
entries can carry **tokens used and API cost** — so a PM finally sees what the
agents they delegate to actually spend, per task, next to the human hours.

## Self-host (free, forever)

```bash
git clone https://github.com/danimoya/ptd && cd ptd
cp .env.example .env            # set DB_PASSWORD and JWT_SECRET
docker compose up -d --build    # http://localhost:3001
```

Ships with [HeliosDB-Nano](https://heliosdb.com) as the database, built and
configured by `docker-compose.yml`. The app speaks the Postgres wire protocol and
the migrations are plain SQL, so pointing `DATABASE_URL` at your own Postgres works
too — see [docs/self-hosting.md](docs/self-hosting.md#using-stock-postgres-instead).
Migrations run automatically on container start.

Hosted version: <https://ptd.danimoya.com> — flat $15/month per organization.

## Security defaults

- **App ↔ database**: TLS with the **X25519MLKEM768 post-quantum hybrid** key exchange
  (HeliosDB-Nano ≥ 4.40 offers it; Node 24's OpenSSL 3.5 negotiates it), server certificate
  pinned through the shared `/tls` volume, **SCRAM-SHA-256** authentication, database HTTP/MCP
  listener disabled, database unreachable outside the compose network.
- **At rest**: set `DB_ENCRYPTION_KEY` before the first start for **AES-256-GCM** row encryption
  in the database; third-party integration secrets are sealed with AES-256-GCM under
  `PTD_SECRET_KEY`. Passwords are bcrypt (cost 12); agent tokens are stored as scrypt hashes.
- **Browser ↔ app**: terminate TLS at your reverse proxy (the hosted instance runs behind
  nginx with HSTS).
- **Telemetry**: off by default, opt-in from Org → Data. When enabled it posts exactly
  `{installation_id, dashboard_version, heliosdb_version, timestamp}` once a week — no IP, no username, no
  hostname, no names, no counts, nothing from your tasks — and the page shows that JSON before anything is
  sent ([what is sent, and how to opt out](docs/self-hosting.md#telemetry)).

## Give your agent a seat

Agents are members too. Register one and it gets a bearer token for the MCP
server and REST API:

```bash
curl -X POST https://ptd.danimoya.com/api/agent/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Claude Code","inviteCode":"<from Org → Agents>"}'
```

Then point any MCP client at `https://ptd.danimoya.com/mcp` with
`Authorization: Bearer ptd_…`. Discovery: `/.well-known/ai-agent.json`.
Which tools the agent sees depends on the role you gave it — the same role
gate applies over MCP, REST, Slack and every other adapter.

## CLI

```bash
npx ptd-cli login --url https://ptd.danimoya.com   # or: npm i -g ptd-cli
ptd next                                           # highest-priority task, with the arithmetic
ptd start SEC-3 && ptd stop --tokens 1200 --cost 0.04
ptd run task.totals --taskId=3                     # any action, by name
```

`ptd` is a zero-dependency Node client: aligned tables by default, `--json` for
piping, and `ptd run <action>` for everything the CLI has no verb for. Full command
list in [docs/cli.md](docs/cli.md); sources in [`cli/`](cli).

## Documentation

| Guide | Covers |
|---|---|
| [docs/concepts.md](docs/concepts.md) | Organizations, roles, streams/apps/tasks, the 0–100 priority score, why human-vs-agent attribution cannot be spoofed |
| [docs/self-hosting.md](docs/self-hosting.md) | Compose deployment, every environment variable, the database image's security facts, backups, upgrades, reverse proxies |
| [docs/agents.md](docs/agents.md) | Agent seats, MCP configuration, OAuth 2.1 connectors, reporting tokens and cost, the `next_task` loop |
| [docs/api.md](docs/api.md) | Auth, `X-Org-Id`, `POST /api/actions/<name>`, errors, and a generated reference of every action |
| [docs/cli.md](docs/cli.md) | The `ptd` command-line client |
| [docs/integrations.md](docs/integrations.md) | Webhooks and their signatures, Slack, CSV importers, the iCal feed |
| [docs/billing.md](docs/billing.md) | Hosted plan, free tier, and why self-hosting has no billing code at all |
| [docs/security.md](docs/security.md) | Credentials, transport, secrets at rest, rate limits, tenancy, what is out of scope |

Start at [docs/README.md](docs/README.md).

## Develop

```bash
npm install
export DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/heliosdb JWT_SECRET=dev
npm run migrate && npm run seed   # demo org with humans, agents, streams, tasks
npm run dev                       # API + Vite on :3001
npm run check && npm test
npm run docs                      # regenerate the action reference in docs/api.md

npm install --prefix cli && npm test --prefix cli   # the CLI has its own package
```

`docs/api.md`'s action reference is generated from the live registry by
`scripts/gen-docs.ts`. Add or change an action and run `npm run docs`;
`npm run docs -- --check` fails if it is stale.

## License

MIT.
