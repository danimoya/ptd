# Integrations

Four things live here: outgoing **webhooks**, the **Slack** app, the CSV
**importers**, and the read-only **iCal** feed. All four are configured through
ordinary registry actions, so anything the Org tab can do, a script or an agent
with the right role can do too.

> Additional integrations are being added. Check the Org → Integrations tab of your
> deployment, and `GET /api/actions`, for what is available there.

---

## Webhooks

Subscribe a URL and every task and stream event in the organization is POSTed to
it, signed.

```bash
curl -s https://ptd.example/api/actions/webhook.create \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/ptd","events":["task.completed","task.assigned"]}'
```

`admin` and above. Omit `events` (or pass `["*"]`) for everything. Omit `secret`
and one is generated — **it is returned exactly once, in the create response**;
after that `webhook.list` only reports whether a secret is set, because the stored
copy is sealed with AES-256-GCM under `PTD_SECRET_KEY`.

| Action | Effect |
|---|---|
| `webhook.list` | Subscriptions for this organization, without secrets |
| `webhook.create` | Subscribe. Returns the secret once |
| `webhook.delete` | Unsubscribe. Deliveries stop immediately |
| `webhook.test` | Send a signed `ping` through the real delivery path and report the HTTP status |

### The envelope

```http
POST /your/endpoint
Content-Type: application/json
User-Agent: ptd-webhooks/1
X-PTD-Signature: sha256=3b2f…
```

```json
{
  "event": "task.completed",
  "orgId": 1,
  "taskId": 3,
  "actor": { "userId": 6, "label": "Claude Code", "isAgent": true },
  "payload": { "task": { "…": "…" } },
  "ts": "2026-09-20T16:15:35.052Z"
}
```

`taskId` is `null` for stream events. `actor` says who caused it, including whether
it was an agent.

### Verifying the signature

