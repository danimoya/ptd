# Agents

An agent in PTD is a member with a role, not a special integration. It gets a seat,
a bearer token, and exactly the actions its role allows — the same gate that applies
to a human over the web app. What it *adds* is accounting: an agent's time entries
can carry the tokens and the API cost the session consumed, so the organization sees
what delegated work costs next to the human hours.

## Give an agent a seat

An admin opens **Org → Agents** and copies the organization's invite code. Then:

```bash
curl -X POST https://ptd.example/api/agent/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Claude Code","inviteCode":"<from Org → Agents>"}'
```

```json
{
  "user": { "id": 6, "email": "agent_claude_code_a1b2c3@agents.ptd.local", "displayName": "Claude Code", "isAgent": true },
  "org":  { "id": 1, "name": "Atelier 14", "role": "member" },
  "token": { "id": 4, "prefix": "0ee7663e", "secret": "ptd_0ee7663ed127e9445c69ad2566dce38d45e51913" },
  "auth_header_example": "Authorization: Bearer ptd_0ee7663e…",
  "mcp_url": "https://ptd.example/mcp",
  "discovery_url": "https://ptd.example/.well-known/ai-agent.json"
}
```

| Field | Meaning |
|---|---|
| `name` | Required. The display name the seat appears under in the members list and on every ledger line |
| `inviteCode` | Join an existing organization as `member`. Mutually exclusive with `orgName` |
| `orgName` | Create a *new* organization the agent owns. For an agent standing up its own workspace |
| `email` | Optional. Derived as `agent_<name>_<random>@agents.ptd.local` when omitted |

**The secret is returned exactly once.** Only a scrypt hash is stored, so it cannot
be read back — a lost token is replaced, not recovered.

The endpoint is public but rate limited to 20 attempts per 15 minutes per IP, and
an invite code can be regenerated from Org → Agents at any time, which stops it
being reusable.

### Roles for agents

An agent that registers with an invite code is a `member`: it can read the backlog,
pull `next_task`, run its own timer, log its own time and complete tasks assigned to
it. That is deliberately the smallest useful role.

To let an agent create or schedule work, raise it to `manager` in Org → Members
(owner only). `ptd actions` — or `GET /api/actions` — always answers honestly for a
given token, so check what a seat can actually do rather than assuming.

### Managing tokens

| Route | Effect |
|---|---|
| `GET /api/tokens` | List your tokens in this organization (prefix, last used, expiry — never the secret) |
| `POST /api/tokens` | `{name, expiresInDays?}` → a new token for this user and organization |
| `POST /api/tokens/rotate` | Revoke every one of your tokens in this organization and mint a replacement |
| `DELETE /api/tokens/:id` | Revoke one |

A token is bound to one organization. `lastUsedAt` is updated at most once a minute
per token, so it is a liveness signal, not an audit log — `task.history` is the
audit log.

## MCP

`POST /mcp`, streamable HTTP, `Authorization: Bearer ptd_…`. The server is built
per request and registers **only the tools the caller's role allows**, so an agent
does not see a tool it would be refused for.

### Claude Code

```bash
claude mcp add --transport http ptd https://ptd.example/mcp \
  --header "Authorization: Bearer ptd_…"
```

### Claude Desktop / Cursor and other JSON-configured clients

```json
{
  "mcpServers": {
    "ptd": {
      "type": "http",
      "url": "https://ptd.example/mcp",
      "headers": { "Authorization": "Bearer ptd_…" }
    }
  }
}
```

A client that speaks only stdio needs a bridge such as `mcp-remote`; the transport
PTD serves is HTTP.

### Claude.ai and ChatGPT connectors

Hosted connectors cannot be handed a pasted token, so PTD is also an **OAuth 2.1
authorization server**. Add `https://ptd.example/mcp` as a custom connector and the
client discovers the rest itself:

1. `POST /mcp` without a token → `401` plus
   `WWW-Authenticate: Bearer realm="ptd", resource_metadata="…/.well-known/oauth-protected-resource"`
2. `GET /.well-known/oauth-protected-resource` → this resource and its authorization
   server (RFC 9728)
3. `GET /.well-known/oauth-authorization-server` → endpoints, grants, PKCE (RFC 8414)
4. `POST /oauth/register` → the client registers itself (RFC 7591)
5. `GET /oauth/authorize` → a consent screen where **you** sign in and pick the
   organization to grant
