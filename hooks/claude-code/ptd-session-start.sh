#!/bin/sh
# PTD · Claude Code SessionStart hook — open a time entry for this session.
#
# Which card the session is booked against, in order:
#   1. $PTD_TASK                     (an id, or an externalKey like SEC-3)
#   2. a .ptd-task file at or above the session's working directory
#   3. next_task {assignee:"me"}     — whatever PTD thinks the agent should do next
#
# Idempotent: if a timer is already running on this seat the hook does nothing,
# so a resumed or re-entered session cannot double-count. It always exits 0 —
# a tracker that can block a coding session is a tracker people turn off.
#
# Configuration: PTD_URL + PTD_TOKEN, or the `ptd login` config file.
# Optional: PTD_ORG_ID, PTD_TASK, PTD_HOOK_QUIET=1.

set -u

DIR=$(dirname "$0")
. "$DIR/ptd-hook-common.sh"

PAYLOAD=$(cat 2>/dev/null || printf '{}')
[ -z "$PAYLOAD" ] && PAYLOAD='{}'

ptd_load_config
ptd_ready || exit 0

SESSION=$(printf '%s' "$PAYLOAD" | ptd_json get session_id)
CWD=$(printf '%s' "$PAYLOAD" | ptd_json get cwd)
[ -z "$CWD" ] && CWD="$PWD"
SOURCE=$(printf '%s' "$PAYLOAD" | ptd_json get source)

# Already running? Leave it alone — stopping and restarting would split one
# session into two ledger lines with half the tokens each.
CURRENT=$(ptd_call time_entry.current '{}')
CURRENT_ID=$(printf '%s' "$CURRENT" | ptd_json get id)
if [ -n "$CURRENT_ID" ]; then
  ptd_log "entry #$CURRENT_ID already running — leaving it be"
  [ "${PTD_HOOK_QUIET:-}" = "1" ] || printf 'PTD: time entry #%s is already running; this session is being tracked against it.\n' "$CURRENT_ID"
  exit 0
fi

REF=$(ptd_repo_task "$CWD")
TASK_ID=$(ptd_task_id "$REF")
PICKED="named"

if [ -z "$TASK_ID" ]; then
  # Nothing named (or the key did not resolve): ask PTD what to work on.
  NEXT=$(ptd_call next_task '{"assignee":"me"}')
  TASK_ID=$(printf '%s' "$NEXT" | ptd_json get task.id)
  PICKED="next_task"
  if [ -n "$REF" ]; then
    ptd_log "task reference \"$REF\" did not resolve; fell back to next_task"
  fi
fi

if [ -z "$TASK_ID" ]; then
  ptd_log "no task to book against (nothing assigned to this seat) — starting an unattributed entry"
  BODY='{"notes":"Claude Code session"}'
else
  NOTES="Claude Code session${SESSION:+ $SESSION}${SOURCE:+ ($SOURCE)}"
  BODY=$(printf '{"taskId":%s,"notes":%s}' "$TASK_ID" "$(printf '%s' "$NOTES" | ptd_json esc)")
fi

RESP=$(ptd_call time_entry.start "$BODY")
ENTRY_ID=$(printf '%s' "$RESP" | ptd_json get entry.id)

if [ -z "$ENTRY_ID" ]; then
  MSG=$(printf '%s' "$RESP" | ptd_json get message)
  ptd_log "time_entry.start failed (HTTP ${PTD_HTTP:-?})${MSG:+: $MSG}"
  exit 0
fi

SRC=$(printf '%s' "$RESP" | ptd_json get entry.entrySource)
TITLE=$(printf '%s' "$RESP" | ptd_json get entry.taskTitle)
ptd_log "started entry #$ENTRY_ID ($SRC) on ${TITLE:-no task} via $PICKED"
[ "${PTD_HOOK_QUIET:-}" = "1" ] || printf 'PTD: tracking this session as entry #%s (%s)%s. Tokens and cost will be reported and attested when the session stops.\n' \
  "$ENTRY_ID" "$SRC" "${TITLE:+ on \"$TITLE\"}"

exit 0
