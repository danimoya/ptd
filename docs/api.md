# HTTP API

> The **Action reference** at the end of this file is generated from the live
> registry by `scripts/gen-docs.ts` (`npm run docs`). Everything above it is
> written by hand; edits inside the generated block are overwritten.

Every operation in PTD is a **registry action** with a name, a minimum role and a
zod input schema. The REST face of that registry is one endpoint shape:

```
POST /api/actions/<name>
Authorization: Bearer <JWT or ptd_… token>
X-Org-Id: <id>            # optional
Content-Type: application/json

{ …the action's arguments… }
```

The role check lives on the action, so this endpoint can do exactly what the same
credential can do over MCP, in Slack or in the web client — no adapter has a
bypass, and none has a privilege the others lack.

A machine-readable description of the same registry is served at
`GET /openapi.json` (OpenAPI 3.1, one path per action with JSON Schema for each
input) and `GET /.well-known/ai-agent.json`.

## Authentication

Two kinds of bearer credential reach the same middleware:

| Credential | Looks like | Lifetime | `authType` |
|---|---|---|---|
| Session JWT | `eyJ…` | 7 days | `human`, or `agent` if the account is an agent seat |
| API token | `ptd_` + 8 hex prefix + 32 hex secret | Until revoked, or its optional expiry | `agent` |