6. `POST /oauth/token` → authorization code + PKCE verifier → an access token
7. `POST /mcp` with that token → tools, gated by your membership role

| Property | Value |
|---|---|
| Resource | `https://ptd.example/mcp` |
| Grant types | `authorization_code`, `refresh_token` |
| Response types | `code` |
| PKCE | `S256` required |
| Client auth | `none` (public clients), `client_secret_post`, `client_secret_basic` |
| Scopes | `ptd:member`, `ptd:manager` (default `ptd:member`). Recorded on the grant; what the token may actually do comes from your **membership role**, because the issued token is an ordinary API token |
| Revocation | `POST /oauth/revoke` (RFC 7009) |

The access token the flow issues **is an ordinary `ptd_` API token**, so `/mcp` has
exactly one verification path and a connector's access appears in `GET /api/tokens`
like any other credential. You can see and revoke grants yourself with
`oauth.my_grants` and `oauth.revoke_grant`; an admin can list and revoke registered
clients with `oauth.clients` and `oauth.revoke_client`.

Because the connector acts as *you*, its entries are attributed to your seat. An
agent that should be accounted for separately needs its own seat and its own token.

## Reporting tokens and cost

```jsonc
// time_entry.stop
{ "tokensUsed": 132900, "apiCostUsd": 1.74, "notes": "csrf middleware + 38 form patches" }
```

```jsonc
// time_entry.log_past — work already finished before the agent got round to reporting
{
  "taskId": 3,
  "checkIn":  "2026-09-20T09:00:00Z",
  "checkOut": "2026-09-20T09:41:00Z",
  "tokensUsed": 98400,
  "apiCostUsd": 1.29,
  "notes": "second pass"
}
```

Rules worth knowing before you wire this up:

- Both fields are **stored only for agent-sourced entries.** A human credential
  sending them gets them dropped, listed back in `ignored` with the reason. Nothing
  fails — but nothing is recorded either.
- `apiCostUsd` is in US dollars, stored as a 32-bit float and read back rounded to
  four decimals. Report the real number; don't pre-round to cents.
- Neither field can be corrected later. `time_entry.update` cannot touch
  `entry_source`, the agent label, `tokensUsed` or `apiCostUsd` — that immutability
  is what makes the human-vs-agent ledger trustworthy. Get them right on `stop`, or
  delete the entry and log it again.
- A single entry may not span more than 24 hours, and `checkOut` may not be in the
  future.

Where the numbers surface: `task.totals` (per task, split by source),
`stream.totals` (per stream, with `overBudget` when a stream's agent budget is
passed), `today_summary`, and the `stats` roll-up.

## The `next_task` loop

The pattern an autonomous worker should use:

```
loop:
  result = next_task {}                     # highest-priority claimable card + why
  if result.task == null: sleep, continue

  task.set_assignee { taskId, userId: me }  # manager+; skip if you cannot
  time_entry.start  { taskId }

  …do the work…

  time_entry.stop   { tokensUsed, apiCostUsd, notes }
  task.complete     { taskId, note }        # a member may complete only its own card
```

Why this is safe to run unattended:

- `next_task` returns **one** card, status `backlog` or `triaged`, and by default
  only work that is unclaimed or already assigned to the caller — so two workers
  polling the same queue stop being offered a card once it is claimed.
- It comes with `why`: the formula, the band and an explanation, so a decision to
  work on something is auditable rather than opaque.
- `time_entry.start` refuses to open a second session while one is running (`409`),
  so a crashed loop that restarts cannot double-count. Read `time_entry.current`
  first, or stop the stale entry.
- `task.find_or_create` is idempotent on `externalKey`: calling it twice with the
  same key returns the same card. Use it when work arrives from somewhere else.
- Every mutation lands in `task.history` with `via: "mcp"` (or `"api"`), so what the
  agent did is reviewable afterwards.

A `member` cannot assign a card to itself. Either give the seat `manager`, or have a
human assign work and poll with `assignee: "me"`.

## Discovery

```bash
curl -s https://ptd.example/.well-known/ai-agent.json   # every action + inputs, as JSON
curl -s https://ptd.example/llms.txt                    # the same, one line per tool
curl -s https://ptd.example/openapi.json                # OpenAPI 3.1
```

None of the three needs a credential, and each lists the whole registry. What a
*particular* token may run is `GET /api/actions`.
