# Concepts

## Organization

Everything in PTD belongs to exactly one organization. Users can be members of
several; a membership carries the user's **role** in that one organization.

Every action handler filters by the organization resolved from the request, never
by an id the caller supplied, so a valid credential for org A cannot read org B by
passing its ids.

How the organization is resolved, in order of precedence:

1. the `X-Org-Id` header,
2. the `?orgId=` query parameter,
3. for a `ptd_…` token, the organization the token was minted for,
4. otherwise the caller's oldest membership.

If the caller is not a member of the organization named in (1) or (2), the request
is refused with `403`.

## Roles

Four roles, strictly ranked. Each action declares the minimum role it needs, and
the registry checks it before the handler runs — so MCP, REST, Slack and the web
client all enforce the same thing.

| Role | Rank | Typically may |
|---|---|---|
| `member` | 1 | Read the backlog, run their own timer, log their own time, complete tasks assigned to them, correct their own ledger lines |
| `manager` | 2 | Create and schedule tasks, edit streams, set priorities and assignees, run imports, read the whole organization's ledger and reports |
| `admin` | 3 | Invite people, mint agent invite codes, configure webhooks and integrations |
| `owner` | 4 | Change roles, manage billing on the hosted plan |

A role is a floor, not a category: `owner` can do everything a `member` can.
Two rules are finer-grained than the role alone:

- `task.complete` — a `member` may complete only a task assigned to themselves.
- `time_entry.update` / `time_entry.delete` — a `member` may correct only their own
  lines; `manager` and above may correct anyone's in the organization.

## Streams, apps and tasks

- **App** — a product, service or codebase the organization owns. It has a short
  lowercase `key` (unique per organization, and immutable because external
  references point at it), a name, URLs, a repo reference and a stack list.
- **Stream** — a swim-lane of work: "Security audit", "API v2". A stream may be
  attached to several apps, which is what makes it *systemic* — work that crosses
  products and is worth fixing at the platform level. A stream can carry an agent
  budget in dollars.
- **Task** — the single shared unit of work. It may belong to a stream, an app,
  both or neither, and it is the thing both surfaces point at: Plan schedules it,
  Track logs time against it.
- **Customer** — who the work is billed to. A stream's customer is inherited by
  time entries that name only the stream.

A task's own fields worth knowing:

| Field | Meaning |
|---|---|
| `status` | `backlog`, `triaged`, `in-progress`, `completed`, `wontfix` |
| `startDate` + `estimatedDuration` | Where and how wide the Gantt bar is. A task with no `startDate` sits in the backlog |
| `dueDate` | A hard deadline pin, independent of the duration |
| `dependencies` | Task ids that must finish first. Cycles are refused; moving a task cascades its dependents forward |
| `externalKey` | A stable id from the source system (`SEC-3`, a Jira key, an issue URL), unique per organization. This is what imports and the CLI resolve against |
| `urgency`, `impact`, `effort` | The 0–10 inputs to the priority score |
| `priorityScore`, `prioritySource` | The 0–100 result, and whether it was derived or pinned |

Every mutation writes one append-only `task_events` row — who changed what, when,
and through which adapter (`web`, `mcp`, `api`, `import`, plus one value per chat or
code-host integration) — and fires one webhook. `task.history` reads it back.

## Depth on a card: comments, files, recurrence, custom fields

Four things hang off a task besides its own columns. All four are org-scoped and
go through the same registry as everything else, so an agent over MCP, a chat bot
and the card editor can all reach them.

### Comments

`task.comment_add`, `task.comment_list`, `task.comment_delete`.

Any **member** may comment on any card in their organization — a comment is the
cheapest way for someone who cannot edit a card to say something about it. A
comment may be deleted by its author, or by a **manager** and above.

Bodies are stored exactly as typed and rendered as **markdown-lite**: `**bold**`,
`_italic_`, `` `code` ``, `[text](url)` and bare links, and nothing else. The
rendering happens where it is displayed and is sanitised there, because a comment
can be written by an agent over MCP or by a chat bot — the stored text is
untrusted by construction. Links are `http(s)`/`mailto` only.

Each comment writes one `updated` history row noted *commented*, so the card's
own history says a conversation happened; webhook consumers get
`task.commented` rather than another `task.updated` to sniff.

From chat, on all three surfaces at once: `/ptd comment PTD-12 waiting on the vendor`.

### Attachments

Bytes do not travel through an action — JSON is the wrong envelope for 25 MB of
PDF — so files use two routes, and the verbs stay actions:

| | |
|---|---|
| `PUT /api/plan/tasks/:id/attachments?filename=…` | raw body, `Content-Type: application/octet-stream`, up to **25 MB** |
| `GET /api/plan/attachments/:id` | the bytes back, org-scoped |
| `task.attachment_list` / `task.attachment_delete` | the card's files, and removing one (uploader, or manager and above) |

Storage is content-addressed under `PTD_FILES_DIR` (`./data/files` in
development, the `ptd_files` volume at `/data/files` under compose):

```
<root>/<orgId>/<sha256[0:2]>/<sha256[2:4]>/<sha256>
```

The path is built from the organization id and the sha256 of the bytes, which are
hashed as they are written. **The filename is a label and nothing else** — so
`?filename=../../etc/passwd` is stored as `passwd` and cannot influence where
anything is written, and a `storage_key` that is not exactly that shape is
refused on the way out too. Identical bytes are stored once per organization: a
second upload of the same file reuses the blob, and deleting a row only unlinks
it when the last reference goes.

