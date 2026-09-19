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

Ships with [HeliosDB-Nano](https://heliosdb.com) as the database; set
`PTD_DB_IMAGE=postgres:16-alpine` in `.env` to use stock Postgres instead.
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

## Develop

```bash
npm install
export DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/heliosdb JWT_SECRET=dev
npm run migrate && npm run seed   # demo org with humans, agents, streams, tasks
npm run dev                       # API + Vite on :3001
npm run check && npm test
```

## License

MIT.
