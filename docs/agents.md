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

All of that is still the agent's own arithmetic. **Verified usage**, below, is how
something else gets to say the same number.

## Verified usage

The figures above are the agent's own word. The launch objection writes itself — *why
would an agent report its own cost honestly?* — so PTD keeps a second set of columns for
what something **other than the agent** measured, and never overwrites the first:

| Column | Written by | Means |
|---|---|---|
| `tokens_used`, `api_cost_usd` | `time_entry.stop` / `log_past` | what the seat said it spent |
| `verified_tokens`, `verified_cost_usd` | `time_entry.attest` | what a hook, a build or the provider measured |
| `verified_source` | `time_entry.attest` | `claude_code_hook`, `ci` or `provider` |
| `verified_at` | `time_entry.attest` | when the attestation was written |

Both survive, so the claim and the evidence can be compared forever.

### `time_entry.attest`

```jsonc
{
  "entryId": 42,
  "tokens": 143793,
  "source": "claude_code_hook",
  "evidence": {
    "model": "claude-opus-5",
    "inputTokens": 363, "outputTokens": 2430,
    "cacheReadTokens": 138000, "cacheCreationTokens": 3000,
    "turns": 14,
    "transcriptSha256": "9b736ae2a2393bf1…"
  }
}
```

- **Members attest their own entries; manager and above anyone's** — the same gate
  `time_entry.update` uses.
- **Only agent-sourced, already-closed entries.** Verified usage on a human session would
  mean nothing, and an open session has no final figure.
- **`costUsd` is optional.** Omit it and, when `evidence` names a `model`, PTD prices the
  tokens from its own table — cache reads at 0.1× and 5-minute cache writes at 1.25× the
  input rate (1-hour writes at 2×, via `evidence.cacheTtl`). With neither a cost nor a
  priceable model the tokens are verified and the cost is left **unset**, never stored as
  a zero that would read as "this session was free".
- **Re-attesting replaces the previous figure** — a hook that fires twice is harmless —
  while the task history keeps every attestation as a `time_logged` event reading
  `usage attested (claude_code_hook): 143793 tok · $0.15 · reported 100000 tok (+43793)`.
- `usage.price` is the same table exposed read-only, so a hook can report a cost on
  `stop` that matches the one the server will derive on `attest`.

### Reading it back — `usage.summary` (manager)

```jsonc
{
  "totals": {
    "entries": 19, "verifiedEntries": 7, "coveragePct": 36.8,
    "reported":   { "tokens": 1893000, "costUsd": 13.82 },
    "verified":   { "tokens": 2040700, "costUsd": 1.21  },
    "delta":      { "tokens": 147700,  "costUsd": -0.26 },
    "unverified": { "tokens": 958300,  "costUsd": 12.87 }
  },
  "byAgent":  [ /* the same shape per seat   */ ],
  "byStream": [ /* the same shape per stream */ ],
  "discrepancies": [ /* every session whose gap exceeds tolerance, with a direction */ ],
  "narrative": "7 of 19 agent sessions carry independent usage evidence (36.8% coverage)…"
}
```

`delta` is `verified − reported`, so a **positive** number means the seat under-reported.
Tolerance before a session is named is 5% of the verified figure or 1,000 tokens,
whichever is larger. Overview → Agents draws this as a coverage bar per seat, with a
`verified` glyph on each stream row.

### The Claude Code hook pack

`hooks/claude-code/` in the repository: two POSIX `sh` scripts (plus their shared
plumbing) that need only `curl` and either `python3` or `node`.

```sh
mkdir -p ~/.claude/ptd && cd ~/.claude/ptd
BASE=https://raw.githubusercontent.com/danimoya/ptd/main/hooks/claude-code
curl -fsSLO $BASE/ptd-hook-common.sh
curl -fsSLO $BASE/ptd-session-start.sh
curl -fsSLO $BASE/ptd-session-stop.sh
chmod +x ptd-session-*.sh
```

```json
{
  "env": { "PTD_URL": "https://ptd.example", "PTD_TOKEN": "ptd_…" },
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume",
        "hooks": [{ "type": "command", "command": "$HOME/.claude/ptd/ptd-session-start.sh", "timeout": 30 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "$HOME/.claude/ptd/ptd-session-stop.sh", "timeout": 30 }] }
    ]
  }
}
```

`SessionStart` opens an entry on `$PTD_TASK`, else a `.ptd-task` file at or above the
working directory, else `next_task {assignee:"me"}`. `Stop` sums every assistant turn's
`usage` block in the transcript at `transcript_path` (de-duplicated by `message.id`),
stops the entry with that figure, then attests it with the transcript's SHA-256, the turn
count and the model. Both are idempotent and both always exit 0 — a tracker that can fail
a coding session is a tracker people turn off. Full reference:
[`hooks/claude-code/README.md`](../hooks/claude-code/README.md).

### Any other agent — `ptd agent-run`

```sh
ptd agent-run --task SEC-3 -- python fix_forms.py
```

Opens an entry, runs the command, closes the entry with whatever the command reported, and
attests it. The command's exit code becomes the CLI's, so it can stand in for the command
it wraps in a Makefile or a CI step. The wrapped program reports usage either way round:

