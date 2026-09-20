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

_109 actions, generated from the registry by `scripts/gen-docs.ts` (`npm run docs`). Do not edit this block by hand._

| surface | actions | minimum role of each |
|---|---|---|
| overview | 15 | 6 × `member`, 8 × `manager`, 1 × `admin` |
| plan | 24 | 6 × `member`, 18 × `manager` |
| track | 27 | 19 × `member`, 8 × `manager` |
| org | 43 | 16 × `member`, 3 × `manager`, 21 × `admin`, 3 × `owner` |

### Overview — backlog, apps, KPIs, webhooks

`ai.status` · `ai.usage` · `app.create` · `app.get` · `app.list` · `app.stats` · `app.update` · `digest.preview` · `hybrid.summary` · `next_task` · `stats` · `stream.systemic` · `task.suggest_priority` · `task.suggest_priority_batch` · `tasks.query`

#### `ai.status`

**AI status** · role `member` and above

Whether this deployment has an AI provider configured, and which model it would use. The only AI action that works unconfigured — everything else refuses until PTD_AI_PROVIDER and PTD_AI_API_KEY are set. Never returns the key.

Takes no arguments.

#### `ai.usage`

**AI usage** · role `admin` and above

Tokens and estimated dollars spent on AI suggestions by this server process, broken down by model and by action. Kept in memory (the last 500 calls) rather than in a table, so it resets on restart and covers this process only — `truncated: true` means older calls have already fallen out of the window. Costs are estimates from a static price table; `unpriced` counts calls whose model the table did not know.

Takes no arguments.

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

The single highest-priority task still worth starting (status backlog or triaged), plus `why` — the urgency/impact/effort arithmetic behind its score. By default it only offers work nobody has claimed or work already assigned to you, which makes it safe to poll in an autonomous loop.

| field | type | | meaning |
|---|---|---|---|
| `streamId` | integer \| `"none"` \| null | optional | Restrict to one stream, or null / "none" for work filed against no stream. |
| `appId` | integer \| `"none"` \| null | optional | Restrict to one app, or null / "none" for work filed against no app. |
| `assignee` | `"me"` \| `"any"` \| `"none"` \| null \| integer | optional | Override the default filter: "me", null / "none" (unassigned only), "any" (ignore assignment), or a user id. |

#### `stats`

**Organization stats** · role `manager` and above

KPI roll-up for the whole organization: task counts by status, counts by priority band (critical 75-100, high 50-74, medium 25-49, low 0-24), overdue work, app and stream inventory, human vs agent seats, agent minutes/tokens/dollars (all-time and last 7 days), and the 20 most recent task events made by agents.

Takes no arguments.

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

### Plan — tasks, streams, scheduling, dependencies

`blocked_tasks` · `critical_path` · `stream.attach_app` · `stream.create` · `stream.detach_app` · `stream.list` · `stream.move_tasks` · `stream.rename` · `stream.update` · `task.complete` · `task.create` · `task.delete` · `task.find_or_create` · `task.get` · `task.history` · `task.list` · `task.schedule` · `task.set_assignee` · `task.set_dependencies` · `task.set_priority` · `task.unschedule` · `task.update` · `tasks_by_assignee` · `upcoming_due`

#### `blocked_tasks`

**Blocked tasks** · role `manager` and above

Cards waiting on at least one dependency that is neither complete nor already finished — the work that cannot legitimately start yet.

Takes no arguments.

#### `critical_path`

**Critical path** · role `manager` and above

The longest dependency chain in the organization weighted by estimated duration (totalDays/tasks), plus a full critical-path-method schedule in perTask: earliest/latest start and finish for every card, its float in days, and whether it has none left. Float is the slack a card has before it drags the whole plan; zero float is the critical path the Plan surface outlines in red.

Takes no arguments.

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

`customer.create` · `customer.delete` · `customer.goals` · `customer.list` · `customer.update` · `insights.patterns` · `insights.summary` · `invoice.generate` · `invoice.list` · `invoice.preview` · `report.compare` · `report.range` · `report.search` · `stream.totals` · `task.totals` · `template.create` · `template.delete` · `template.list` · `time_entry.current` · `time_entry.delete` · `time_entry.list` · `time_entry.log_past` · `time_entry.start` · `time_entry.stop` · `time_entry.switch_break` · `time_entry.update` · `today_summary`

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

#### `invoice.generate`

**Commit a month's invoice** · role `manager` and above

Record the invoice (status 'generated', total held in minutes because no hourly rate is configured) and hand back the URL of its PDF. The PDF is rendered on demand from the ledger at `pdfUrl`, so it always reflects the rows as they stand; regenerating the same month creates a second, separately numbered invoice rather than overwriting the first.