On the way back, images, PDFs and plain text render in place; **everything else
is forced to download**, and nothing is served with a type the browser might
treat as script (`image/svg+xml` is deliberately not on the inline list).

### Recurring tasks

`task.recur_set` (**manager**) turns a card into a template that clones itself
into a new backlog card on a schedule; `task.recur_list` reads them back.

| Rule | Fires |
|---|---|
| `daily` | every day |
| `weekdays` | Monday–Friday |
| `weekly:mon,wed` | those weekdays |
| `monthly:15` | the 15th, clamped to the last day of a shorter month |
| `every:3d`, `every:2w` | a fixed cadence from the day the rule was set |

Any of them may carry `at:09:00`, which defaults to 09:00. **Times are UTC in
v1** — an organization-local clock needs a timezone on the organization, which
the schema does not carry yet, so the preview in the card editor says UTC out
loud rather than implying local time.

A scheduler ticks every 60 seconds (disable it with `PTD_SCHEDULER=0`) and claims
each due row with an `UPDATE … WHERE next_run_at <= now()` before it clones
anything, so two PTD processes against one database cannot both fire the same
occurrence. The clone copies title, description, stream, app, assignee, estimate,
tags, the priority inputs and every custom value; it does **not** copy dates,
dependencies or status — an instance starts in the backlog with nothing blocking
it. It takes the external key `<templateKey>-<yyyymmdd>` and a `created` history
row noted *recurring*, `via: api`.

### Custom fields

`field.create` / `field.update` / `field.archive` (**manager**), `field.list`
(member), and `task.set_custom` to write values — a member may write only to a
card assigned to them, a manager to any card.

A field is defined once for the organization and holds a value per card. Its
`key` is derived from the name (`Customer severity` → `customer_severity`) and
then fixed, so renaming the field changes its label and not its identity, and a
payload an agent saved keeps working. Seven kinds, each validated on write:

| Kind | Accepts |
|---|---|
| `text` | a string, up to 2000 characters |
| `number` | a number (a numeric string is coerced) |
| `date` | an ISO date, stored as a calendar day |
| `select` | exactly one of the field's options |
| `multiselect` | any of them, de-duplicated |
| `checkbox` | `true` / `false` |
| `url` | an `http(s)` URL — nothing else is a link |

`null` clears a value, and a key the organization does not define is an error
rather than a silent no-op, so a typo in an agent's payload surfaces at once.
Values come back on `task.get` and `task.list` as `custom: { key: value }`, and
`task.custom_values` reads many cards at once for a table. Fields are archived,
never deleted: cards keep what they recorded, the field just stops being offered
and its values stop being returned.

## Priority: 0–100

```
priorityScore = clamp(round(urgency × impact ÷ max(effort, 1)), 0, 100)
```

`urgency`, `impact` and `effort` are each 0–10, so the useful range is 0–100 and
the arithmetic is one line a person can check. Effort divides, so a cheap task
with the same urgency and impact outranks an expensive one.

| Band | Score |
|---|---|
| critical | 75–100 |
| high | 50–74 |
| medium | 25–49 |
| low | 0–24 |

The score is derived on write unless it is pinned: `task.set_priority` can fix a
score by hand (`prioritySource` becomes `manual`, with an optional note), and a
pinned score is not recomputed when the inputs change.

`next_task` returns the highest-scoring task still worth starting (status
`backlog` or `triaged`) together with `why` — the formula, the band and the
explanation. By default it only offers work that is unclaimed or already assigned
to the caller, which is what makes it safe to poll in a loop: as soon as a card is
assigned to one worker, the others stop being offered it. Pass
`assignee: "any"` to ignore assignment entirely.

## Attribution: human or agent

Every time entry records whether a human or an agent did the work, and agent
entries can carry the tokens and the API cost the session consumed. That is the
number a manager cannot otherwise get: what the agents they delegate to actually
spend, per task, next to the human hours.

**It cannot be spoofed, by construction:**

1. `entry_source` is taken from the *credential*. The auth middleware sets
   `authType` to `agent` for a `ptd_…` token (or a JWT belonging to a seat flagged
   `is_agent`) and `human` otherwise; the insert reads that, never an argument.
2. **No action accepts `entrySource` or `agentLabel` as input.** They are not in
   any input schema, so they cannot be passed over REST, MCP, Slack or the CLI.
3. `tokensUsed` and `apiCostUsd` are *stored only* when the source is `agent`. A
   human session that sends them gets them dropped, and the response names them in
   `ignored` with the reason — the request is not silently accepted.
4. `time_entry.update` cannot touch any of those four columns. Times, references
   and the note are editable; the attribution is immutable once written, so the
   human-vs-agent record cannot be rewritten after the fact.

The consequence worth planning around: **an agent must use its own token.** If an
agent runs with a human's JWT, its work is recorded as human work and its tokens
and cost are thrown away. Give each agent a seat — see [agents.md](agents.md).

## One timer per member

A member has at most one open time entry. `time_entry.start` refuses to open a
second work session while one is running; a break is the exception — it *cuts*,
closing the running session and opening the break in the same call, and reports
what it closed in `cut`. An entry left open longer than 24 hours cannot be
stopped normally: fix it with `time_entry.update` (set an explicit `checkOut`) or
delete it, so a timer forgotten overnight never becomes a 300-hour line.