`X-PTD-Signature` is `sha256=` followed by the hex **HMAC-SHA256 of the exact
request body**, keyed with your webhook's plaintext secret (`whsec_…`).

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// `raw` must be the unparsed bytes — re-serializing the JSON will not match.
function verify(raw, header, secret) {
  const expected = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Two rules: capture the **raw** body before any JSON middleware touches it, and
compare in constant time.

### Event kinds

| Group | Kinds |
|---|---|
| Task (carry `taskId` and a `{old, new}` diff) | `task.created`, `task.updated`, `task.completed`, `task.assigned`, `task.priority_changed`, `task.scheduled`, `task.unscheduled`, `task.cascade_shifted`, `task.stream_moved`, `task.deleted` |
| Stream (no `taskId`) | `stream.created`, `stream.updated`, `stream.renamed`, `stream.tasks_moved`, `stream.app_attached`, `stream.app_detached` |
| Test | `ping`, from `webhook.test` |

### Delivery

Fire-and-forget, with a 5-second timeout, and **not retried**. A failure is logged
on the server and nothing else: a broken subscriber must never be able to fail a
task mutation. Design your endpoint to be cheap, to return quickly, and to
reconcile from `task.history` or `tasks.query` if it ever misses an event.

---

## Slack

One Slack app per PTD deployment; each organization then installs it into its own
workspace.

### Server setup (once per deployment)

1. Create an app at <https://api.slack.com/apps>.
2. Bot token scopes: `commands`, `chat:write`, `users:read`, `users:read.email`.
3. Slash command `/ptd` → `https://<your-host>/api/integrations/slack/commands`.
4. OAuth redirect URL → `https://<your-host>/api/integrations/slack/callback`.
5. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` and
   `PTD_BASE_URL` in `.env`, and restart.

Without all three secrets the Org → Integrations tab says Slack is not configured
on this server, rather than offering a button that could only fail. If your public
URL differs from what Slack has registered, set `SLACK_REDIRECT_URI` explicitly.

### Per organization

An `admin` opens **Org → Integrations → Add to Slack**, approves the install, and
picks a channel for notifications. The workspace's bot token is sealed with
`PTD_SECRET_KEY` and stored per organization — workspaces never share one.

| Action | Effect |
|---|---|
| `slack.status` | Whether the app is configured on this server and installed for this organization |
| `slack.link_code` | A short-lived code you type as `/ptd link <code>` to bind your Slack account to your PTD seat |
| `slack.unlink` | Drop that binding |
| `slack.set_channel` | Where notifications go |
| `slack.test` | Post a test message |
| `slack.check_budgets` | Report streams over their agent budget now |
| `slack.disconnect` | Remove the install and its token |

### Linking your account

A Slack user id is not a PTD identity. On first use `/ptd` tells you to mint a code
in the web app (Org → Integrations → Slack, i.e. `slack.link_code`) and then run
`/ptd link <code>` in Slack. Repeated bad codes are rate limited. `/ptd who` shows
the current binding and `/ptd unlink` removes it.

### Commands

Each is a thin translation into one action, so the same role gate applies:

| Command | Does |
|---|---|
| `/ptd next` | The highest-priority task worth starting |
| `/ptd start <TASK-KEY> [notes]` | Start your timer |
| `/ptd stop [tokens=N] [cost=0.12] [notes]` | Stop your timer |
| `/ptd log 45m <TASK-KEY> [notes]` | Log a session that ended just now |
| `/ptd today` | Your day so far |
| `/ptd tasks [status]` | The organization's open tasks |
| `/ptd plan <TASK-KEY> <YYYY-MM-DD> [days]` | Put a task on the timeline, cascading its dependents |
| `/ptd done <TASK-KEY>` | Mark a task complete |
| `/ptd link <code>` | Bind this Slack account to your PTD seat |
| `/ptd who` | Which PTD user this Slack account is |
| `/ptd stats` | Organization KPI roll-up |
| `/ptd unlink` | Disconnect this Slack account |
| `/ptd help` | The subcommands *your* role may use |

Work logged from Slack is human work: you are acting with your own linked seat, so
`tokens=` and `cost=` are accepted only if that seat is an agent.

### Verification

Every request is checked as Slack v0 signatures: HMAC-SHA256 over
`v0:<timestamp>:<raw body>` with the signing secret, compared in constant time,
with anything older than five minutes refused as a replay. The raw bytes are
captured before the JSON parser sees them, because the signature is over the exact
body.

---

## CSV importers

Bring an existing tracker's export in. Nine sources, six for tasks and three for
time sheets, all three stages usable from anywhere:

```
csv text ──detect+map──▶ normalized rows ──apply──▶ tasks / time entries
```

| Action | Effect |
|---|---|
| `import.preview` | Dry run: detects the source, shows the column → field mapping, normalizes the first rows, counts what a commit would create, update or skip. **Writes nothing** |
| `import.commit` | Writes. `dryRun: true` behaves exactly like `import.preview` |
| `import.history` | Imports committed since the server started, plus the all-time count of task rows written by an import |

Both need `manager`. Preview is the same code path as commit, so what it reports is
what will happen. `POST /api/import/upload` accepts a file body for the UI's
drag-and-drop, `GET /api/import/sources` lists the sources, and
`GET /api/import/template/<source>.csv` downloads a header row plus two example
records for any of them.

Inputs, for both preview and commit:

| Field | Meaning |
|---|---|
| `csv` | The file's text, header row included. Up to 5 MB |
| `source` | `auto` (default) detects from the header row, or name one explicitly |
| `mapping` | Overrides: `{"<column name>": "<PTD field>"}`. Use `"-"` to drop a column |
| `streamId` | File every row under this stream, whatever the source says |
| `defaultStreamName` | Stream for rows with no stream of their own; created if missing |

`mapping` is always *column name → PTD field*, never the reverse, because several
columns can legitimately feed one field — Jira emits one `Labels` column per label.

### What a commit does

- **Tasks are matched on `externalKey` and updated, not duplicated** — re-running
  the same file is idempotent. When the file has no usable key, one is synthesized
  as `<source>-<sha1 of title + created date>` and the preview counts those
  separately, so you can tell before writing.
- **Streams and customers are created by name when missing. Users never are.** A row
  naming an unknown assignee imports unassigned, and the preview says
  `"someone@example.com (not a member)"`.
- **Every task write leaves a `task_events` row with `via: "import"`**, so an import
  is as auditable as a hand edit.
- Source statuses are mapped onto PTD's five (`backlog`, `triaged`, `in-progress`,
  `completed`, `wontfix`) through a wide synonym table — `Todo` and `Selected for
  Development` become `triaged`, `In Review` and `Blocked` become `in-progress`,
  `Cancelled` and `Duplicate` become `wontfix`. A word it does not know falls back
  to `backlog` **with a warning**, which is exactly what the preview is for.

### Sources and columns

Detection scores the header row: the distinctive headers below are worth 3 points
each, supporting ones 1, and a source can be ruled out by a header it must not have.
`generic` recognizes everything, so it is tried last.

#### Tasks

| Source | Export from | Detected by | Notable mappings |
|---|---|---|---|
| **Jira** | Issue navigator → Export → CSV | `Issue key`, `Issue id`, `Issue Type`, `Project key` | `Summary`→title, `Issue key`→externalKey, `Project name`→stream, `Labels`/`Component/s`→tags (repeated columns all collected), story points→estimate in preference to the original-estimate seconds |
| **Trello** | Board → More → Print and Export → Export as CSV (Premium) | `Card ID`, `Card Name`, `List Name`, `Card Short Link`, `Board Name` | `Card Name`→title, `Card ID`→externalKey, **`Board Name`→stream** and `List Name`→status (the board is the swim-lane, the list is a column in it) |
| **Asana** | Project → Export/Print → CSV | `Task ID`, `Section/Column`, `Blocked By (Dependencies)`, `Blocking (Dependents)` | `Name`→title, `Notes`→description, `Section/Column`→status, `Projects`→stream |
| **Linear** | Workspace settings → Import / Export → Export CSV | `Cycle Number`, `Cycle Name`, `Parent issue`, `SLA Status`, `Roadmaps` | `Title`→title, `ID`→externalKey, `Project`(else `Team`)→stream, `Estimate`→estimate |
| **Notion** | Database → ••• → Export → CSV (all properties) | `Page ID`, `Notion ID` | The **first column** is the title when no `Name`/`Title` exists; `Project`/`Category`/`Area`→stream, `Due`/`Deadline`→dueDate |
| **Generic CSV** | Anything with a title column | *(nothing — the fallback)* | Exact PTD field names first (`externalKey`, `urgency`, `impact`, `effort`, `estimatedDuration`), then a loose match, so `Ticket Summary` and `Target Due` land where they obviously belong |

Task fields a column can be mapped onto: `title`, `description`, `status`,
`externalKey`, `stream`, `startDate`, `dueDate`, `estimate`, `tags`,
`assigneeEmail`, `priority`, `urgency`, `impact`, `effort`, `createdAt`.

#### Time sheets

| Source | Export from | Detected by | Duration comes from |
|---|---|---|---|
| **Toggl Track** | Reports → Detailed → Download → CSV | `Start date`, `Start time`, `End date`, `End time` — and *not* `Duration (h)` / `Duration (decimal)`, which would mean Clockify | The start/end date-time pair, or `Duration` |
| **Clockify** | Reports → Detailed → Export → CSV | `Duration (h)`, `Duration (decimal)`, `Billable Rate (USD)` | `Duration (h)` as `hh:mm:ss`, else `Duration (decimal)` as decimal hours |
| **Harvest** | Reports → Time → Export → CSV | `First Name`, `Last Name`, `Project Code`, `Billable Rate`, `Cost Rate` | `Hours` (decimal) against `Date`, with `Start Time`/`End Time` used when present |

Time fields: `userEmail`, `userName`, `customer`, `stream`, `taskRef`, `notes`,
`date`, `startDate`, `startTime`, `endDate`, `endTime`, `duration`, `hours`.
`Client`→customer and `Project`→stream in all three. `taskRef` is matched to a task
by a `[KEY]` prefix or by title.

A time-sheet row lands on the ledger of the member whose address matches
`userEmail`. A row matching nobody — or matching an **agent** seat, since these three
tools are human time sheets and agent minutes are supposed to arrive from the agent's
own credential — falls back to **your** ledger, with a warning saying so in the
preview. Duplicate protection is a `(member, start minute, end minute)` fingerprint
against the window the file covers, so importing the same export twice does not
double the hours.

`entry_source` on an imported entry comes from the credential that *ran the import*,
never from the file: a human session imports human time, an agent token imports agent
time. A 500-row import fires one `import.completed` webhook rather than 500 task
events' worth.

---

## Calendar feed (iCal)

`ical.url` mints a subscription URL for the organization's scheduled cards:

```bash
curl -s https://ptd.example/api/actions/ical.url \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"scope":"me"}'
```

| Scope | Shows | Role |
|---|---|---|
| `me` (default) | Cards assigned to you | `member` |
| `org` | Every scheduled card | `manager` |

The URL looks like `https://ptd.example/ical/ptd_….ics`. **The credential is in the
path, so the URL is the secret** — Google Calendar, Apple Calendar and Outlook all
subscribe by URL and none of them can send an `Authorization` header. The
consequences are faced rather than papered over:

- It is a normal `ptd_` API token, named `ical`. Revoking that token in Org → Tokens
  kills the feed immediately — the same lever as for any other credential.
- A revoked or expired token gets **404**, not 401, because a 401 makes Google
  prompt for a password that does not exist while a 404 shows up as "calendar
  unavailable".
- The feed is read-only and scoped to the token's own organization.

Subscribing:

| Client | How | Refresh |
|---|---|---|
| Google Calendar | Other calendars **+** → From URL → paste → Add calendar | Roughly every 8–24 h; it ignores the 5-minute hint |
| Apple Calendar | File → New Calendar Subscription → paste | Set auto-refresh to 5 minutes |
| Outlook on the web | Add calendar → Subscribe from web → paste → Import | Outlook's own schedule |

Every card is an **all-day** `VEVENT` marked `TRANSP:TRANSPARENT`: a PTD card is a
date range, not an appointment, and keeping it out of free/busy means a week of
tasks does not make you look fully booked.

Calling `ical.url` twice in the same server process returns the *same* URL. After a
restart the secret is no longer in memory — only its hash is stored — so the next
call rotates: the old token is revoked and a new link issued, and the result says
so in `rotated` and `note`, because someone whose subscription just stopped updating
deserves to be told why.