`authType` is what decides whether a time entry is recorded as human or agent
work, and it comes from the credential — never from a request field. See
[concepts.md](concepts.md#attribution-human-or-agent).

### Getting a JWT

```bash
curl -s https://ptd.example/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"…"}'
# → {"user":{…},"token":"eyJ…"}
```

| Route | Purpose |
|---|---|
| `POST /api/auth/register` | `{email, password, displayName?, orgName?}` → a user, a new organization they own, and a token |
| `POST /api/auth/login` | `{email, password}` → `{user, token}` |
| `GET /api/auth/me` | `{user, authType, orgs:[{orgId, name, slug, plan, role}]}` |
| `GET /api/orgs` | The organizations this credential belongs to, with the role in each |

`POST /api/auth/register` and `POST /api/auth/login` are rate limited to 20
attempts per 15 minutes per IP.

### Getting an API token

- **For an agent:** `POST /api/agent/register` creates the seat and returns a token
  once. See [agents.md](agents.md).
- **For yourself:** `POST /api/tokens {name, expiresInDays?}` mints one for the
  current user and organization. `GET /api/tokens` lists them (prefix only — the
  secret is stored as a scrypt hash and is never readable again),
  `POST /api/tokens/rotate` revokes all of yours in this organization and mints a
  replacement, `DELETE /api/tokens/:id` revokes one.
- **For a connector** (Claude.ai, ChatGPT): the OAuth 2.1 flow issues an ordinary
  `ptd_` token. See [agents.md](agents.md#claudeai-and-chatgpt-connectors).

## Choosing the organization

A credential may reach several organizations. The one a request acts in is
resolved in this order:

1. `X-Org-Id: <id>`
2. `?orgId=<id>`
3. the organization a `ptd_` token was minted for
4. the caller's oldest membership

Naming an organization the caller is not a member of is `403`. Sending nothing
when the account has no membership at all is `409`.

Always send `X-Org-Id` in a script that touches more than one organization —
relying on "oldest membership" is how a nightly job ends up writing to the wrong
one.

## Listing what you may call

```bash
curl -s https://ptd.example/api/actions -H "Authorization: Bearer $PTD_TOKEN"
```

Returns only the actions this caller's role allows, each as
`{name, title, description, surface, requiredRole}`. It is the honest answer to
"what can this credential do", and it is what the CLI's `ptd actions` prints.

## Errors

Action failures answer with a JSON body and a matching status:

```json
{ "error": "forbidden", "message": "stats requires role manager or higher (you are member)" }
```

| Status | `error` | Means |
|---|---|---|
| 400 | `invalid` | The arguments failed the schema. `message` names each bad field |
| 401 | — | Missing, malformed or rejected credential |
| 403 | `forbidden` | Authenticated, but the role is too low — or a finer rule refused (completing someone else's task, reading another member's ledger) |
| 404 | `not_found` | Unknown action name, or a named id that does not exist in this organization |
| 409 | `conflict` | The state does not allow it: a second timer, a duplicate `externalKey`, an entry open longer than 24 hours |
| 429 | — | Rate limited |
| 500 | `internal` | A bug. The detail is in the server log, not the response |

Note that 404 covers both "no such action" and "no such id in this organization" —
a valid id from another organization is reported as missing rather than forbidden,
so the endpoint cannot be used to probe for ids that exist elsewhere.

## Rate limits

| Scope | Limit |
|---|---|
| Everything under `/api` | 300 requests/minute |
| `/api/auth/*`, `POST /api/agent/register` | 20 per 15 minutes |
| OAuth client registration, CSV upload | 10/minute |

Standard `RateLimit-*` headers are returned. Limits are per IP, and PTD trusts one
proxy hop, so put exactly one reverse proxy in front.

## Worked example

```bash
BASE=https://ptd.example
TOKEN=ptd_…

# What can I do here?
curl -s $BASE/api/actions -H "Authorization: Bearer $TOKEN" | jq -r '.[].name'

# Pull the highest-priority open task, with the arithmetic behind its score.
curl -s $BASE/api/actions/next_task -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}'

# Start a timer on it, work, then report what the session cost.
curl -s $BASE/api/actions/time_entry.start -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"taskId":3,"notes":"csrf middleware"}'

curl -s $BASE/api/actions/time_entry.stop -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tokensUsed":132900,"apiCostUsd":1.74,"notes":"38 forms patched"}'

# Minutes on that task, split human vs agent.
curl -s $BASE/api/actions/task.totals -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"taskId":3}'
```

An empty body is `{}`, not nothing: actions that take no arguments still expect a
JSON object.

---

# Action reference

<!-- BEGIN GENERATED ACTIONS -->

_161 actions, generated from the registry by `scripts/gen-docs.ts` (`npm run docs`). Do not edit this block by hand._

| surface | actions | minimum role of each |
|---|---|---|
| overview | 18 | 7 × `member`, 10 × `manager`, 1 × `admin` |
| plan | 37 | 15 × `member`, 22 × `manager` |
| track | 40 | 28 × `member`, 11 × `manager`, 1 × `admin` |
| org | 66 | 20 × `member`, 5 × `manager`, 32 × `admin`, 9 × `owner` |

### Overview — backlog, apps, KPIs, webhooks

`ai.status` · `ai.usage` · `app.create` · `app.get` · `app.list` · `app.stats` · `app.update` · `budget.check` · `digest.preview` · `hybrid.summary` · `next_task` · `stats` · `stream.set_budget` · `stream.systemic` · `task.suggest_priority` · `task.suggest_priority_batch` · `tasks.query` · `usage.summary`

#### `ai.status`

**AI status** · role `member` and above

Whether AI is available to this organization and whose key would answer: its own (connected with ai.connect, billed by the provider) or this deployment's (billed on at cost plus 20% on Team and Business). Never returns a key — only the provider, the model and the last four characters. The only AI action that works unconfigured.

Takes no arguments.

#### `ai.usage`

**AI usage** · role `admin` and above

Tokens and estimated dollars this organization has spent on AI suggestions, from the ai_usage ledger: one row per provider call, so the numbers survive a restart and are the same on every app replica. Totals for the window (30 days by default, up to 365) with breakdowns by day, by member, by model and by action. Costs are estimates from a static price table; `meterCents` is what those calls would be billed on for at cost plus 20% when PTD's key answered them. `thisProcess` is the last 500 calls this server process happened to make — the same ledger seen through a keyhole, useful right after a batch run.

| field | type | | meaning |
|---|---|---|---|
| `days` | integer | optional | How many days back to count, 1–365 (default 30). |

#### `app.create`

**Create app** · role `manager` and above

Register an app the organization owns. `key` is the short slug used in tables and filters and must be unique within the organization.

| field | type | | meaning |
|---|---|---|---|
| `key` | string | required | Short lowercase slug, e.g. `web` or `core-api`. |
| `name` | string | required | Human-readable name. |
| `urls` | effects[] | optional | Live http(s) URLs for the app. |
| `repo` | string | optional | Repository reference, e.g. `github:acme/web`. |
| `stack` | string[] | optional | Technologies, e.g. ["Rust","Postgres"]. |

#### `app.get`

**Get app** · role `member` and above

One app with its URLs, repo, stack, streams and computed task counters.

| field | type | | meaning |
|---|---|---|---|
| `appId` | integer | required | App id, from app.list. |

#### `app.list`

**List apps** · role `member` and above

Every app (product / service / codebase) the organization tracks, each with its open-task count, critical count, highest open priority and the streams touching it.

| field | type | | meaning |
|---|---|---|---|
| `includeArchived` | boolean | optional | Include archived apps (default false). |

#### `app.stats`

**App stats** · role `manager` and above

Open tasks, critical tasks (priority ≥ 75), highest open priority and the streams touching one app.

| field | type | | meaning |
|---|---|---|---|
| `appId` | integer | required | App id, from app.list. |

#### `app.update`

**Update app** · role `manager` and above

Change an app's name, URLs, repo, stack or archived flag. Omitted fields are left alone. The key is immutable — it is what external references point at.

| field | type | | meaning |
|---|---|---|---|
| `appId` | integer | required | App id, from app.list. |
| `name` | string | optional |  |
| `urls` | effects[] | optional |  |
| `repo` | string | optional, nullable |  |
| `stack` | string[] | optional |  |
| `archived` | boolean | optional | Archive hides the app from app.list and the KPI count without deleting its history. |

#### `budget.check`

**Check an agent budget** · role `member` and above

Where a stream stands against its monthly agent budget: `{ streamId, name, mode, budgetUsd, spentUsd, remainingUsd, burnPct, overBudget, enforced, blocked, periodStart }`. Omit streamId and you get `{ streams: [...], blocked: [...], totals }` for every live lane instead. `blocked: true` means an agent credential will be refused this lane's work by `next_task` — the check an autonomous worker should make before it starts, so it can pick a different lane rather than discover the refusal as an empty queue. Spend is month-to-date and prefers the verified cost of each session over the self-reported one.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer | optional | One stream, or omit for every live stream. |

#### `digest.preview`

**Preview the weekly digest** · role `manager` and above

Render the last seven days of the hybrid summary as an email — subject, HTML and plain text — without sending it. The body is the same computed narrative, the same figures and the same per-stream agent spend the Overview → Hybrid tab shows. No scheduler: fetch it on your own cadence.

| field | type | | meaning |
|---|---|---|---|
| `days` | integer | optional | Window length in days, counting back from today (default 7). |

#### `hybrid.summary`

**Hybrid summary** · role `manager` and above

The human/agent split for the whole organization over one window: `series` (worked minutes per day or week, split human vs agent, with the agent's tokens and dollars), `byStream` (the same split per stream, plus each stream's agent budget, burn percentage and whether it is over), `byApp` (split by the app the worked task belongs to), `topAgents` (minutes, tokens, dollars and tasks closed per agent seat), `perCompletedTask` (median and mean agent minutes/tokens/dollars for the tasks completed in the window, counted over each task's whole life so work done before the window still counts), `totals`, and `narrative` — one computed paragraph stating the split, where the money went and whether the budget held. Defaults to the last 30 days bucketed by day. Breaks and still-running sessions are excluded: a break is not work and an open session has no duration to report.

| field | type | | meaning |
|---|---|---|---|
| `from` | string | optional | Start of the window as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | optional | End of the window as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `groupBy` | `day` \| `week` | optional | Bucket size for `series`. Weeks start on Monday, in the caller's local time. |

#### `next_task`

**Next task** · role `member` and above

The single highest-priority task still worth starting (status backlog or triaged), plus `why` — the urgency/impact/effort arithmetic behind its score. By default it only offers work nobody has claimed or work already assigned to you, which makes it safe to poll in an autonomous loop. When the caller is an **agent** credential, streams whose `budgetMode` is `enforce` and whose month-to-date agent spend has reached their `agentBudgetUsd` are skipped, and the skipped lanes come back in `skippedStreams` so the agent can say why it went elsewhere. A human caller is never budget-limited.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer \| `"none"` \| null | optional | Restrict to one stream, or null / "none" for work filed against no stream. |
| `appId` | integer \| `"none"` \| null | optional | Restrict to one app, or null / "none" for work filed against no app. |
| `assignee` | `"me"` \| `"any"` \| `"none"` \| null \| integer | optional | Override the default filter: "me", null / "none" (unassigned only), "any" (ignore assignment), or a user id. |

#### `stats`

**Organization stats** · role `manager` and above

KPI roll-up for the whole organization: task counts by status, counts by priority band (critical 75-100, high 50-74, medium 25-49, low 0-24), overdue work, app and stream inventory, human vs agent seats, agent minutes/tokens/dollars (all-time and last 7 days), and the 20 most recent task events made by agents.

Takes no arguments.

#### `stream.set_budget`

**Set a stream's agent budget** · role `manager` and above

The monthly ceiling on agent spend in one stream, and what happens when it is reached. `alert` (the default) is the behaviour PTD has always had: the Overview bar turns red and the digest says so, but nothing stops. `enforce` makes it a wall — once month-to-date agent spend in that lane reaches the budget, `next_task` stops offering the lane's cards to agent credentials, a `budget.exhausted` webhook fires (once per stream per day), and `budget.check` answers `blocked: true`. Humans are never blocked. Spend counts the verified cost of a session where one exists and the agent's self-reported cost otherwise, so under-reporting cannot buy extra runway. Pass agentBudgetUsd: null to remove the ceiling; enforce mode with no ceiling enforces nothing.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer | required | Stream id, from stream.list. |
| `agentBudgetUsd` | number | optional, nullable | Monthly ceiling in USD, or null to remove it. |
| `budgetMode` | `alert` \| `enforce` | optional | alert = warn only (default). enforce = refuse agent work once spent. |

#### `stream.systemic`

**Systemic streams** · role `member` and above

Streams whose work crosses several apps at once — the cross-cutting concerns worth fixing at the platform level rather than app by app.

| field | type | | meaning |
|---|---|---|---|
| `minApps` | integer | optional | Minimum number of apps a stream must touch (default 2). |

#### `task.suggest_priority`

**Suggest a priority** · role `manager` and above

Ask the configured model for urgency, impact and effort on one card, with a short rationale and a confidence. The model sees the card (title, description, stream, app, dates, dependencies, assignee kind, status, tags, current score) and this organization's score distribution, so its numbers mean the same thing as the rest of the backlog. Read-only by default: it returns the proposal, the score PTD's formula derives from it, the delta against the current score and what the call cost. Pass apply:true to write it (prioritySource becomes 'ai', the rationale becomes the card's priorityNote, and one priority_changed event is recorded). A card whose score a human set by hand (prioritySource 'manual') is never written over unless you also pass overrideManual:true.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |
| `apply` | boolean | optional | Write the suggestion onto the card (default false — just propose). |
| `overrideManual` | boolean | optional | Allow apply to overwrite a score a human set by hand. Ignored without apply. |

#### `task.suggest_priority_batch`

**Suggest priorities in bulk** · role `manager` and above

Re-score up to 25 open cards in one go, optionally narrowed to one stream or app, highest-scored first. Runs a few calls at a time rather than all at once, so a big batch does not trip the provider's rate limit. Cards a human scored by hand are skipped without spending a call unless overrideManual is set. Returns one row per card — proposal, derived score, delta, whether it was written — plus the total tokens and dollars the run cost. One card failing is a row in the report, not the end of the batch.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer | optional | Only cards in this stream. |
| `appId` | integer | optional | Only cards filed against this app. |
| `limit` | integer | optional | How many cards to score, 1–25 (default 10). |
| `apply` | boolean | optional | Write every suggestion (default false — dry run). |
| `overrideManual` | boolean | optional | Include cards scored by hand, and allow apply to overwrite them. |

#### `tasks.query`

**Query tasks** · role `member` and above

Filter, sort and page the backlog server-side. Returns { items, total } so a caller can page without re-counting. Completed and wontfix tasks are hidden unless includeCompleted is true or an explicit status list asks for them. For streamId, appId and assignedTo, omitting the key means "no filter" while null (or the string "none") means "filed against nothing" — the same convention the Plan surface's task.list uses.

| field | type | | meaning |
|---|---|---|---|
| `search` | string | optional | Case-insensitive substring of the title or description. |
| `streamId` | integer \| `"none"` \| null | optional | Stream id, or null / "none" for tasks filed against no stream. |
| `appId` | integer \| `"none"` \| null | optional | App id, or null / "none" for tasks filed against no app — which is where cards land when a stream is detached from an app. |
| `status` | `backlog` \| `triaged` \| `in-progress` \| `completed` \| `wontfix`[] | optional | Explicit status whitelist; overrides includeCompleted. |
| `assignedTo` | integer \| `"me"` \| `"none"` \| null | optional | User id, "me" for the caller, or null / "none" for unassigned tasks. |
| `priorityMin` | integer | optional | Lowest priorityScore to include (0-100). |
| `priorityMax` | integer | optional | Highest priorityScore to include (0-100). |
| `effortMax` | integer | optional | Only tasks costing at most this much effort (0-10). |
| `tags` | string[] | optional | Match tasks carrying ANY of these tags. |
| `includeCompleted` | boolean | optional | Include completed and wontfix tasks (default false). |
| `sort` | `priority` \| `due` \| `updated` \| `title` | optional | priority (default), due, updated or title. |
| `order` | `asc` \| `desc` | optional | Sort direction; defaults to desc for priority/updated, asc for due/title. |
| `limit` | integer | optional | Page size, max 200 (default 25). |
| `offset` | integer | optional | Rows to skip (default 0). |

#### `usage.summary`

**Reported versus verified usage** · role `manager` and above

Whether this organization's agent-cost figures can be trusted, as arithmetic. For a window (default the last 30 days) it returns: `totals` and `byAgent` / `byStream` rows each carrying `reported` (what the agents said), `verified` (what a hook, a build or the provider proved), `delta` (verified − reported, so a positive number means under-reporting), `unverified` (self-reported spend nobody has attested) and `coveragePct` (attested sessions as a share of agent sessions); `discrepancies`, one line per session whose gap exceeds tolerance (5% of the verified figure, or 1000 tokens, whichever is larger), each with a direction; and `narrative`, one computed sentence. Breaks and still-running sessions are excluded — neither has a final usage figure. Manager and above, because it puts every seat's spend on one page.

| field | type | | meaning |
|---|---|---|---|
| `from` | string | optional | Start of the window as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | optional | End of the window as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |

### Plan — tasks, streams, scheduling, dependencies

`blocked_tasks` · `critical_path` · `field.archive` · `field.create` · `field.list` · `field.update` · `stream.attach_app` · `stream.create` · `stream.detach_app` · `stream.list` · `stream.move_tasks` · `stream.rename` · `stream.update` · `task.attachment_delete` · `task.attachment_list` · `task.comment_add` · `task.comment_delete` · `task.comment_list` · `task.complete` · `task.create` · `task.custom_values` · `task.delete` · `task.find_or_create` · `task.get` · `task.history` · `task.list` · `task.recur_list` · `task.recur_set` · `task.schedule` · `task.set_assignee` · `task.set_custom` · `task.set_dependencies` · `task.set_priority` · `task.unschedule` · `task.update` · `tasks_by_assignee` · `upcoming_due`

#### `blocked_tasks`

**Blocked tasks** · role `manager` and above

Cards waiting on at least one dependency that is neither complete nor already finished — the work that cannot legitimately start yet.

Takes no arguments.

#### `critical_path`

**Critical path** · role `manager` and above

The longest dependency chain in the organization weighted by estimated duration (totalDays/tasks), plus a full critical-path-method schedule in perTask: earliest/latest start and finish for every card, its float in days, and whether it has none left. Float is the slack a card has before it drags the whole plan; zero float is the critical path the Plan surface outlines in red.

Takes no arguments.

#### `field.archive`

**Archive a custom field** · role `manager` and above

Retire a field without losing what cards already recorded in it: the values stay in the database but stop being offered, returned or writable. Pass archived: false to bring it back.

| field | type | | meaning |
|---|---|---|---|
| `fieldId` | integer | required |  |
| `archived` | boolean | optional | Default true |

#### `field.create`

**Create a custom field** · role `manager` and above

Define an extra field on every card in the organization. The key every wire shape uses (`custom: { severity: "high" }`) is derived from the name once and then fixed, so renaming the field keeps existing payloads working.

| field | type | | meaning |
|---|---|---|---|
| `name` | string | required | Label shown on the card, e.g. "Customer severity" |
| `kind` | `text` \| `number` \| `date` \| `select` \| `multiselect` \| `checkbox` \| `url` | required | What the field holds |
| `options` | string[] | optional | Choices for a select or multiselect field; rejected for every other kind |
| `position` | integer | optional | Order in the card's Fields section, ascending |

#### `field.list`

**List custom fields** · role `member` and above

Every custom field defined for the organization, in display order, with its key, kind and options.

| field | type | | meaning |
|---|---|---|---|
| `includeArchived` | boolean | optional | Include archived fields (default false) |

#### `field.update`

**Update a custom field** · role `manager` and above

Rename a field, reorder it, change a select's options or (un)archive it. `kind` is immutable — the values already on cards were validated against it. An option still used by a card cannot be removed.

| field | type | | meaning |
|---|---|---|---|
| `fieldId` | integer | required |  |
| `name` | string | optional |  |
| `options` | string[] | optional | Choices for a select or multiselect field; rejected for every other kind |
| `position` | integer | optional |  |
| `archived` | boolean | optional |  |

#### `stream.attach_app`

**Attach an app to a stream** · role `manager` and above

Allow cards in this lane to be filed against the given app. Idempotent.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer | required |  |
| `appId` | integer | required |  |

#### `stream.create`

**Create stream** · role `manager` and above

Open a new swim-lane. Optionally attach the apps whose work will be filed under it; a card may only point at an app its stream owns.

| field | type | | meaning |
|---|---|---|---|
| `name` | string | required |  |
| `color` | string | optional, nullable | Lane colour, e.g. #8a3324 or an hsl triple |
| `appIds` | integer[] | optional | Apps to attach immediately |

#### `stream.detach_app`

**Detach an app from a stream** · role `manager` and above

Stop filing this lane's cards against the app. Any card in the lane still pointing at it has its appId cleared.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer | required |  |
| `appId` | integer | required |  |

#### `stream.list`

**List streams** · role `member` and above

Every work stream (swim-lane) in the organization with its colour, position, attached apps, agent budget and card counts. Cards with no stream are reported separately as `unstreamed`.

| field | type | | meaning |
|---|---|---|---|
| `includeArchived` | boolean | optional | Include archived streams (default true) |

#### `stream.move_tasks`

**Move every card between two streams** · role `manager` and above

Move all cards from one lane to another — this is also how you merge two lanes. Pass null on either side to mean 'the cards with no stream'. A card whose app is not attached to the target lane has its appId cleared and that is reported back.

| field | type | | meaning |
|---|---|---|---|
| `fromStreamId` | integer | required, nullable | Source lane, or null for unstreamed cards |
| `toStreamId` | integer | required, nullable | Target lane, or null to unfile the cards |

#### `stream.rename`

**Rename stream** · role `manager` and above

Rename a swim-lane. Writes one stream_renamed history row per card in the lane so a card's own history explains the new label.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer | required |  |
| `name` | string | required |  |

#### `stream.update`

**Update stream** · role `manager` and above

Change a lane's colour, archive state, board position or monthly agent budget in USD.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer | required |  |
| `color` | string | optional, nullable |  |
| `archived` | boolean | optional |  |
| `position` | integer | optional | Lane order on the board, ascending |
| `agentBudgetUsd` | number | optional, nullable | Spend ceiling for agent work in this lane |
| `customerId` | integer | optional, nullable | Customer this lane is billed to (null to unbill) |

#### `task.attachment_delete`

**Delete an attachment** · role `member` and above

Detach a file from its card. The uploader may always delete it; manager and above may delete anyone's. The stored bytes are removed once no other card in the organization references the same content.

| field | type | | meaning |
|---|---|---|---|
| `attachmentId` | integer | required | Attachment id, from task.attachment_list |

#### `task.attachment_list`

**List task attachments** · role `member` and above

Files attached to one card: filename, MIME type, size in bytes, sha256, who uploaded it, and the URL to download it from (`/api/plan/attachments/:id`). Upload with `PUT /api/plan/tasks/:id/attachments?filename=…`.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |

#### `task.comment_add`

**Comment on a task** · role `member` and above

Add a comment to any card in the organization. The body is markdown-lite — **bold**, _italic_, `code` and links — stored as written and sanitised when it is rendered. Writes one `updated` history row noted "commented" and fires a `task.commented` webhook.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |
| `body` | string | required | Markdown-lite text. Bold, italic, inline code, autolinked URLs and [text](url) links are rendered; everything else shows as written |

#### `task.comment_delete`

**Delete a comment** · role `member` and above

Remove a comment. Its author may always delete it; manager and above may delete anyone's.

| field | type | | meaning |
|---|---|---|---|
| `commentId` | integer | required | Comment id, from task.comment_list |

#### `task.comment_list`

**List task comments** · role `member` and above

Every comment on one card, oldest first, with each author's display name and whether they are an agent.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |

#### `task.complete`

**Mark task complete** · role `member` and above

Strike a card off the active board. A member may only complete a card assigned to themselves; manager and above may complete any card in the organization.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |
| `note` | string | optional | Why / what shipped — stored on the history row |

#### `task.create`

**Create task** · role `manager` and above

Draft a new card. Without a startDate it goes to the backlog; with one it is scheduled as in-progress and its dependents cascade forward. priorityScore is derived from urgency×impact/effort.

| field | type | | meaning |
|---|---|---|---|
| `title` | string | required |  |
| `description` | string | optional | HTML from the card editor, or plain text |
| `streamId` | integer | optional | Swim-lane the card belongs to |
| `appId` | integer | optional | Product/app the work lands in — must be attached to streamId when both are given |
| `externalKey` | string | optional | Stable id from the source system; unique per organization |
| `estimatedDuration` | integer | optional | Working length in days — the width of the Gantt bar |
| `startDate` | string | optional | Set it and the card lands on the timeline as in-progress; omit it and the card stays in the backlog |
| `dueDate` | string | optional | Hard deadline pin, independent of the duration |
| `dependencies` | integer[] | optional | Task ids that must finish first |
| `assignedTo` | integer | optional | Org member (human or agent) who owns the card |
| `urgency` | integer | optional | Urgency on a 0–10 scale |
| `impact` | integer | optional | Impact on a 0–10 scale |
| `effort` | integer | optional | Effort on a 0–10 scale |
| `tags` | string[] | optional |  |
| `status` | `backlog` \| `triaged` \| `in-progress` \| `completed` \| `wontfix` | optional | Overrides the startDate-derived default |

#### `task.custom_values`

**Custom field values in bulk** · role `member` and above

The `custom` bag for many cards at once, as `{ "<taskId>": { key: value } }`. What a table with custom-field columns needs — `task.get` per row would be one request per card. Omit taskIds for every card in the organization.

| field | type | | meaning |
|---|---|---|---|
| `taskIds` | integer[] | optional | Cards to read (default: all cards in the organization) |

#### `task.delete`

**Delete task** · role `manager` and above

Remove a card for good. Any card that depended on it has the reference stripped from its dependency list, so the graph stays consistent. Prefer task.complete for finished work — this is not reversible.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |

#### `task.find_or_create`

**Find or create a task by external key** · role `member` and above

Idempotent entry point for integrations and agents: returns the card whose externalKey matches inside this organization, or creates it in the backlog. Call it twice with the same externalKey and you get the same card back.

| field | type | | meaning |
|---|---|---|---|
| `title` | string | required | Used only when the card has to be created |
| `externalKey` | string | required | Stable id from the source system, e.g. JIRA-1234 or a GitHub issue URL |
| `streamId` | integer | optional | Stream to file a newly created card under |

#### `task.get`

**Get one task** · role `member` and above

A single card with its stream, app, assignee, expanded dependencies, the cards that depend on it, and whether it is currently blocked.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |

#### `task.history`

**Task history** · role `member` and above

Append-only audit log for one card: who changed what, when, and through which surface (web, mcp, slack, api, import). Most recent first.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |
| `limit` | integer | optional | Max rows (default 50) |

#### `task.list`

**List tasks** · role `member` and above

Tasks in the organization, newest-priority first. Filter by status, stream, app or assignee. Completed cards are excluded unless includeCompleted is true.

| field | type | | meaning |
|---|---|---|---|
| `status` | `backlog` \| `triaged` \| `in-progress` \| `completed` \| `wontfix` | optional | Exact status filter |
| `streamId` | integer | optional, nullable | Stream id, or null for cards with no stream |
| `appId` | integer | optional, nullable | App id, or null for cards with no app |
| `assignedTo` | integer | optional, nullable | Assignee user id, or null for unassigned cards |
| `includeCompleted` | boolean | optional | Include completed cards (default false) |

#### `task.recur_list`

**List recurring tasks** · role `member` and above

Every recurrence in the organization with its rule, a human reading of it, when it next fires and when it last did. Soonest first.

| field | type | | meaning |
|---|---|---|---|
| `includeInactive` | boolean | optional | Include cleared recurrences (default false) |

#### `task.recur_set`

**Set a task's recurrence** · role `manager` and above

Turn a card into a template that clones itself into a new backlog card on a schedule, or pass rule: null to stop it. Grammar: `daily`, `weekdays`, `weekly:mon,wed`, `monthly:15`, `every:3d`, `every:2w`, each optionally with `at:09:00`. Times are UTC. The clone copies title, description, stream, app, assignee, estimate, tags, priority inputs and custom values, and takes the external key `<templateKey>-<yyyymmdd>`.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |
| `rule` | string | required, nullable | A rule such as `weekly:mon,wed at:09:00`, or null to clear the recurrence |

#### `task.schedule`

**Schedule task** · role `manager` and above

Put a card on the timeline at a start date (optionally setting its duration), promote it out of the backlog, and cascade its dependents forward.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |
| `startDate` | string | required | ISO 8601 date, e.g. 2026-03-01 or 2026-03-01T00:00:00Z |
| `estimatedDuration` | integer | optional | Days — sets the bar width at the same time |

#### `task.set_assignee`

**Set task assignee** · role `manager` and above

Give a card to an org member — human or agent — or pass userId: null to unassign. The target must hold a membership in this organization; call org.members for valid ids.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |
| `userId` | integer | required, nullable | Member user id, or null to unassign |

#### `task.set_custom`

**Set a task's custom fields** · role `member` and above

Write custom field values on one card, keyed by field key. Each value is validated against its field's kind (number, date, select, multiselect, checkbox, url, text); null clears one. A member may only write to a card assigned to them; manager and above may write to any card.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |
| `values` | object<string, unknown> | required | `{ fieldKey: value }`. A select takes one of its options, a multiselect an array of them, a checkbox true/false, a date an ISO day; null clears the value |

#### `task.set_dependencies`

**Set task dependencies** · role `manager` and above

Replace a card's dependency list. Every id must be a task in this organization, cycles are rejected, and dependents cascade forward afterwards.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |
| `dependencies` | integer[] | required | Complete replacement list — pass [] to clear |

#### `task.set_priority`

**Set task priority** · role `manager` and above

Re-score a card. Passing manualScore pins priorityScore and flips prioritySource to 'manual'; otherwise the score is recomputed as urgency×impact/effort (clamped 0–100) with prioritySource 'formula'.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |
| `urgency` | integer | optional | Urgency on a 0–10 scale |
| `impact` | integer | optional | Impact on a 0–10 scale |
| `effort` | integer | optional | Effort on a 0–10 scale |
| `manualScore` | integer | optional, nullable | Override the formula; null drops an existing override |
| `note` | string | optional | Why this priority — stored on the card as priorityNote |

#### `task.unschedule`

**Unschedule task** · role `manager` and above

Take a card off the timeline and back into the backlog. Its due date, if any, is kept — only the start date is cleared.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |

#### `task.update`

**Update task** · role `manager` and above

Patch any subset of a card's fields. Cascades every dependent forward when startDate, estimatedDuration, dueDate or dependencies change; rejects dependency cycles; keeps a manual/ai priority score unless you go through task.set_priority.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | required | Task id |
| `title` | string | optional |  |
| `description` | string | optional, nullable |  |
| `status` | `backlog` \| `triaged` \| `in-progress` \| `completed` \| `wontfix` | optional |  |
| `streamId` | integer | optional, nullable | null detaches the card from its stream |
| `appId` | integer | optional, nullable | Must be attached to the card's stream; null clears it |
| `externalKey` | string | optional, nullable |  |
| `estimatedDuration` | integer | optional, nullable |  |
| `startDate` | string | optional, nullable | null unschedules the card back to the backlog |
| `dueDate` | string | optional, nullable | ISO 8601 date, e.g. 2026-03-01 or 2026-03-01T00:00:00Z |
| `dependencies` | integer[] | optional | Replaces the list; cycles are rejected |
| `assignedTo` | integer | optional, nullable |  |
| `urgency` | integer | optional | Urgency on a 0–10 scale |
| `impact` | integer | optional | Impact on a 0–10 scale |
| `effort` | integer | optional | Effort on a 0–10 scale |
| `tags` | string[] | optional |  |
| `completed` | boolean | optional |  |

#### `tasks_by_assignee`

**Tasks grouped by assignee** · role `manager` and above

Roster view: every member of the organization — humans and agents alike — with the cards they currently own, plus the unassigned pile.

Takes no arguments.

#### `upcoming_due`

**Upcoming deadlines** · role `manager` and above

Open cards whose due date — or computed end (startDate + duration) — falls within the next N days. Defaults to a week. Overdue cards are included and flagged.

| field | type | | meaning |
|---|---|---|---|
| `days` | integer | optional | Horizon in days (default 7) |

### Track — the timer, the ledger, reports, invoices

`customer.create` · `customer.delete` · `customer.goals` · `customer.list` · `customer.update` · `insights.patterns` · `insights.summary` · `invoice.contractor_generate` · `invoice.contractor_list` · `invoice.contractor_preview` · `invoice.generate` · `invoice.list` · `invoice.preview` · `invoice.recipients` · `invoice.share` · `invoice.unshare` · `invoice.void` · `report.compare` · `report.range` · `report.search` · `stream.totals` · `task.totals` · `template.create` · `template.delete` · `template.list` · `time_entry.approve` · `time_entry.attest` · `time_entry.current` · `time_entry.delete` · `time_entry.list` · `time_entry.log_past` · `time_entry.pending` · `time_entry.reject` · `time_entry.start` · `time_entry.stop` · `time_entry.submit` · `time_entry.switch_break` · `time_entry.update` · `today_summary` · `usage.price`

#### `customer.create`

**Add a customer** · role `manager` and above

Add a customer to the organization.

| field | type | | meaning |
|---|---|---|---|
| `name` | string | required | Customer name. |
| `weeklyGoalHours` | integer | optional, nullable | Hours a week this customer is meant to get. |
| `billingAddress` | string | optional, nullable | Postal address for invoices. |
| `billingEmail` | string | optional, nullable | Where invoices are sent. |

#### `customer.delete`

**Delete a customer** · role `manager` and above

Remove a customer. Time entries and streams that pointed at it keep their history but lose the reference.

| field | type | | meaning |
|---|---|---|---|
| `customerId` | integer | required | The customer to remove. |

#### `customer.goals`

**Weekly goal vs logged, per customer** · role `manager` and above

Every customer's weekly goal against what the organization actually logged for them this week, with the human/agent split and a per-stream breakdown. A session bills to the customer of the stream it sits in (falling back to the session's own customer when it has no stream). Monday-first weeks.

| field | type | | meaning |
|---|---|---|---|
| `weekOf` | string | optional | Any instant inside the week to report on. Defaults to this week. as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |

#### `customer.list`

**List customers** · role `member` and above

Customers in the organization, for attributing and billing time.

Takes no arguments.

#### `customer.update`

**Edit a customer** · role `manager` and above

Change a customer's name, weekly goal or billing details.

| field | type | | meaning |
|---|---|---|---|
| `customerId` | integer | required | The customer to edit. |
| `name` | string | optional | Customer name. |
| `weeklyGoalHours` | integer | optional, nullable | Hours a week this customer is meant to get. |
| `billingAddress` | string | optional, nullable | Postal address for invoices. |
| `billingEmail` | string | optional, nullable | Where invoices are sent. |

#### `insights.patterns`

**When the work happens** · role `member` and above

The shape of a window: minutes by hour of day and by weekday (human vs agent in both), a 7×24 heat matrix for the heat strip, break count and frequency, the longest unbroken stretch of work, and the peak hour and weekday. Defaults to the trailing 30 days.

| field | type | | meaning |
|---|---|---|---|
| `from` | string | optional | Start of the window as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | optional | End of the window as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `streamIds` | integer[] | optional | Restrict the report to these streams. Omit for every stream. |
| `userId` | integer \| `"all"` | optional | Whose ledger to report on. Manager and above only; "all" reports the whole organization. Defaults to the caller. |

#### `insights.summary`

**The window in plain English** · role `member` and above

Three to six sentences reading the window back: how much was logged and over how many sessions, what the agents logged and what their API cost came to, when the work clusters, the longest unbroken stretch, and how breaks were taken. Every figure is computed from the ledger — there is no language model in this path, and the same window always produces the same words.

| field | type | | meaning |
|---|---|---|---|
| `from` | string | optional | Start of the window as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | optional | End of the window as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `streamIds` | integer[] | optional | Restrict the report to these streams. Omit for every stream. |
| `userId` | integer \| `"all"` | optional | Whose ledger to report on. Manager and above only; "all" reports the whole organization. Defaults to the caller. |

#### `invoice.contractor_generate`

**Issue a certified contractor invoice** · role `manager` and above

Commit the month: freeze every billed entry into a signed snapshot, lock those entries against further edits, and hand back the invoice's verification URL and PDF. The snapshot records each entry's times and a hash of its immutable columns; the whole record is hashed and signed with the deployment's Ed25519 key, so anyone holding the document can confirm at the verification URL that PTD issued it and that the hours behind it have not moved since. Refuses a month with nothing to bill, and refuses entries an earlier invoice already claimed.

| field | type | | meaning |
|---|---|---|---|
| `userId` | integer | required | The external member being invoiced. |
| `month` | integer | required | Calendar month, 1–12. |
| `year` | integer | required | Calendar year. |
| `onlyApproved` | boolean | optional | Bill only entries a manager approved. Defaults to the member's own `requireApproval` setting, so a gated member is never invoiced for unapproved hours by accident. |

#### `invoice.contractor_list`

**Contractor invoices issued** · role `member` and above

Every certified contractor invoice, newest period first, with the member it was rendered for, the amount, whether it has been voided, and its verification URL and PDF. A member sees only their own.

| field | type | | meaning |
|---|---|---|---|
| `userId` | integer | optional | Only this member's invoices. |
| `limit` | integer | optional | Maximum rows (default 100). |

#### `invoice.contractor_preview`

**What a contractor's month would bill** · role `member` and above

The invoice an external member's month would produce: one line per day × stream × task with its minutes, whether a human or an agent produced them, the rate and the amount, plus the totals and how many minutes are being left out because they are unapproved. Nothing is written. The member may read their own; anyone else's needs manager or above.

| field | type | | meaning |
|---|---|---|---|
| `userId` | integer | required | The external member being invoiced. |
| `month` | integer | required | Calendar month, 1–12. |
| `year` | integer | required | Calendar year. |
| `onlyApproved` | boolean | optional | Bill only entries a manager approved. Defaults to the member's own `requireApproval` setting, so a gated member is never invoiced for unapproved hours by accident. |

#### `invoice.generate`

**Commit a month's invoice** · role `manager` and above

Issue the invoice: freeze the month's entries into a signed snapshot, lock them against further edits, and hand back the document's verification URL and PDF. The snapshot records each entry's times and a hash of its immutable columns; the record is hashed and signed with the deployment's Ed25519 key, so the customer — or their accountant — can confirm at the verification URL that this deployment issued the document and that the hours behind it have not moved since. Because the rows are now locked, re-issuing a month means voiding the first invoice with `invoice.void` rather than generating a second on top of it.

| field | type | | meaning |
|---|---|---|---|
| `customerId` | integer | required | The customer to bill. |
| `month` | integer | required | Calendar month, 1–12. |
| `year` | integer | required | Calendar year. |

#### `invoice.list`

**Invoices issued** · role `manager` and above

Every customer invoice recorded for the organization, newest period first, with the customer it was rendered to, who issued it, the total in minutes and money, whether it has been voided, and the URLs of its PDF and its public verification page. Contractor invoices have their own list — `invoice.contractor_list` — because a member may read their own.

| field | type | | meaning |
|---|---|---|---|
| `customerId` | integer | optional | Only this customer's invoices. |
| `limit` | integer | optional | Maximum rows (default 100). |

#### `invoice.preview`

**What a month's invoice would say** · role `manager` and above

The line items a customer's month would bill: one line per stream × task with its session count, human minutes, agent minutes, agent tokens, agent API cost, the hourly rate that applies and the amount, plus the totals and the agent spend as a pass-through figure. Nothing is written — this is the document a manager reads before committing to it. A stream's own hourly rate overrides the customer's; where neither is recorded the line states hours with no money attached.

| field | type | | meaning |
|---|---|---|---|
| `customerId` | integer | required | The customer to bill. |
| `month` | integer | required | Calendar month, 1–12. |
| `year` | integer | required | Calendar year. |

#### `invoice.recipients`

**Who may read an invoice** · role `member` and above

The invoice's recipient allowlist, masked: one row per named address with when it was added, whether PTD added it at issue (the contractor, a customer's billing address) or somebody shared it, how many access codes it has asked for and how many opened the details. Addresses are stored as a salted hash, so what comes back is `a••••a@example.com` and never the address. Manager and above, or the contractor the invoice is about.

| field | type | | meaning |
|---|---|---|---|
| `invoiceId` | integer | required | The certified invoice. |

#### `invoice.share`

**Share a certified invoice** · role `member` and above

Name the people who may read an invoice, and write to them. Each address is added to the invoice's recipient allowlist and sent the verification link with a note that a six-digit code will be emailed to that address when they ask for the details on the page. The link itself proves the document is genuine and shows nothing else, so forwarding it discloses nothing. Addresses are stored only as a salted hash and a mask — sharing the same address again re-sends the letter rather than adding it twice, and there is no way to read an address back out. Manager and above, or the contractor the invoice is about.

| field | type | | meaning |
|---|---|---|---|
| `invoiceId` | integer | required | The certified invoice to share. |
| `emails` | string[] | required | The addresses to name as recipients. Each is sent the link and told a code will be emailed to that address on request. |
| `message` | string | optional | A line of your own to include in the letter. |

#### `invoice.unshare`

**Withdraw access to an invoice** · role `member` and above

Take an address off an invoice's allowlist. Any code already sent to it is destroyed with it, so access that a letter in an inbox could still open is actually revoked. Because addresses are stored hashed, the address has to be typed in full; answers whether it was on the list. Manager and above, or the contractor the invoice is about.

| field | type | | meaning |
|---|---|---|---|
| `invoiceId` | integer | required | The certified invoice. |
| `email` | string | required | The address to remove, in full. |

#### `invoice.void`

**Void an invoice** · role `admin` and above

Withdraw an invoice of either kind: it is stamped voided, and the entries it froze are unlocked so they can be corrected and invoiced again. The snapshot, hash and signature are deliberately left in place — a copy of the PDF is still out there, and it must go on verifying, as voided. Admin and above; the reason is recorded in the organization's audit trail.

| field | type | | meaning |
|---|---|---|---|
| `invoiceId` | integer | required | The invoice to withdraw. |
| `reason` | string | required | Why it is being withdrawn. |

#### `report.compare`

**One period against another** · role `member` and above

The same roll-up for two windows side by side, with the difference and the percent change for total minutes, human minutes, agent minutes, agent tokens, agent cost, sessions, active days and break minutes. Each metric also carries a trend: an arrow, a direction, and whether that direction is the good one (for cost, tokens and breaks, down is good).

| field | type | | meaning |
|---|---|---|---|
| `current` | object | required | The period being judged. |
| `previous` | object | required | What to judge it against. |
| `groupBy` | `day` \| `week` \| `month` | optional | Bucket size. Weeks start on Monday; months are calendar months, both in the caller's local time. |
| `streamIds` | integer[] | optional | Restrict the report to these streams. Omit for every stream. |
| `includeBreaks` | boolean | optional | Count break minutes into each bucket's `breakMinutes`. Breaks never count as work either way. |
| `userId` | integer \| `"all"` | optional | Whose ledger to report on. Manager and above only; "all" reports the whole organization. Defaults to the caller. |

#### `report.range`

**Hours over a date range, bucketed** · role `member` and above

Recorded work between two instants, grouped by day, week or month. Every bucket splits human minutes from agent minutes and carries the agent's tokens and API cost, and each bucket is further split per stream. Breaks and still-running sessions never count as work. A member reports on their own ledger; manager and above may pass another member's userId, or "all".

| field | type | | meaning |
|---|---|---|---|
| `from` | string | required | Start of the range (inclusive, by when a session opened) as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | required | End of the range (inclusive, by when a session opened) as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `groupBy` | `day` \| `week` \| `month` | optional | Bucket size. Weeks start on Monday; months are calendar months, both in the caller's local time. |
| `streamIds` | integer[] | optional | Restrict the report to these streams. Omit for every stream. |
| `includeBreaks` | boolean | optional | Count break minutes into each bucket's `breakMinutes`. Breaks never count as work either way. |
| `userId` | integer \| `"all"` | optional | Whose ledger to report on. Manager and above only; "all" reports the whole organization. Defaults to the caller. |

#### `report.search`

**Search the ledger** · role `member` and above

Case-insensitive search across entry notes and the titles of the tasks entries point at, newest first, with the total number of matches and their total minutes. Filter by window, stream, task or a minimum session length. `%` and `_` in the query are matched literally.

| field | type | | meaning |
|---|---|---|---|
| `query` | string | required | Text to look for in a note or a task title. |
| `from` | string | optional | Only sessions that started at or after this instant as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | optional | Only sessions that started at or before this instant as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `streamId` | integer | optional | Only sessions in this stream. |
| `taskId` | integer | optional | Only sessions against this task. |
| `minMinutes` | integer | optional | Drop sessions shorter than this. |
| `limit` | integer | optional | Matches per page (default 25). |
| `offset` | integer | optional | How many matches to skip (default 0). |
| `userId` | integer \| `"all"` | optional | Whose ledger to report on. Manager and above only; "all" reports the whole organization. Defaults to the caller. |

#### `stream.totals`

**Minutes and agent spend per stream** · role `manager` and above

Organization-wide time per stream, split human vs agent, with the agent tokens and dollars each stream consumed in the window. `overBudget` is true when the stream has an agentBudgetUsd and agent cost in the window has passed it.

| field | type | | meaning |
|---|---|---|---|
| `from` | string | optional | Count only sessions that started at or after this instant as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | optional | Count only sessions that started at or before this instant as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |

#### `task.totals`

**Minutes per task, split human vs agent** · role `member` and above

Time booked against tasks, split by who did the work: human minutes on one side, agent minutes with their tokens and API cost on the other. Breaks and still-running entries are excluded. Always returns an array — a named taskId returns exactly one row, zeroed when nothing has been logged yet.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | optional | One task. Returns a single-element array. |
| `streamId` | integer | optional | Every task in this stream. |
| `from` | string | optional | Count only sessions that started at or after this instant as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | optional | Count only sessions that started at or before this instant as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |

#### `template.create`

**Save an entry template** · role `member` and above

Save a recurring entry — a stream, a customer, a note and an icon — so it can be started with one tap.

| field | type | | meaning |
|---|---|---|---|
| `name` | string | required | What it is called on the tile. |
| `icon` | string | optional | Icon slug (coffee, lunch, gym, commute, walk, call, read, rest, game, errand, outside, smoke, travel, think, partner, kids, other). |
| `notes` | string | optional | Note copied onto every entry started from this template. |
| `streamId` | integer | optional | Stream the template attaches to. |
| `customerId` | integer | optional | Customer the template attaches to. Defaults to the stream's customer. |
| `isBreak` | boolean | optional | Makes it a break tile rather than a work stencil. |

#### `template.delete`

**Delete an entry template** · role `member` and above

Remove one of the caller's own templates. Entries already started from it are untouched.

| field | type | | meaning |
|---|---|---|---|
| `templateId` | integer | required | The template to remove. |

#### `template.list`

**List entry templates** · role `member` and above

The caller's own saved entry templates — one-tap starts for recurring work and the break tiles.

Takes no arguments.

#### `time_entry.approve`

**Approve hours** · role `manager` and above

Sign off entries so they can be invoiced. Name the entries, or a member and a window to approve the lot. Who approved and when are written from your credential, not from the request. Entries already frozen into an invoice are refused rather than silently skipped, because approving them would change nothing.

| field | type | | meaning |
|---|---|---|---|
| `entryIds` | integer[] | optional | The entries to act on. Use this or userId + from + to. |
| `userId` | integer | optional | Act on this member's entries in the window instead of naming ids. |
| `from` | string | optional | Start of the window as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | optional | End of the window as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |

#### `time_entry.attest`

**Attest an entry's usage** · role `member` and above

Record what a finished agent session *actually* consumed, as measured by something other than the agent's own arithmetic. Writes verifiedTokens / verifiedCostUsd / verifiedSource / verifiedAt; the agent's self-reported tokensUsed and apiCostUsd are left untouched, so `usage.summary` can put the claim and the evidence side by side. `source` says who measured it: `claude_code_hook` (the Stop hook summed the session transcript), `ci` (a build reported the runner's usage), `provider` (reconciled against the provider's billing). `costUsd` is optional — omit it and, when `evidence` names a `model`, PTD prices the tokens itself from its own table (cache reads at 0.1× and cache writes at 1.25× the input rate); with neither, the tokens are verified and the cost is left unset rather than stored as zero. Members may attest their own entries, manager and above anyone's. Only agent-sourced, already-closed entries can be attested, and re-attesting replaces the previous figure (so a hook that fires twice is harmless) while the task history keeps both.

| field | type | | meaning |
|---|---|---|---|
| `entryId` | integer | required | The finished agent entry to attest — the `entry.id` time_entry.stop returned. |
| `tokens` | integer | required | Total tokens the session consumed, counting input, output and cache traffic. |
| `costUsd` | number | optional | USD cost, if the attester knows it. Omitted, PTD derives it from evidence.model. |
| `source` | `claude_code_hook` \| `ci` \| `provider` | required | Who measured this: claude_code_hook, ci or provider. |
| `evidence` | object<string, unknown> | optional | Free-form proof. Keys PTD reads: `model` (to price the tokens), `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheCreationTokens` (or their snake_case spellings) for an accurate price, and `cacheTtl` ("5m"\|"1h"). Everything else — transcriptSha256, turns, runId, commit — is stored on the task-history event verbatim. |

#### `time_entry.current`

**What is running** · role `member` and above

The caller's open entry with the minutes elapsed so far, or null when the clock is at rest.

Takes no arguments.

#### `time_entry.delete`

**Strike an entry** · role `member` and above

Remove an entry from the ledger for good. Own entries for a member; any entry in the organization for manager and above. An entry frozen into a certified invoice cannot be struck — void the invoice first, which releases it.

| field | type | | meaning |
|---|---|---|---|
| `entryId` | integer | required | The entry to strike. |

#### `time_entry.list`

**List entries** · role `member` and above

Ledger lines, newest first, with the stream / task / customer they point at and their source. A member sees their own; manager and above may pass another member's userId, or the string "all" for the whole organization.

| field | type | | meaning |
|---|---|---|---|
| `from` | string | optional | Only entries that started at or after this instant as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | optional | Only entries that started at or before this instant as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `taskId` | integer | optional | Only entries attributed to this task |
| `streamId` | integer | optional | Only entries attributed to this stream |
| `userId` | integer \| `"all"` | optional | Whose entries to read. Manager and above only; "all" reads every member's. |
| `limit` | integer | optional | Maximum lines to return (default 200). |

#### `time_entry.log_past`

**Log a finished session** · role `member` and above

Insert an already-finished entry with explicit checkIn and checkOut — how an agent records work it did before it got round to reporting. checkOut must be after checkIn and the span at most 24 hours. Tokens and cost are stored only if the calling credential is an agent's.

| field | type | | meaning |
|---|---|---|---|
| `checkIn` | string | required | When the session started as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `checkOut` | string | required | When the session ended as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `taskId` | integer | optional | Task to attribute the work to. Its stream (and that stream's customer) are adopted when you do not name them. |
| `streamId` | integer | optional | Stream (swim-lane) to attribute the work to. |
| `customerId` | integer | optional | Customer to bill the work to. Defaults to the stream's customer. |
| `notes` | string | optional | Free-text note shown on the ledger line. |
| `tokensUsed` | integer | optional | Model tokens this session consumed. Stored only when the entry's source is 'agent' — ignored, and reported back in `ignored`, for human sessions. |
| `apiCostUsd` | number | optional | API cost of this session in USD. Stored only when the entry's source is 'agent'. |
| `isBreak` | boolean | optional | Record it as a break rather than work. |

#### `time_entry.pending`

**Hours waiting for approval** · role `member` and above

Every entry in the organization waiting for a manager's signature, oldest first, with who logged it and how long it ran. A member sees only their own. This is the queue behind the approval chips on the ledger.

| field | type | | meaning |
|---|---|---|---|
| `userId` | integer | optional | Only this member's pending entries. |
| `limit` | integer | optional | Maximum rows (default 200). |

#### `time_entry.reject`

**Reject hours** · role `manager` and above

Send entries back with a reason: they become `rejected` and stop counting towards an invoice until the member corrects and resubmits them. The reason is recorded in the organization's audit trail rather than overwriting the member's own note on the line.

| field | type | | meaning |
|---|---|---|---|
| `entryIds` | integer[] | required | The entries to send back. |
| `reason` | string | required | Why they are being rejected. The member sees it in the audit trail. |

#### `time_entry.start`

**Start the timer** · role `member` and above

Open a time entry now, attributed to the caller. Refuses to open a second session while one is running — stop it first, or pass isBreak:true, which cuts the running session and opens the break in its place. Whether the entry reads as human or agent work is decided by the credential you called with, not by any argument.

| field | type | | meaning |
|---|---|---|---|
| `taskId` | integer | optional | Task to attribute the work to. Its stream (and that stream's customer) are adopted when you do not name them. |
| `streamId` | integer | optional | Stream (swim-lane) to attribute the work to. |
| `customerId` | integer | optional | Customer to bill the work to. Defaults to the stream's customer. |
| `notes` | string | optional | Free-text note shown on the ledger line. |
| `isBreak` | boolean | optional | Log a break (recess) instead of work. A break also cuts any running work session. |

#### `time_entry.stop`

**Stop the timer** · role `member` and above

Close the caller's open entry. An agent may report the tokens and API cost the session consumed; on a human session those two fields are dropped and named in `ignored`, because cost and tokens only mean something for agent work.

| field | type | | meaning |
|---|---|---|---|
| `tokensUsed` | integer | optional | Model tokens this session consumed. Stored only when the entry's source is 'agent' — ignored, and reported back in `ignored`, for human sessions. |
| `apiCostUsd` | number | optional | API cost of this session in USD. Stored only when the entry's source is 'agent'. |
| `notes` | string | optional | Replaces the entry's note, e.g. what the session actually achieved. |

#### `time_entry.submit`

**Submit your hours** · role `member` and above

Hand a window of your own finished entries to a manager for approval: every closed, non-break entry of yours in the range that is not already approved or invoiced moves to `pending`. This is what an external contractor does at the end of a month; entries that are already approved are left alone, and rejected ones go back to pending so a corrected line can be looked at again.

| field | type | | meaning |
|---|---|---|---|
| `from` | string | required | Start of the window to submit as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | required | End of the window to submit as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |

#### `time_entry.switch_break`

**Cut to a break** · role `member` and above

Close whatever is running and open a break in one step — the behaviour of a break tile in the UI. Name a saved break template with templateId, or pass a free-text label.

| field | type | | meaning |
|---|---|---|---|
| `templateId` | integer | optional | One of your own entry templates; its note and attachments are copied onto the break. |
| `label` | string | optional | Free-text note for the break when you have no template. Required when you pass no templateId. |

#### `time_entry.update`

**Correct an entry** · role `member` and above

Fix the times, attachments or note of an entry. Members may correct their own lines; manager and above may correct anyone's in the organization. Attribution is deliberately not editable: entry_source, agentLabel, tokensUsed and apiCostUsd cannot be changed after the fact, so the human-vs-agent record cannot be rewritten. An entry already frozen into a certified invoice is refused outright — void the invoice first.

| field | type | | meaning |
|---|---|---|---|
| `entryId` | integer | required | The entry to correct. |
| `checkIn` | string | optional | New start as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `checkOut` | string | optional | New end (pass to close a running entry retroactively) as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `taskId` | integer | optional | Task to attribute the work to. Its stream (and that stream's customer) are adopted when you do not name them. |
| `streamId` | integer | optional | Stream (swim-lane) to attribute the work to. |
| `customerId` | integer | optional | Customer to bill the work to. Defaults to the stream's customer. |
| `notes` | string | optional | Free-text note shown on the ledger line. |

#### `today_summary`

**Today's page** · role `member` and above

The caller's day so far: worked minutes by stream and by source, break minutes, and whatever is still running.

Takes no arguments.

#### `usage.price`

**Price a token split** · role `member` and above

What PTD thinks a set of token counts costs, using the same table `time_entry.attest` prices an attestation with. Exists so a hook or a CI job can report a dollar figure on `time_entry.stop` that matches the one the server will derive on attestation, instead of shipping a second price table inside a shell script. Read-only, no database. An unknown model comes back `priced: false` with a zero cost — never a guess.

| field | type | | meaning |
|---|---|---|---|
| `model` | string | required | Model id, e.g. claude-opus-5 or gpt-4o-mini. |
| `inputTokens` | integer | optional |  |
| `outputTokens` | integer | optional |  |
| `cacheReadTokens` | integer | optional |  |
| `cacheCreationTokens` | integer | optional |  |
| `cacheTtl` | `5m` \| `1h` | optional | TTL of the cache writes: 5m costs 1.25× input, 1h costs 2×. Default 5m. |

### Org — members, imports, calendar, integrations, billing

`account.security` · `ai.connect` · `ai.disconnect` · `audit.export` · `audit.list` · `billing.change_plan` · `billing.checkout` · `billing.contractors` · `billing.portal` · `billing.status` · `billing.sync` · `github.disconnect` · `github.list_mappings` · `github.map_stream` · `github.status` · `github.sync_now` · `github.unmap_stream` · `ical.url` · `identity.list` · `identity.unlink` · `import.commit` · `import.history` · `import.preview` · `invitation.resend` · `member.billing` · `member.set_billing` · `oauth.clients` · `oauth.my_grants` · `oauth.revoke_client` · `oauth.revoke_grant` · `org.delete` · `org.export` · `org.members` · `org.security` · `org.set_security` · `slack.check_budgets` · `slack.disconnect` · `slack.link_code` · `slack.set_channel` · `slack.status` · `slack.test` · `slack.unlink` · `teams.connect` · `teams.disconnect` · `teams.link_code` · `teams.status` · `teams.unlink` · `telegram.disconnect` · `telegram.link_code` · `telegram.register_webhook` · `telegram.status` · `telegram.unlink` · `telegram.webhook_info` · `telemetry.ping` · `telemetry.set` · `telemetry.status` · `usage.connect_provider` · `usage.disconnect_provider` · `usage.providers` · `usage.reconcile` · `usage.reconciliations` · `webhook.create` · `webhook.delete` · `webhook.list` · `webhook.test` · `whoami`

#### `account.security`

**My second-factor state** · role `member` and above

Whether two-factor authentication is on for your account, how many recovery codes are left, which providers are linked, and whether this organization requires 2FA. What the Org → Security tab reads.

Takes no arguments.

#### `ai.connect`

**Connect an AI provider key** · role `admin` and above

Store this organization's own Anthropic or OpenAI key, sealed with AES-256-GCM, and use it for every AI call instead of the deployment's. The provider bills you directly and PTD meters nothing. The key is never returned by any action — `ai.status` shows the provider, the model and the last four characters. Connecting again replaces the stored key. Admin only, and recorded in the audit log.

| field | type | | meaning |
|---|---|---|---|
| `provider` | `anthropic` \| `openai` | required | Which provider the key belongs to. |
| `apiKey` | string | required | The provider API key. Stored sealed; never echoed back. |
| `model` | string | optional | Override the provider's default model for this organization. |
| `baseUrl` | string | optional | Point at a gateway or proxy instead of the provider's own host. |

#### `ai.disconnect`

**Disconnect the AI provider key** · role `admin` and above

Forget this organization's stored provider key. AI then falls back to the deployment's own key where one is configured — on the hosted instance that means Team and Business calls start being metered at cost plus 20% again. Admin only, and recorded in the audit log.

Takes no arguments.

#### `audit.export`

**Export the audit log as CSV** · role `admin` and above

Every audit row in the range as one CSV document (RFC 4180, UTF-8), oldest first, so it can be filed, diffed or handed to an auditor. No paging: the whole range comes back in `csv`. Narrow it with from/to on a busy organization.

| field | type | | meaning |
|---|---|---|---|
| `from` | string | optional | ISO 8601 lower bound, inclusive. |
| `to` | string | optional | ISO 8601 upper bound, inclusive. |
| `kind` | string | optional | One kind, e.g. "member.role_changed". A trailing dot is a prefix: "token." matches every token event. |

#### `audit.list`

**Read the audit log** · role `admin` and above

Who did what in this organization, newest first: sign-ins and failed sign-ins, 2FA turned on or off, providers linked, roles changed, members removed, tokens minted and revoked, agents registered, integrations connected and disconnected, billing opened, the security policy changed, data exported. Filterable by date range and kind, paged up to 200 rows. Returns the kinds this organization has actually produced, for building a filter.

| field | type | | meaning |
|---|---|---|---|
| `from` | string | optional | ISO 8601 lower bound, inclusive. |
| `to` | string | optional | ISO 8601 upper bound, inclusive. |
| `kind` | string | optional | One kind, e.g. "member.role_changed". A trailing dot is a prefix: "token." matches every token event. |
| `limit` | integer | optional | Rows to return (default 50, max 200). |
| `offset` | integer | optional |  |

#### `billing.change_plan`

**Change plan** · role `owner` and above

Move an existing subscription to another plan or billing interval in place — Team↔Business, monthly↔annual — rather than starting a second Checkout. Stripe prorates the difference onto the next invoice (`create_prorations`), the subscription keeps its identity and any discount, and the seat quantity is set from the current human count. An organization with no subscription yet is sent to billing.checkout instead. Owner only.

| field | type | | meaning |
|---|---|---|---|
| `plan` | `team` \| `business` | required | Which plan to buy: team ($15/org/month) or business ($49/org/month). |
| `interval` | `month` \| `year` | optional | month, or year for two months free (Team $150, Business $490). Defaults to month. |

#### `billing.checkout`

**Start checkout** · role `owner` and above

Create a Stripe Checkout Session for a plan and interval and return its URL for the browser to follow. The session carries the flat plan price, the seat price when Business is already past 50 humans, and both usage meters; promotion codes (FOUNDING) are accepted there. Owner only.

| field | type | | meaning |
|---|---|---|---|
| `plan` | `team` \| `business` | required | Which plan to buy: team ($15/org/month) or business ($49/org/month). |
| `interval` | `month` \| `year` | optional | month, or year for two months free (Team $150, Business $490). Defaults to month. |

#### `billing.contractors`

**Contractors and what is owed** · role `manager` and above

Every billable member with their rate, how many minutes of the named month are approved, pending or unsubmitted, and whether an invoice has already been issued for that month. One read for the billing overview, so the UI does not have to preview each contractor in turn.

| field | type | | meaning |
|---|---|---|---|
| `month` | integer | optional | Calendar month, 1–12. |
| `year` | integer | optional | Calendar year. |

#### `billing.portal`

**Manage billing** · role `owner` and above

Create a Stripe Customer Portal session — card, invoices, cancellation — and return its URL. Owner only; requires an existing Stripe customer.

Takes no arguments.

#### `billing.status`

**Billing status** · role `admin` and above

Everything the Billing tab draws: the plan and interval, the price list, the seat limits and what is in use (humans, agents, total, billable overage), the metered add-ons so far this period (certified invoices, AI cents), the live subscription state, and the founding-member code while one is on offer. On a self-hosted deployment it answers { hosted: false } and nothing else — there is no billing to report.

Takes no arguments.

#### `billing.sync`

**Sync subscription** · role `owner` and above

Re-read the subscription from Stripe and apply it to the organization — plan from the base price, interval, item ids and the period. The Checkout success redirect calls this so the plan is correct even before the webhook lands; safe to call at any time. Owner only.

| field | type | | meaning |
|---|---|---|---|
| `sessionId` | string | optional | Checkout Session id from the success redirect (session_id), if available. |

#### `github.disconnect`

**Disconnect GitHub** · role `admin` and above

Forget the installation and every mapping. Cards keep their externalKey and history, and the App itself stays installed on GitHub until someone removes it there — this only stops PTD acting on it.

Takes no arguments.

#### `github.list_mappings`

**List GitHub mappings** · role `member` and above

Every stream ↔ repository mapping in this organization, with its direction and the outcome of its last sync.

Takes no arguments.

#### `github.map_stream`

**Map a stream to a GitHub repository** · role `admin` and above

Bind one stream to one repository. `in` imports issues as tasks, `out` opens and closes issues from tasks, `both` does each. A stream maps to at most one repository, so mapping it again replaces the previous mapping. Inbound writes run as you, with your role.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer | required | Stream to bind |
| `repo` | string | required | "owner/name", or a github.com URL |
| `direction` | `both` \| `in` \| `out` | optional | both = mirror each way, in = GitHub → PTD only, out = PTD → GitHub only |

#### `github.status`

**GitHub status** · role `member` and above

Whether this server has a GitHub App configured, whether this organization has installed it, which account it was installed on, and every stream ↔ repository mapping with its last sync. Never returns a token — installation tokens are minted per hour and never stored.

Takes no arguments.

#### `github.sync_now`

**Import open issues now** · role `admin` and above

Pull every open issue of the mapped repository and upsert it as a task keyed on `gh:owner/name#N` — labels become tags, a milestone due date becomes the card's due date, and an assignee whose GitHub profile shows an email that matches a member is assigned. Idempotent: run it twice and nothing changes the second time. Closed issues are left out; a close arrives by webhook.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer | required | The mapped stream to sync |

#### `github.unmap_stream`

**Unmap a stream from GitHub** · role `admin` and above

Stop syncing one stream. Existing cards keep their `gh:owner/name#N` externalKey and their history; nothing is deleted on either side, and mapping the stream again picks the same cards back up.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer | required |  |

#### `ical.url`

**Calendar feed URL** · role `member` and above

The .ics subscription URL for this organization's scheduled cards. Calendar apps cannot send an Authorization header, so the credential is in the path: treat the URL as a secret, and revoke the 'ical' token in Org → Tokens to kill the feed. scope 'me' (default) shows the cards assigned to you; scope 'org' shows every scheduled card and needs the manager role.

| field | type | | meaning |
|---|---|---|---|
| `scope` | `me` \| `org` | optional | 'me' = your cards; 'org' = every scheduled card (manager+). |

#### `identity.list`

**List linked sign-in providers** · role `member` and above

The Google, GitHub or Microsoft accounts linked to your PTD account, with the address each one reported. Also reports which providers this deployment has configured at all, so a client can offer the ones that exist and no others.

Takes no arguments.

#### `identity.unlink`

**Unlink a sign-in provider** · role `member` and above

Detach one linked provider from your account. Unlinking the last one needs `confirm: true`: an account that was created *through* a provider has a random password nobody knows, so dropping its only identity means going through “Forgot password” before you can sign in again.

| field | type | | meaning |
|---|---|---|---|
| `identityId` | integer | required | Identity id, from identity.list. |
| `confirm` | boolean | optional | Required when this is the only linked provider. |

#### `import.commit`

**Commit a CSV import** · role `manager` and above

Write the rows. Tasks are matched on externalKey and updated rather than duplicated, so re-running the same file is idempotent; streams (and customers, for time sheets) are created by name when missing; every task write leaves a task_events row with via=import. Pass dryRun: true to get import.preview's answer instead.

| field | type | | meaning |
|---|---|---|---|
| `source` | `auto` \| `jira` \| `trello` \| `asana` \| `linear` \| `notion` \| `generic` \| `toggl` \| `clockify` \| `harvest` | optional | Where the file came from. "auto" detects it from the header row. One of: jira, trello, asana, linear, notion, generic, toggl, clockify, harvest. |
| `csv` | string | required | The CSV file's text, header row included. Up to 5 MB. |
| `mapping` | object<string, string> | optional | Overrides for the detected column mapping: {"<column name>": "<PTD field>"}. Use "-" to drop a column. |
| `streamId` | integer | optional | File every row under this stream, whatever the source says. |
| `defaultStreamName` | string | optional | Stream for rows with no stream of their own; created if it does not exist. |
| `dryRun` | boolean | optional | true behaves exactly like import.preview and writes nothing. |

#### `import.history`

**Recent imports** · role `manager` and above

The last 20 imports committed in this organization, newest first, from the import_runs table — every replica's runs, and they survive a restart. Plus the all-time count of task rows written by an import (task_events with via=import and an import: note).

Takes no arguments.

#### `import.preview`

**Preview a CSV import** · role `manager` and above

Dry run. Detects which tool the CSV came from, shows the column → PTD field mapping it will use, normalises the first rows, and counts what a commit would create, update or skip. Writes nothing. Run this first: it is the same code path as import.commit, so what it reports is what will happen.

| field | type | | meaning |
|---|---|---|---|
| `source` | `auto` \| `jira` \| `trello` \| `asana` \| `linear` \| `notion` \| `generic` \| `toggl` \| `clockify` \| `harvest` | optional | Where the file came from. "auto" detects it from the header row. One of: jira, trello, asana, linear, notion, generic, toggl, clockify, harvest. |
| `csv` | string | required | The CSV file's text, header row included. Up to 5 MB. |
| `mapping` | object<string, string> | optional | Overrides for the detected column mapping: {"<column name>": "<PTD field>"}. Use "-" to drop a column. |
| `streamId` | integer | optional | File every row under this stream, whatever the source says. |
| `defaultStreamName` | string | optional | Stream for rows with no stream of their own; created if it does not exist. |

#### `invitation.resend`

**Resend an invitation** · role `admin` and above

Mail an outstanding invitation again and push its expiry out another seven days. The token is unchanged, so a link from the first letter still works. Returns `acceptUrl` and a `delivery` verdict: `{sent:true}`, or `{sent:false, reason:"smtp_not_configured"}` on a deployment with no SMTP — in which case paste `acceptUrl` to the invitee yourself. An invitation that has already been accepted cannot be resent.

| field | type | | meaning |
|---|---|---|---|
| `invitationId` | integer | required | Invitation id, from GET /api/orgs/current/invitations. |

#### `member.billing`

**Read billing settings** · role `member` and above

A member's billing settings, or every member's when you name nobody. A member may always read their own; reading someone else's requires manager or above. The row says whether they are external, at what rate and in what currency, the issuer details their invoice prints, and whether their hours need approving.

| field | type | | meaning |
|---|---|---|---|
| `userId` | integer | optional | Whose settings to read. Omit for every member in the organization (manager and above), or for your own. |

#### `member.set_billing`

**Set a member's billing** · role `admin` and above

Mark a member as external (billable) and record what invoicing them needs: an hourly rate and currency, the legal name and address to print as the issuer, a tax id, and whether their hours must be approved by a manager before they can be invoiced. Turning `billable` off leaves the recorded rate and details alone, so switching a contractor back on does not mean re-typing them. Admin and above: a rate is money, and nobody sets their own.

| field | type | | meaning |
|---|---|---|---|
| `userId` | integer | required | The member to configure. |
| `billable` | boolean | required | True for an external member PTD should invoice; false for salaried staff and agent seats. |
| `hourlyRate` | number | optional, nullable | What an hour of their time bills at. Omit (or null) to invoice hours with no money attached. |
| `currency` | effects | optional | ISO 4217 currency of this member's rate, e.g. USD or EUR. |
| `billingName` | string | optional, nullable | Legal or trading name to print as the invoice's issuer. Defaults to their display name. |
| `billingAddress` | string | optional, nullable | Postal address printed under the issuer's name. |
| `taxId` | string | optional, nullable | VAT / tax registration number printed on the invoice. |
| `requireApproval` | boolean | optional | When true, their entries start as `pending` and only approved entries can be invoiced. |

#### `oauth.clients`

**List OAuth clients** · role `admin` and above

Every MCP client that has registered against this deployment's OAuth server (Claude.ai and ChatGPT connectors register themselves), with how many grants your organization has approved for each. Registration alone grants nothing — only a member's consent does.

Takes no arguments.

#### `oauth.my_grants`

**My connector grants** · role `member` and above

The MCP connectors you personally authorized for this organization, newest first, with the scope recorded at consent time, when each was last used and whether it is still live. Revoke one with oauth.revoke_grant.

Takes no arguments.

#### `oauth.revoke_client`

**Revoke an OAuth client** · role `admin` and above

Cuts an MCP client off from your organization: every grant this organization approved for it is revoked, access tokens included. The registration itself is deleted too when no other organization still has a live grant on it.

| field | type | | meaning |
|---|---|---|---|
| `clientId` | string | required | client_id, from oauth.clients. |

#### `oauth.revoke_grant`

**Revoke a connector grant** · role `member` and above

Withdraws one of your own connector authorizations: its refresh token and its live access token both stop working immediately.

| field | type | | meaning |
|---|---|---|---|
| `grantId` | integer | required | grantId, from oauth.my_grants. |

#### `org.delete`

**Delete this organization** · role `owner` and above

Deletes the organization and everything that hangs off it — streams, apps, tasks, task history, time entries, invoices, tokens, integrations, invitations, the audit log. Irreversible, and there is no copy: take `org.export` first. The exact organization name must be repeated in `confirmName`. A hosted organization with a live subscription is refused until the subscription is cancelled, so nobody deletes their way into being billed for nothing. Human members keep their accounts and their other organizations; an agent seat that existed only here is removed with it.

| field | type | | meaning |
|---|---|---|---|
| `confirmName` | string | required | The organization's name, exactly as it is spelled. |

#### `org.export`

**Export everything this organization has** · role `owner` and above

Mints a single-use download link for a ZIP of the whole organization: organization.json, members.csv, streams.csv, apps.csv, tasks.csv, task_events.csv, time_entries.csv, invoices.json and audit_events.csv, with a README naming each file. The link is good for five minutes, works exactly once, and needs no Authorization header — so it can be handed to a browser, `curl -O`, or anything else that follows a URL. The archive itself is built when the link is fetched, so it is never stale.

Takes no arguments.

#### `org.members`

**List members** · role `member` and above

Members of the organization with role and whether each is an agent seat.

Takes no arguments.

#### `org.security`

**Organization security policy** · role `admin` and above

What this organization requires of its members: today, whether two-factor authentication is mandatory, and who last changed that.

Takes no arguments.

#### `org.set_security`

**Set the organization security policy** · role `admin` and above

Turn the two-factor requirement on or off. With it on, every human member without 2FA is refused on org-scoped calls with `403 totp_required` and pointed at the setup page — their own account surface (/api/auth/**) keeps working, so they can enrol and carry on. Agent seats are exempt: their credential is a revocable token, not a phone. You cannot switch it on unless your own account already has 2FA, which is what stops an admin locking themselves out.

| field | type | | meaning |
|---|---|---|---|
| `requireTotp` | boolean | required | true = members must have TOTP enabled. |

#### `slack.check_budgets`

**Check agent budgets now** · role `admin` and above

Run the agent-budget sweep immediately and post an alert for every stream whose agent spend has passed its budget. The same sweep runs on its own, throttled, as task events arrive; this bypasses the per-stream cooldown.

Takes no arguments.

#### `slack.disconnect`

**Disconnect Slack** · role `admin` and above

Remove the workspace install: the sealed bot token is destroyed, notifications stop and slash commands from that workspace stop resolving. Members' link records are left alone, so a re-install picks up where it left off.

Takes no arguments.

#### `slack.link_code`

**Mint a Slack link code** · role `member` and above

A six-character one-time code, valid for ten minutes, that binds a Slack account to the calling PTD user. Run `/ptd link <code>` in Slack to spend it. Minting a new code invalidates the caller's previous one.

Takes no arguments.

#### `slack.set_channel`

**Set the Slack channel** · role `admin` and above

Choose the channel completions, cascade shifts and agent-budget alerts are posted to. Invite the PTD bot to the channel first — Slack refuses to post into a channel the app is not in. Assignment notifications are DMs and do not use it.

| field | type | | meaning |
|---|---|---|---|
| `channelId` | string | required | Slack conversation id, e.g. C0123456789 (Slack → channel → About → copy channel ID). |

#### `slack.status`

**Slack status** · role `member` and above

Whether this server has a Slack app configured, whether this organization has connected a workspace, which channel notifications go to, and whether the caller's own Slack account is linked. Never returns the bot token.

Takes no arguments.

#### `slack.test`

**Test the Slack connection** · role `admin` and above

Post "PTD connected" into the configured channel with the stored bot token, so the install, the token and the channel are all proven at once.

Takes no arguments.

#### `slack.unlink`

**Unlink my Slack account** · role `member` and above

Forget every Slack identity bound to the calling PTD user. Their slash commands stop working until they link again.

Takes no arguments.

#### `teams.connect`

**Connect Microsoft Teams** · role `admin` and above

Store the secret Teams showed when the Outgoing Webhook was created. That secret is the whole credential: it verifies every `Authorization: HMAC …` header AND identifies this organization, since an Outgoing Webhook delivery carries nothing else worth trusting. It is sealed at rest and never shown again.

| field | type | | meaning |
|---|---|---|---|
| `secret` | string | required | The base64 secret Teams displayed once, when the Outgoing Webhook was created |
| `teamName` | string | optional | Which Teams team this is, for the Org UI |

#### `teams.disconnect`

**Disconnect Microsoft Teams** · role `admin` and above

Destroy the stored secret: `@PTD …` commands from that team stop being recognised. Members keep their link records, so re-connecting a new Outgoing Webhook picks up where it left off. Delete the webhook in Teams too, or it will keep posting to a URL that now refuses it.

Takes no arguments.

#### `teams.link_code`

**Mint a Teams link code** · role `member` and above

A six-character one-time code, valid for ten minutes, that binds a Teams account to the calling PTD user. Send `@PTD link <code>` in the team to spend it. Minting a new code invalidates the caller's previous one.

Takes no arguments.

#### `teams.status`

**Microsoft Teams status** · role `member` and above

Whether this organization has connected a Teams Outgoing Webhook, which team it is, and whether the caller's own Teams account is linked. Never returns the webhook secret — it is sealed with AES-256-GCM at rest.

Takes no arguments.

#### `teams.unlink`

**Unlink my Teams account** · role `member` and above

Forget every Teams identity bound to the calling PTD user. Their commands stop working until they link again.

Takes no arguments.

#### `telegram.disconnect`

**Switch Telegram off** · role `admin` and above

Turn the bot off for this organization: link codes stop being minted and DMs stop. Members keep their link records, and the bot itself keeps serving any other organization on this server — so the webhook is left registered unless `deleteWebhook` is asked for explicitly.

| field | type | | meaning |
|---|---|---|---|
| `deleteWebhook` | boolean | optional | Also unregister the webhook with Telegram. This affects EVERY organization on this server. |

#### `telegram.link_code`

**Mint a Telegram link code** · role `member` and above

A six-character one-time code, valid for ten minutes, that binds a Telegram account to the calling PTD user. Send `/link <code>` to the bot to spend it. Minting a new code invalidates the caller's previous one.

Takes no arguments.

#### `telegram.register_webhook`

**Register the Telegram webhook** · role `admin` and above

Point the bot at this deployment with `setWebhook`, and switch Telegram on for this organization. The URL carries a secret derived from PTD_SECRET_KEY and the bot token, so it is unguessable and rotates with either of them. One bot serves every organization on this server: registering it again from another organization is harmless and simply re-points the same bot here.

Takes no arguments.

#### `telegram.status`

**Telegram status** · role `member` and above

Whether this server has a bot token, whether this organization has switched the bot on, the bot's @username, and whether the caller's own Telegram account is linked. Never returns the bot token or the webhook secret.

Takes no arguments.

#### `telegram.unlink`

**Unlink my Telegram account** · role `member` and above

Forget every Telegram identity bound to the calling PTD user. Their commands stop working until they link again.

Takes no arguments.

#### `telegram.webhook_info`

**Telegram webhook info** · role `admin` and above

What Telegram itself thinks the webhook is: the URL it delivers to, how many updates are queued, and the last delivery error it saw. The fastest way to tell a wrong PTD_BASE_URL from a firewall.

Takes no arguments.

#### `telemetry.ping`

**Send one install ping now** · role `owner` and above

Post the four-field payload once, immediately, instead of waiting for the weekly timer. Refused with `telemetry-disabled` while the toggle is off — there is no path in PTD that pings without an explicit opt-in. Returns the exact payload that was sent and the receiver's status code; a network failure is reported, not thrown.

Takes no arguments.

#### `telemetry.set`

**Set the telemetry preferences** · role `owner` and above

Turn the weekly install ping and the update check on or off, independently. The ping posts four fields to the shared receiver, which hashes (client IP, installation id) under a weekly-rotating salt and keeps only the hash; the update check is a bare GET against the public releases feed and sends nothing at all. Either call also records that the question has been answered, which retires the first-run prompt. `PTD_TELEMETRY=0` or `=1` in the environment outranks the stored ping toggle.

| field | type | | meaning |
|---|---|---|---|
| `telemetryEnabled` | boolean | optional | true = post the weekly ping. Off by default. |
| `updateChecksEnabled` | boolean | optional | true = GET the public releases feed. Off by default. Sends no payload. |
| `dismissed` | boolean | optional | Answer the question without changing either toggle — what dismissing the first-run prompt does. |

#### `telemetry.status`

**Installation telemetry status** · role `owner` and above

Whether this installation submits the weekly anonymous install ping and whether it checks for updates — both off unless someone turned them on — together with the exact four-field JSON that would be sent, the six ready-to-paste offline submission formats for an egress-restricted host, and the receiver's retention policy. Reading this sends nothing.

Takes no arguments.

#### `usage.connect_provider`

**Connect a provider admin key** · role `admin` and above

Store an organization-level admin key so PTD can read the provider's own usage and cost reports and compare them with the ledger. Anthropic wants an Admin API key (`sk-ant-admin…`, Console → Settings → Admin keys); OpenAI wants an admin key with the usage scope. The key is sealed with AES-256-GCM (PTD_SECRET_KEY) and is never returned by any action — `keyHint` is its last four characters. Admin only, and deliberately so: reconciliation is only evidence because the agents being measured cannot reach the credential doing the measuring. `baseUrl` exists for a proxy or a local stub; leave it unset for the real provider.

| field | type | | meaning |
|---|---|---|---|
| `provider` | `anthropic` \| `openai` | required | Which provider's billing to read: anthropic or openai. |
| `adminApiKey` | string | required | The admin key. Stored sealed; never echoed back. |
| `baseUrl` | string | optional | Override the provider host (proxy or test stub). Default api.anthropic.com / api.openai.com. |

#### `usage.disconnect_provider`

**Disconnect a provider key** · role `admin` and above

Forget the stored admin key for one provider. Past reconciliations are kept — they are evidence — but no new one can be run until a key is connected again.

| field | type | | meaning |
|---|---|---|---|
| `provider` | `anthropic` \| `openai` | required | Which provider's billing to read: anthropic or openai. |

#### `usage.providers`

**Connected providers** · role `admin` and above

Both providers with whether a key is connected, its last four characters, who connected it and when. Never the key itself.

Takes no arguments.

#### `usage.reconcile`

**Reconcile against the provider** · role `admin` and above

Fetch the provider's own usage and cost report for a period and compare it with what the agents booked into the ledger. Stores and returns one `usage_reconciliations` row: `status` is `match` (inside tolerance — 5% of the provider's figure or 10,000 tokens, whichever is larger), `under_reported` (the provider billed for more than the ledger accounts for), `over_reported` (the ledger claims more than the provider billed) or `unavailable` (the provider could not be read). `detail` carries the gap, the tolerance applied, the attestation coverage, the per-model provider breakdown, the per-agent split and a note on how to read the status — the two totals are not commensurable to the token (a provider bill includes keys PTD never sees), so the verdict is a signal to look, not an accusation. Admin only.

| field | type | | meaning |
|---|---|---|---|
| `provider` | `anthropic` \| `openai` | required | Which provider's billing to read: anthropic or openai. |
| `from` | string | required | Start of the period as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |
| `to` | string | required | End of the period as an ISO-8601 datetime (or YYYY-MM-DD for midnight local). |

#### `usage.reconciliations`

**Reconciliation history** · role `manager` and above

Past reconciliations, newest first: period, provider, both token totals, both cost totals, the verdict and its detail. Manager and above — it is a read of evidence, not a credential.

| field | type | | meaning |
|---|---|---|---|
| `provider` | `anthropic` \| `openai` | optional | Which provider's billing to read: anthropic or openai. |
| `limit` | integer | optional | Rows to return (default 20). |

#### `webhook.create`

**Create webhook** · role `admin` and above

Subscribe a URL to task events. Each delivery is a JSON body {event, orgId, taskId, actor, payload, ts} with an `X-PTD-Signature: sha256=<hex HMAC-SHA256 of the raw body>` header. A secret is generated when you omit one and shown exactly once.

| field | type | | meaning |
|---|---|---|---|
| `url` | string | required | Absolute http(s) endpoint to POST to. |
| `secret` | string | optional | HMAC key. Generated when omitted; returned once either way. |
| `events` | string[] | optional | Event kinds to receive, or ["*"] for all (the default). Task kinds carry a taskId and a {old,new} diff: task.created, task.updated, task.completed, task.assigned, task.priority_changed, task.scheduled, task.unscheduled, task.cascade_shifted, task.stream_moved, task.deleted. Stream kinds have no taskId: stream.created, stream.updated, stream.renamed, stream.tasks_moved, stream.app_attached, stream.app_detached. webhook.test sends `ping`. |

#### `webhook.delete`

**Delete webhook** · role `admin` and above

Remove a webhook subscription. Deliveries stop immediately.

| field | type | | meaning |
|---|---|---|---|
| `id` | integer | required | Webhook id, from webhook.list. |

#### `webhook.list`

**List webhooks** · role `admin` and above

Outgoing webhook subscriptions for this organization. Secrets are never returned — only whether one is set.

Takes no arguments.

#### `webhook.test`

**Test webhook** · role `admin` and above

Deliver a signed `ping` envelope through the real delivery path and report the HTTP status, so you can confirm the endpoint and the signature before relying on it.

| field | type | | meaning |
|---|---|---|---|
| `id` | integer | required | Webhook id, from webhook.list. |

#### `whoami`

**Who am I** · role `member` and above

Identity, organization and role of the caller, plus whether it authenticated as a human or an agent.

Takes no arguments.

<!-- END GENERATED ACTIONS -->
