#!/bin/sh
# Shared plumbing for the PTD Claude Code hooks. Sourced, never run directly.
#
# Dependencies, deliberately minimal: POSIX sh, curl, and either python3 or node
# for JSON. Nothing else — a hook that needs a package manager is a hook people
# uninstall.
#
# Everything here is best-effort. A hook that fails must never fail the Claude
# Code session, so every function returns rather than exits, and the callers end
# with `exit 0` whatever happened.

PTD_HOOK_VERSION="1.0.0"

ptd_log() {
  printf '[ptd-hook] %s\n' "$*" >&2
}

# ── JSON engine ───────────────────────────────────────────────────────────
# One small program per language, dispatching on $1. Ops:
#   get <dot.path>        read JSON on stdin, print one scalar (empty if absent)
#   usage <transcript>    sum a Claude Code transcript: "in out cacheRead cacheWrite turns sha256 model"
#   taskid <externalKey>  read a task.list response on stdin, print the matching task id
#   esc                   print stdin as a JSON string literal
PTD_ENGINE=""
if command -v python3 >/dev/null 2>&1; then
  PTD_ENGINE="python3"
elif command -v node >/dev/null 2>&1; then
  PTD_ENGINE="node"
fi

PTD_PY_PROG=$(cat <<'PYEOF'
import sys, json, hashlib

def scalar(v):
    if v is None or isinstance(v, (dict, list)):
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)

op = sys.argv[1] if len(sys.argv) > 1 else ""

if op == "get":
    try:
        data = json.load(sys.stdin)
    except Exception:
        print("")
        sys.exit(0)
    cur = data
    for part in sys.argv[2].split("."):
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except Exception:
                cur = None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            cur = None
        if cur is None:
            break
    print(scalar(cur))

elif op == "esc":
    print(json.dumps(sys.stdin.read()))

elif op == "taskid":
    key = sys.argv[2]
    try:
        data = json.load(sys.stdin)
    except Exception:
        print("")
        sys.exit(0)
    tasks = data.get("tasks") if isinstance(data, dict) else data
    if not isinstance(tasks, list):
        print("")
        sys.exit(0)
    hit = ""
    for t in tasks:
        if not isinstance(t, dict):
            continue
        ek = t.get("externalKey")
        if isinstance(ek, str) and ek.lower() == key.lower():
            hit = str(t.get("id", ""))
            break
    print(hit)

elif op == "usage":
    # Sum every assistant turn's usage block, de-duplicated by message id: a
    # streamed reply can appear on several transcript lines under one id, and
    # counting each line would multiply the session's tokens.
    path = sys.argv[2]
    tot = {"i": 0, "o": 0, "cr": 0, "cc": 0}
    turns = 0
    model = ""
    seen = set()
    sha = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for raw in fh:
                sha.update(raw)
                try:
                    rec = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(rec, dict):
                    continue
                msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
                if rec.get("type") != "assistant" and msg.get("role") != "assistant":
                    continue
                u = msg.get("usage") if isinstance(msg.get("usage"), dict) else None
                if u is None and isinstance(rec.get("usage"), dict):
                    u = rec["usage"]
                if not u:
                    continue
                mid = msg.get("id") or rec.get("uuid")
                if mid:
                    if mid in seen:
                        continue
                    seen.add(mid)
                def n(key):
                    try:
                        return int(u.get(key) or 0)
                    except Exception:
                        return 0
                cc = n("cache_creation_input_tokens")
                if cc == 0 and isinstance(u.get("cache_creation"), dict):
                    cd = u["cache_creation"]
                    for k in ("ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"):
                        try:
                            cc += int(cd.get(k) or 0)
                        except Exception:
                            pass
                i, o, cr = n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens")
                if i + o + cr + cc == 0:
                    continue
                tot["i"] += i
                tot["o"] += o
                tot["cr"] += cr
                tot["cc"] += cc
                turns += 1
                m = msg.get("model") or rec.get("model")
                if isinstance(m, str) and m:
                    model = m
    except OSError:
        print("0 0 0 0 0  ")
        sys.exit(0)
    print("%d %d %d %d %d %s %s" % (tot["i"], tot["o"], tot["cr"], tot["cc"], turns, sha.hexdigest(), model))

else:
    print("")
PYEOF
)

PTD_JS_PROG=$(cat <<'JSEOF'
const fs = require("fs");
const crypto = require("crypto");
let argv = process.argv.slice(1);
if (argv[0] === "--") argv = argv.slice(1);
const op = argv[0] || "";
const readStdin = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };
const scalar = (v) => (v === null || v === undefined || typeof v === "object" ? "" : String(v));

