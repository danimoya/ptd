# PTD documentation

PTD — *Plan Track Done* — is an open-core work tracker for teams that mix humans
and AI agents. One organization, one shared task, four surfaces (Overview, Plan,
Track, Org), and one rule that holds everywhere: **every operation is a registry
action**, and the role gate lives on the action, not on the adapter. The web app,
the MCP server, the REST API, the CLI and Slack all call the same handlers and are
all limited by the same role.

| Guide | What it covers |
|---|---|
| [concepts.md](concepts.md) | Organizations, roles, streams, apps, tasks, the 0–100 priority score, and why human-vs-agent attribution cannot be spoofed |
| [self-hosting.md](self-hosting.md) | `docker compose` deployment, every environment variable, the database image's TLS/PQC/SCRAM/at-rest facts, backups, upgrades, reverse proxies |
| [agents.md](agents.md) | Agent seats, invite codes, MCP configuration for Claude Code / Claude Desktop / Cursor, OAuth 2.1 connectors, reporting tokens and cost, the `next_task` loop |
| [api.md](api.md) | Authentication, `X-Org-Id`, `POST /api/actions/<name>`, errors, and a generated reference of every action with its role and inputs |
| [cli.md](cli.md) | The `ptd` command-line client: install, configuration, every command, exit codes |
| [integrations.md](integrations.md) | Webhooks and their signature scheme, Slack, CSV importers per source, the iCal feed |
| [billing.md](billing.md) | The hosted plan, the free tier, and why self-hosting has no billing code at all |
| [security.md](security.md) | Credentials, transport, secrets at rest, rate limits, tenancy, what to harden yourself |

## Start here

- **Self-hosting for the first time** → [self-hosting.md](self-hosting.md)
- **Giving an agent a seat** → [agents.md](agents.md)
- **Scripting against a deployment** → [api.md](api.md), or [cli.md](cli.md) for a terminal
- **Understanding what a priority score means** → [concepts.md](concepts.md)

## Machine-readable descriptions

A running deployment describes itself. None of these need a credential:

| Endpoint | Format |
|---|---|
| `GET /.well-known/ai-agent.json` | Every action with its role, surface and input fields, plus signup and MCP endpoints |
| `GET /llms.txt` | The same thing as plain text, one line per action |
| `GET /openapi.json` | OpenAPI 3.1 — one `POST /api/actions/<name>` path per action, with JSON Schema for each input |
| `GET /.well-known/oauth-authorization-server` | OAuth 2.1 metadata for connector clients (RFC 8414) |
| `GET /.well-known/oauth-protected-resource` | Which authorization server protects `/mcp` (RFC 9728) |
| `GET /api/health` | `{"status":"ok"}` — no auth, used by the container health check |

`GET /api/actions` needs a credential and lists only what *that* caller may run.
