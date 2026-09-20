#!/bin/sh
# PTD · Claude Code Stop hook — close the entry, report usage, then attest it.
#
# Three calls, in this order:
#   1. usage.price       what PTD's own table says this token split costs, so the
#                        reported figure and the verified one are derived the same way
#   2. time_entry.stop   {tokensUsed, apiCostUsd} — the agent's own report
#   3. time_entry.attest {source:"claude_code_hook", evidence:{…}} — the second
#                        opinion, measured from the transcript rather than claimed
#
# The token figure is summed from the session transcript at `transcript_path`
# (given on the hook's stdin payload): every assistant turn's
# usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens},
# de-duplicated by message id. The evidence carries the transcript's SHA-256, the
# turn count and the model, so the attestation names what it measured.
#
# Idempotent: with nothing running it logs and exits. Always exits 0.

set -u

DIR=$(dirname "$0")
. "$DIR/ptd-hook-common.sh"

PAYLOAD=$(cat 2>/dev/null || printf '{}')
[ -z "$PAYLOAD" ] && PAYLOAD='{}'

ptd_load_config
ptd_ready || exit 0

SESSION=$(printf '%s' "$PAYLOAD" | ptd_json get session_id)
TRANSCRIPT=$(printf '%s' "$PAYLOAD" | ptd_json get transcript_path)

CURRENT=$(ptd_call time_entry.current '{}')
ENTRY_ID=$(printf '%s' "$CURRENT" | ptd_json get id)
if [ -z "$ENTRY_ID" ]; then
  ptd_log "nothing running — nothing to stop"
  exit 0
fi

# ── Measure ───────────────────────────────────────────────────────────────
INPUT=0; OUTPUT=0; CACHE_READ=0; CACHE_WRITE=0; TURNS=0; SHA=""; MODEL=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  # shellcheck disable=SC2046
  set -- $(printf '' | ptd_json usage "$TRANSCRIPT")
  INPUT=${1:-0}; OUTPUT=${2:-0}; CACHE_READ=${3:-0}; CACHE_WRITE=${4:-0}; TURNS=${5:-0}; SHA=${6:-}; MODEL=${7:-}
else
  ptd_log "no readable transcript at \"${TRANSCRIPT:-}\" — stopping the entry without a usage figure"
fi
TOKENS=$((INPUT + OUTPUT + CACHE_READ + CACHE_WRITE))

# ── Price it the way the server will ──────────────────────────────────────
COST=""
if [ -n "$MODEL" ] && [ "$TOKENS" -gt 0 ]; then
  PRICE_BODY=$(printf '{"model":%s,"inputTokens":%s,"outputTokens":%s,"cacheReadTokens":%s,"cacheCreationTokens":%s}' \
    "$(printf '%s' "$MODEL" | ptd_json esc)" "$INPUT" "$OUTPUT" "$CACHE_READ" "$CACHE_WRITE")
  PRICED=$(ptd_call usage.price "$PRICE_BODY")
  if [ "$(printf '%s' "$PRICED" | ptd_json get priced)" = "true" ]; then
    COST=$(printf '%s' "$PRICED" | ptd_json get costUsd)
  fi
fi

# ── Stop ──────────────────────────────────────────────────────────────────
NOTES="Claude Code session${SESSION:+ $SESSION}${TURNS:+ · $TURNS turns}"
if [ "$TOKENS" -gt 0 ]; then
  STOP_BODY=$(printf '{"tokensUsed":%s%s,"notes":%s}' \
    "$TOKENS" "${COST:+,\"apiCostUsd\":$COST}" "$(printf '%s' "$NOTES" | ptd_json esc)")
else
  STOP_BODY=$(printf '{"notes":%s}' "$(printf '%s' "$NOTES" | ptd_json esc)")
fi
STOPPED=$(ptd_call time_entry.stop "$STOP_BODY")
STOPPED_ID=$(printf '%s' "$STOPPED" | ptd_json get entry.id)
if [ -z "$STOPPED_ID" ]; then
  MSG=$(printf '%s' "$STOPPED" | ptd_json get message)
  ptd_log "time_entry.stop failed (HTTP ${PTD_HTTP:-?})${MSG:+: $MSG}"
  exit 0
fi
MINUTES=$(printf '%s' "$STOPPED" | ptd_json get minutes)
ptd_log "stopped entry #$STOPPED_ID after ${MINUTES:-0} min · $TOKENS tok${COST:+ · \$$COST}"

# ── Attest ────────────────────────────────────────────────────────────────
# Nothing to attest without a transcript: an attestation with no measurement
# behind it would be exactly the unverifiable self-report this feature exists to
# replace.
if [ "$TOKENS" -le 0 ]; then
  ptd_log "no usage measured — not attesting"
  exit 0
fi

EVIDENCE=$(printf '{"model":%s,"turns":%s,"transcriptSha256":%s,"sessionId":%s,"inputTokens":%s,"outputTokens":%s,"cacheReadTokens":%s,"cacheCreationTokens":%s,"hook":"ptd-session-stop.sh","hookVersion":%s}' \
  "$(printf '%s' "$MODEL" | ptd_json esc)" \
  "${TURNS:-0}" \
  "$(printf '%s' "$SHA" | ptd_json esc)" \
  "$(printf '%s' "$SESSION" | ptd_json esc)" \
  "$INPUT" "$OUTPUT" "$CACHE_READ" "$CACHE_WRITE" \
  "$(printf '%s' "$PTD_HOOK_VERSION" | ptd_json esc)")

ATTEST_BODY=$(printf '{"entryId":%s,"tokens":%s,"source":"claude_code_hook","evidence":%s}' "$STOPPED_ID" "$TOKENS" "$EVIDENCE")
ATTESTED=$(ptd_call time_entry.attest "$ATTEST_BODY")
VERIFIED=$(printf '%s' "$ATTESTED" | ptd_json get verified.tokens)
if [ -z "$VERIFIED" ]; then
  MSG=$(printf '%s' "$ATTESTED" | ptd_json get message)
  ptd_log "time_entry.attest failed (HTTP ${PTD_HTTP:-?})${MSG:+: $MSG}"
  exit 0
fi
VCOST=$(printf '%s' "$ATTESTED" | ptd_json get verified.costUsd)
ptd_log "attested entry #$STOPPED_ID: $VERIFIED tok${VCOST:+ · \$$VCOST} (claude_code_hook, sha ${SHA%"${SHA#????????}"})"

exit 0
