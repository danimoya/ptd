# PTD hooks for Claude Code

Two shell scripts that make a Claude Code session's cost a **fact rather than a claim**.

PTD already lets an agent report what it spent: `time_entry.stop {tokensUsed, apiCostUsd}`.
The obvious objection is that an agent reporting its own bill is not evidence of anything.
So these hooks do two separate things, in this order:

1. **report** — close the entry with the figure summed from the session's own transcript;
2. **attest** — write that same figure into `verifiedTokens` / `verifiedCostUsd` /
   `verifiedSource` / `verifiedAt`, with the transcript's SHA-256, the turn count and
   the model as evidence.

Both numbers survive. `usage.summary` puts them side by side, per agent and per stream,
with a coverage percentage and every session whose two figures disagree by more than the
tolerance.

## What you need

| | |
|---|---|
| **Claude Code** | any version with `SessionStart` and `Stop` hooks |
| **An agent seat** | Org → Agents → register an agent, keep the `ptd_…` token |
| **On the machine** | POSIX `sh`, `curl`, and either `python3` or `node` |

No npm install, no Python package, nothing to keep updated. The token must be an **agent
seat's** — PTD records tokens and cost only for `entry_source = "agent"` entries, and a
human session's figures are dropped (and named back in `ignored`).

## Install

```sh
mkdir -p ~/.claude/ptd && cd ~/.claude/ptd
BASE=https://raw.githubusercontent.com/danimoya/ptd/main/hooks/claude-code
curl -fsSLO $BASE/ptd-hook-common.sh
curl -fsSLO $BASE/ptd-session-start.sh
curl -fsSLO $BASE/ptd-session-stop.sh
chmod +x ptd-session-start.sh ptd-session-stop.sh
```

All three files together: the two hooks share their JSON, config and HTTP plumbing, and
each sources `ptd-hook-common.sh` from its own directory.

Then merge `settings.snippet.json` into `~/.claude/settings.json` (or a repository's
`.claude/settings.json`), replacing the paths and the two environment values:

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

Leave `env` out entirely if you would rather run `ptd login` — the hooks read the CLI's
own `~/.config/ptd/config.json` when the environment says nothing.

## Configuration

| Variable | Meaning |
|---|---|
| `PTD_URL` | Base URL of the deployment. Falls back to `baseUrl` in the CLI config file |
| `PTD_TOKEN` | An agent seat's bearer token. Falls back to `token` in the CLI config file |
| `PTD_ORG_ID` | Only needed when the token belongs to more than one organization |
| `PTD_TASK` | Task id or `externalKey` to book the session against |
| `PTD_CONFIG` | Path to the CLI config file (default `${XDG_CONFIG_HOME:-~/.config}/ptd/config.json`) |
| `PTD_HOOK_QUIET` | `1` stops the start hook writing its one line of session context |

## Which card does the time land on?

`ptd-session-start.sh` tries three things, in order:

1. `$PTD_TASK`;
2. the first line of a `.ptd-task` file at or above the session's working directory —
   `echo SEC-3 > .ptd-task` labels a checkout once and the whole team's sessions land right;
3. `next_task {assignee: "me"}` — whatever PTD thinks this seat should be doing.

A numeric value is a task id; anything else is matched against `externalKey`. If none of
the three produces a card, the hook still opens an entry — the time is real either way.

## What the Stop hook measures

`transcript_path` comes in on the hook's stdin payload. The script sums, across every
assistant turn in that JSONL file:

```
usage.input_tokens + usage.output_tokens
  + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
```

De-duplicated by `message.id`, because a streamed reply is written to the transcript on
several lines under one id and counting each line would multiply the session's tokens.
The model of the last assistant turn is the model the attestation names.

It then calls, in order:

| Call | Why |
|---|---|
| `usage.price` | PTD's own price table, so the *reported* dollar figure is the same arithmetic the server will use for the verified one — cache reads at 0.1× and 5-minute cache writes at 1.25× the input rate |
| `time_entry.stop` | `{tokensUsed, apiCostUsd, notes}` — the agent's own report |
| `time_entry.attest` | `{tokens, source: "claude_code_hook", evidence: {model, turns, transcriptSha256, sessionId, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens}}` |

With no readable transcript the entry is still stopped, but **nothing is attested**: an
attestation with no measurement behind it is exactly the unverifiable self-report this is
here to replace.

## Behaviour worth knowing

- **Both hooks always exit 0.** A tracker that can fail a coding session is a tracker
  people turn off. Failures go to stderr with a `[ptd-hook]` prefix.
- **The start hook is idempotent.** With a timer already running it says so and leaves it
  alone, so `--resume` and `/clear` cannot split one session into two half-counted lines.
- **The stop hook is idempotent.** With nothing running it logs and exits.
- **Re-attesting is allowed** and replaces the previous figure, while the task history
  keeps every attestation — so a hook that fires twice is harmless and still visible.
- **No credential, no work.** Missing `PTD_URL`/`PTD_TOKEN`, or neither `python3` nor
  `node` on the box, and the hooks say why on stderr and do nothing.

## Try it without Claude Code

The hooks read the same JSON payload Claude Code sends, so they can be driven by hand:

```sh
export PTD_URL=https://ptd.example PTD_TOKEN=ptd_…

printf '{"session_id":"probe","hook_event_name":"SessionStart"}' \
  | ~/.claude/ptd/ptd-session-start.sh
# [ptd-hook] started entry #42 (agent) on Add CSRF tokens to every form via .ptd-task

printf '{"session_id":"probe","transcript_path":"/path/to/transcript.jsonl"}' \
  | ~/.claude/ptd/ptd-session-stop.sh
# [ptd-hook] stopped entry #42 after 12 min · 143793 tok · $0.150315
# [ptd-hook] attested entry #42: 143793 tok · $0.150315 (claude_code_hook, sha 9b736ae2)
```

Then read it back: `usage.summary` (manager) or Overview → Agents.

## Agents that are not Claude Code

The same attestation is available from the CLI and from CI. See
[`docs/agents.md`](../../docs/agents.md) → *Verified usage*:

```sh
ptd agent-run --task SEC-3 -- python fix_forms.py      # wraps any command
ptd ci-report --task SEC-3 --tokens 143793 --model claude-opus-5 --minutes 4
```

and the composite GitHub Action in [`.github/actions/ptd-report`](../../.github/actions/ptd-report/action.yml).