```sh
# 1. a JSON file at $PTD_TOKENS_FILE — set for the child automatically
echo '{"usage":{"input_tokens":363,"output_tokens":2430,"cache_read_input_tokens":138000},"model":"claude-opus-5"}' > "$PTD_TOKENS_FILE"

# 2. or a marker on stdout (the last one wins)
echo 'PTD_USAGE {"tokens":143793,"model":"claude-opus-5"}'
```

Both accept camelCase or snake_case, unwrap a nested `usage` object, and derive the total
from the split when no total is given. The child also gets `$PTD_ENTRY_ID` and
`$PTD_TASK_ID`. With nothing reported the entry is still stopped — the time was real — but
nothing is attested.

### CI — `ptd ci-report` and the GitHub Action

```sh
ptd ci-report --task SEC-3 --tokens 143793 --model claude-opus-5 --minutes 4
ptd ci-report --entry 42 --usage-file usage.json     # attest an entry an earlier step opened
cat build.log | ptd ci-report --entry 42             # or read a PTD_USAGE marker from a log
```

`GITHUB_REPOSITORY`, `GITHUB_WORKFLOW`, `GITHUB_JOB`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
`GITHUB_SHA`, `GITHUB_REF_NAME` and `GITHUB_ACTOR` become the attestation's evidence, with
a link to the run, so any figure can be traced back to the job that produced it.

The composite action wraps the same command:

```yaml
- uses: danimoya/ptd/.github/actions/ptd-report@main
  with:
    url: https://ptd.example
    token: ${{ secrets.PTD_TOKEN }}
    task: SEC-3
    usage-file: usage.json     # or: tokens / cost / model
    minutes: 4
```

It outputs `entry-id`, `verified-tokens` and `attested`. The token must belong to an
**agent seat**: PTD drops tokens and cost on a human session, and `ci-report` says so
rather than silently logging an unattestable entry.

### Reconciling against the provider (admin)

The strongest evidence is the organization's own invoice, because an agent never holds the
credential that reads it.

```jsonc
// usage.connect_provider — admin only, sealed with PTD_SECRET_KEY, never returned
{ "provider": "anthropic", "adminApiKey": "sk-ant-admin01-…" }

// usage.reconcile — admin only
{ "provider": "anthropic", "from": "2026-08-01", "to": "2026-08-31" }
```

PTD reads Anthropic's `/v1/organizations/usage_report/messages` and `/v1/organizations/cost_report`
(or OpenAI's `/v1/organization/usage/completions` and `/v1/organization/costs`), sums the
period, compares it with what the agents booked into the ledger, and stores one
`usage_reconciliations` row:

| Status | Means |
|---|---|
| `match` | inside tolerance — 5% of the provider's figure or 10,000 tokens, whichever is larger |
| `under_reported` | the provider billed for more tokens than the ledger accounts for |
| `over_reported` | the ledger claims more than the provider billed |
| `unavailable` | the provider could not be read; the error is in `detail.providerError` |

The two totals are **not commensurable to the token** — a provider bill includes keys PTD
never sees, and PTD's ledger may include agents on a provider this reconciliation did not
query — so a verdict is a signal to go and look, and `detail` carries the gap, the
tolerance, the attestation coverage, the per-model breakdown and the per-agent split to
look with. `usage.reconciliations` (manager) is the history; Org → Agents draws it.

Set `PTD_USAGE_ANTHROPIC_BASE_URL` / `PTD_USAGE_OPENAI_BASE_URL` to point the fetcher at a
proxy or a stub (a per-organization `baseUrl` on the connect call does the same thing).

### Hard budgets

`streams.agent_budget_usd` has always been a number a bar was drawn against.
`streams.budget_mode` makes it load-bearing:

```jsonc
// stream.set_budget — manager
{ "streamId": 4, "agentBudgetUsd": 40, "budgetMode": "enforce" }
```

| Mode | Effect |
|---|---|
| `alert` (default) | over-budget is reported — the bar turns red, the digest says so |
| `enforce` | once month-to-date agent spend reaches the ceiling, `next_task` stops offering that stream's cards to **agent** credentials, a `budget.exhausted` webhook fires (once per stream per day) and `budget.check` answers `blocked: true` |

Humans are never blocked. Spend counts the **verified** cost of a session where one exists
and the self-reported cost otherwise, so under-reporting cannot buy extra runway.

```jsonc
// budget.check {streamId} — member
{ "streamId": 4, "name": "API v2", "mode": "enforce", "budgetUsd": 40,
  "spentUsd": 3.58, "remainingUsd": 36.42, "burnPct": 9,
  "overBudget": false, "enforced": true, "blocked": false,
  "periodStart": "2026-09-01T00:00:00.000Z" }
```

Omit `streamId` for every live lane plus a `blocked` list — the check an autonomous worker
should make before it starts, so it can pick a different lane rather than discover the
refusal as an empty queue.

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
- A stream whose `budgetMode` is `enforce` and whose month is spent is skipped for agent
  credentials, and the lanes that were skipped come back in `skippedStreams` — so the loop
  can say why it went elsewhere instead of looking like it ran out of work. `budget.check`
  answers the same question before you start.

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