| field | type | | meaning |
|---|---|---|---|
| `customerId` | integer | required | The customer to bill. |
| `month` | integer | required | Calendar month, 1–12. |
| `year` | integer | required | Calendar year. |

#### `invoice.list`

**Invoices issued** · role `manager` and above

Every invoice recorded for the organization, newest period first, with the customer it was rendered to, who issued it, the total in minutes and the URL of its PDF.

| field | type | | meaning |
|---|---|---|---|
| `customerId` | integer | optional | Only this customer's invoices. |
| `limit` | integer | optional | Maximum rows (default 100). |

#### `invoice.preview`

**What a month's invoice would say** · role `manager` and above

The line items a customer's month would bill: one line per stream × task with its session count, human minutes, agent minutes, agent tokens and agent API cost, plus the totals and the agent spend as a pass-through figure. Nothing is written — this is the document a manager reads before committing to it. No hourly rate exists in the schema yet, so the totals are stated in minutes and hours.

| field | type | | meaning |
|---|---|---|---|
| `customerId` | integer | required | The customer to bill. |
| `month` | integer | required | Calendar month, 1–12. |
| `year` | integer | required | Calendar year. |

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

#### `time_entry.current`

**What is running** · role `member` and above

The caller's open entry with the minutes elapsed so far, or null when the clock is at rest.

Takes no arguments.

#### `time_entry.delete`

**Strike an entry** · role `member` and above

Remove an entry from the ledger for good. Own entries for a member; any entry in the organization for manager and above.

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

#### `time_entry.switch_break`

**Cut to a break** · role `member` and above

Close whatever is running and open a break in one step — the behaviour of a break tile in the UI. Name a saved break template with templateId, or pass a free-text label.

| field | type | | meaning |
|---|---|---|---|
| `templateId` | integer | optional | One of your own entry templates; its note and attachments are copied onto the break. |
| `label` | string | optional | Free-text note for the break when you have no template. Required when you pass no templateId. |

#### `time_entry.update`

**Correct an entry** · role `member` and above

Fix the times, attachments or note of an entry. Members may correct their own lines; manager and above may correct anyone's in the organization. Attribution is deliberately not editable: entry_source, agentLabel, tokensUsed and apiCostUsd cannot be changed after the fact, so the human-vs-agent record cannot be rewritten.

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

### Org — members, imports, calendar, integrations, billing

`billing.checkout` · `billing.portal` · `billing.status` · `billing.sync` · `github.disconnect` · `github.list_mappings` · `github.map_stream` · `github.status` · `github.sync_now` · `github.unmap_stream` · `ical.url` · `import.commit` · `import.history` · `import.preview` · `invitation.resend` · `oauth.clients` · `oauth.my_grants` · `oauth.revoke_client` · `oauth.revoke_grant` · `org.members` · `slack.check_budgets` · `slack.disconnect` · `slack.link_code` · `slack.set_channel` · `slack.status` · `slack.test` · `slack.unlink` · `teams.connect` · `teams.disconnect` · `teams.link_code` · `teams.status` · `teams.unlink` · `telegram.disconnect` · `telegram.link_code` · `telegram.register_webhook` · `telegram.status` · `telegram.unlink` · `telegram.webhook_info` · `webhook.create` · `webhook.delete` · `webhook.list` · `webhook.test` · `whoami`

#### `billing.checkout`

**Start checkout** · role `owner` and above

Create a Stripe Checkout Session for the flat $15/month organization subscription and return its URL for the browser to follow. Owner only.

Takes no arguments.

#### `billing.portal`

**Manage billing** · role `owner` and above

Create a Stripe Customer Portal session — card, invoices, cancellation — and return its URL. Owner only; requires an existing Stripe customer.

Takes no arguments.

#### `billing.status`

**Billing status** · role `admin` and above

The organization's hosted plan, what it costs, seat usage against the free-tier limit and the live subscription state. On a self-hosted deployment it answers { hosted: false } and nothing else — there is no billing to report.

Takes no arguments.

#### `billing.sync`

**Sync subscription** · role `owner` and above

Re-read the subscription from Stripe and apply it to the organization. The Checkout success redirect calls this so the plan is correct even before the webhook lands; safe to call at any time. Owner only.

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

The imports committed in this organization since the server last started, newest first, plus the all-time count of task rows written by an import (task_events with via=import and an import: note), which does survive a restart.

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

#### `org.members`

**List members** · role `member` and above

Members of the organization with role and whether each is an agent seat.

Takes no arguments.

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
