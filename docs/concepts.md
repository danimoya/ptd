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