if (op === "get") {
  let data; try { data = JSON.parse(readStdin()); } catch { console.log(""); process.exit(0); }
  let cur = data;
  for (const part of String(argv[1] || "").split(".")) {
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (cur && typeof cur === "object") cur = cur[part];
    else cur = undefined;
    if (cur === undefined || cur === null) break;
  }
  console.log(scalar(cur));
} else if (op === "esc") {
  console.log(JSON.stringify(readStdin()));
} else if (op === "taskid") {
  const key = String(argv[1] || "").toLowerCase();
  let data; try { data = JSON.parse(readStdin()); } catch { console.log(""); process.exit(0); }
  const tasks = Array.isArray(data) ? data : data && Array.isArray(data.tasks) ? data.tasks : [];
  const hit = tasks.find((t) => t && typeof t.externalKey === "string" && t.externalKey.toLowerCase() === key);
  console.log(hit ? String(hit.id) : "");
} else if (op === "usage") {
  let body; try { body = fs.readFileSync(argv[1]); } catch { console.log("0 0 0 0 0  "); process.exit(0); }
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  let i = 0, o = 0, cr = 0, cc = 0, turns = 0, model = "";
  const seen = new Set();
  for (const line of body.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== "object") continue;
    const msg = rec.message && typeof rec.message === "object" ? rec.message : {};
    if (rec.type !== "assistant" && msg.role !== "assistant") continue;
    const u = msg.usage && typeof msg.usage === "object" ? msg.usage : rec.usage && typeof rec.usage === "object" ? rec.usage : null;
    if (!u) continue;
    const mid = msg.id || rec.uuid;
    if (mid) { if (seen.has(mid)) continue; seen.add(mid); }
    const n = (k) => { const v = Number(u[k] || 0); return Number.isFinite(v) ? v : 0; };
    let write = n("cache_creation_input_tokens");
    if (write === 0 && u.cache_creation && typeof u.cache_creation === "object") {
      write = Number(u.cache_creation.ephemeral_5m_input_tokens || 0) + Number(u.cache_creation.ephemeral_1h_input_tokens || 0);
    }
    const inp = n("input_tokens"), out = n("output_tokens"), read = n("cache_read_input_tokens");
    if (inp + out + read + write === 0) continue;
    i += inp; o += out; cr += read; cc += write; turns += 1;
    const m = msg.model || rec.model;
    if (typeof m === "string" && m) model = m;
  }
  console.log(`${i} ${o} ${cr} ${cc} ${turns} ${sha} ${model}`);
} else {
  console.log("");
}
JSEOF
)

# ptd_json <op> [args…] — reads stdin, prints one line.
ptd_json() {
  if [ "$PTD_ENGINE" = "python3" ]; then
    python3 -c "$PTD_PY_PROG" "$@"
  elif [ "$PTD_ENGINE" = "node" ]; then
    node -e "$PTD_JS_PROG" -- "$@"
  else
    echo ""
  fi
}

# ── Configuration ─────────────────────────────────────────────────────────
# PTD_URL / PTD_TOKEN / PTD_ORG_ID win; otherwise the CLI's own config file is
# read, so `ptd login` is all the setup a person needs.
ptd_load_config() {
  PTD_CONFIG_PATH="${PTD_CONFIG:-${XDG_CONFIG_HOME:-${HOME:-.}/.config}/ptd/config.json}"
  if [ -f "$PTD_CONFIG_PATH" ]; then
    [ -z "${PTD_URL:-}" ] && PTD_URL=$(ptd_json get baseUrl < "$PTD_CONFIG_PATH")
    [ -z "${PTD_TOKEN:-}" ] && PTD_TOKEN=$(ptd_json get token < "$PTD_CONFIG_PATH")
    [ -z "${PTD_ORG_ID:-}" ] && PTD_ORG_ID=$(ptd_json get orgId < "$PTD_CONFIG_PATH")
  fi
  PTD_URL=$(printf '%s' "${PTD_URL:-}" | sed 's#/*$##')
  PTD_TOKEN="${PTD_TOKEN:-}"
  PTD_ORG_ID="${PTD_ORG_ID:-}"
  PTD_HTTP=""
  export PTD_URL PTD_TOKEN PTD_ORG_ID
}

ptd_ready() {
  if [ -z "$PTD_ENGINE" ]; then
    ptd_log "neither python3 nor node found — skipping"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    ptd_log "curl not found — skipping"
    return 1
  fi
  if [ -z "${PTD_URL:-}" ] || [ -z "${PTD_TOKEN:-}" ]; then
    ptd_log "no PTD credential (set PTD_URL and PTD_TOKEN, or run \`ptd login\`) — skipping"
    return 1
  fi
  return 0
}

# ptd_call <action> <json-body> — prints the response body, sets PTD_HTTP.
# Never fails the caller: a transport error prints nothing and sets PTD_HTTP=000.
ptd_call() {
  _action="$1"
  _body="$2"
  _out=$(
    curl -sS -m 20 -w '\n%{http_code}' \
      -X POST "$PTD_URL/api/actions/$_action" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $PTD_TOKEN" \
      ${PTD_ORG_ID:+-H "X-Org-Id: $PTD_ORG_ID"} \
      -d "$_body" 2>/dev/null
  ) || _out="
000"
  PTD_HTTP=$(printf '%s' "$_out" | tail -n 1)
  printf '%s' "$_out" | sed '$d'
}

# The task this repository is working on: $PTD_TASK, else a .ptd-task file at or
# above the working directory (stopping at the filesystem root). The value is a
# task id when numeric, otherwise an externalKey.
ptd_repo_task() {
  if [ -n "${PTD_TASK:-}" ]; then
    printf '%s' "$PTD_TASK"
    return 0
  fi
  _dir="${1:-$PWD}"
  while [ -n "$_dir" ] && [ "$_dir" != "/" ]; do
    if [ -f "$_dir/.ptd-task" ]; then
      head -n 1 "$_dir/.ptd-task" | tr -d ' \t\r\n'
      return 0
    fi
    _dir=$(dirname "$_dir")
  done
  printf ''
}

# Resolve a task reference (id or externalKey) to a numeric id, or empty.
ptd_task_id() {
  _ref="$1"
  [ -z "$_ref" ] && { printf ''; return 0; }
  case "$_ref" in
    *[!0-9]*) ;;
    *) printf '%s' "$_ref"; return 0 ;;
  esac
  ptd_call task.list '{"includeCompleted":false}' | ptd_json taskid "$_ref"
}
