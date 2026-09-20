#!/bin/sh
# PTD backup — a HeliosDB-Nano dump, plus the TLS key pair and the attachment files.
#
# WHY IT LOOKS LIKE THIS. HeliosDB-Nano 4.40's dump is an offline, embedded-mode
# operation: `dump --connection …` answers "Server mode dump not yet implemented",
# `dump --data-dir /data` against the live directory fails on the RocksDB lock
# ("While lock file: /data/LOCK: Resource temporarily unavailable"), and the server's
# own `--dump-schedule` flag refuses at startup with "dump-schedule is not
# implemented yet; use OS cron with `heliosdb-nano dump`". So this script does the one
# thing that works without downtime: it copies the data directory (RocksDB files are
# append-or-replace, so a copy is a crash-consistent snapshot), runs the dump against
# the copy, and throws the copy away. That is `--mode snapshot`, the default.
#
# `--mode cold` is the belt-and-braces version: stop the database container, dump the
# real directory, start it again. It needs the docker CLI and costs a few seconds of
# downtime, and it is the mode to use before an engine upgrade.
#
# The dump is self-describing and verifiable: `--verify` restores it into a scratch
# directory (`heliosdb-nano restore --verify`) and throws that away too, so a torn
# snapshot is caught at backup time rather than at restore time.
#
# WHERE IT RUNS. Two ways, same script:
#   * inside a container that has the volumes mounted — what the compose `backup`
#     profile service does (`docker compose --profile backup up -d ptd-backup`);
#   * on the host, where it drives `docker exec` / `docker cp` against the running
#     containers.
# It picks the mode by looking for the data directory and the binary.
#
# USAGE
#   scripts/backup.sh [options]
#     --mode snapshot|cold   snapshot (default, no downtime) or cold (stops the DB)
#     --out DIR              where the files go (default: $BACKUP_DIR, else ./backups)
#     --keep DAYS            delete older backups (default: $BACKUP_KEEP_DAYS, 14; 0 = keep all)
#     --verify               restore the fresh dump into a scratch dir and discard it
#     --no-aux               skip the /tls + files tarball
#     --cron "EXPR"          run forever, once per matching minute (5-field cron)
#     --once                 run one backup and exit (default)
#     --check-cron EXPR EPOCH  exit 0 if EXPR matches that unix time (used by the tests)
#     --quiet                only print the paths written
#
# ENVIRONMENT
#   BACKUP_DIR            output directory (in-container default /backups)
#   BACKUP_KEEP_DAYS      retention in days, default 14
#   BACKUP_COMPRESSION    zstd|gzip|brotli|none, default gzip
#   BACKUP_CRON           cron expression for --cron with no argument, default "17 3 * * *"
#   BACKUP_VERIFY         1 behaves like --verify
#   BACKUP_WORK_DIR       scratch directory for the snapshot copy (default <out>/.work)
#   PTD_DB_CONTAINER      database container name on the host, default ptd-db
#   PTD_APP_CONTAINER     app container name on the host, default ptd
#   PTD_DB_IMAGE          image used for host-side one-shot containers, default ptd-db:4.40.0
#   PTD_DATA_DIR          data directory inside a container, default /data
#   PTD_BACKUP_CONTEXT    force "container" or "host" instead of detecting it
set -eu
# No pathname expansion anywhere in this script: a cron expression is full of `*`,
# and `set -- $expr` would otherwise splat the current directory into the fields.
set -f

MODE="${BACKUP_MODE:-snapshot}"
OUT="${BACKUP_DIR:-}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
COMPRESSION="${BACKUP_COMPRESSION:-gzip}"
CRON=""
VERIFY="${BACKUP_VERIFY:-0}"
AUX=1
QUIET=0
DB_CONTAINER="${PTD_DB_CONTAINER:-ptd-db}"
APP_CONTAINER="${PTD_APP_CONTAINER:-ptd}"
DB_IMAGE="${PTD_DB_IMAGE:-ptd-db:4.40.0}"
DATA_DIR="${PTD_DATA_DIR:-/data}"

say() { [ "$QUIET" = "1" ] || echo "[backup] $*"; }
die() { echo "[backup] $*" >&2; exit 1; }

# ── cron ───────────────────────────────────────────────────────────────────
# A 5-field matcher: `*`, `*/n`, `a-b`, `a,b,c`, plain numbers. No names, no @daily,
# no ranges with steps — deliberately the subset a backup schedule needs, checkable
# with `--check-cron` so it is not a thing you find out about at 3 a.m.
field_matches() {
  field="$1"
  value="$2"
  IFS=','
  for part in $field; do
    unset IFS
    case "$part" in
      '*') return 0 ;;
      */*)
        step="${part#*/}"
        base="${part%/*}"
        [ "$base" = "*" ] || base="${base%%-*}"
        case "$step" in ''|*[!0-9]*) continue ;; esac
        [ "$step" -gt 0 ] || continue
        if [ "$base" = "*" ]; then
          [ $((value % step)) -eq 0 ] && return 0
        else
          [ "$value" -ge "$base" ] && [ $(((value - base) % step)) -eq 0 ] && return 0
        fi
        ;;
      *-*)
        lo="${part%-*}"
        hi="${part#*-}"
        case "$lo$hi" in ''|*[!0-9]*) continue ;; esac
        [ "$value" -ge "$lo" ] && [ "$value" -le "$hi" ] && return 0
        ;;
      *)
        case "$part" in ''|*[!0-9]*) continue ;; esac
        [ "$value" -eq "$part" ] && return 0
        ;;
    esac
    IFS=','
  done
  unset IFS
  return 1
}

cron_matches() {
  expr="$1"
  epoch="$2"
  # shellcheck disable=SC2086
  set -- $expr
  [ "$#" -eq 5 ] || die "cron needs five fields, got: $expr"
  minute=$(date -u -d "@$epoch" +%-M) || die "this date(1) cannot format an epoch"
  hour=$(date -u -d "@$epoch" +%-H)
  dom=$(date -u -d "@$epoch" +%-d)
  mon=$(date -u -d "@$epoch" +%-m)
  dow=$(date -u -d "@$epoch" +%w)
  field_matches "$1" "$minute" || return 1
  field_matches "$2" "$hour" || return 1
  field_matches "$4" "$mon" || return 1
  # cron's day-of-month / day-of-week rule: with both restricted, either one matching
  # is enough; with one restricted, that one decides.
  if [ "$3" = "*" ] && [ "$5" = "*" ]; then
    return 0
  elif [ "$3" = "*" ]; then
    field_matches "$5" "$dow"
  elif [ "$5" = "*" ]; then
    field_matches "$3" "$dom"
  else
    field_matches "$3" "$dom" || field_matches "$5" "$dow"
  fi
}

# ── arguments ──────────────────────────────────────────────────────────────
RUN="once"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:?--mode needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --keep) KEEP="${2:?--keep needs a value}"; shift 2 ;;
    --compression) COMPRESSION="${2:?--compression needs a value}"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    --no-aux) AUX=0; shift ;;
    --quiet) QUIET=1; shift ;;
    --once) RUN="once"; shift ;;
    --cron)
      RUN="cron"
      if [ "$#" -ge 2 ] && [ "${2#-}" = "$2" ]; then CRON="$2"; shift 2; else CRON="${BACKUP_CRON:-17 3 * * *}"; shift; fi
      ;;
    --check-cron)
      expr="${2:?--check-cron needs an expression}"
      when="${3:?--check-cron needs a unix time}"
      if cron_matches "$expr" "$when"; then echo "match"; exit 0; else echo "no match"; exit 1; fi
      ;;
    -h|--help) sed -n "2,52p" "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$MODE" in snapshot|cold) ;; *) die "--mode must be snapshot or cold" ;; esac

# ── where are we? ──────────────────────────────────────────────────────────
# Being inside a container is the thing to detect, and "/data exists" is not it: a
# host can easily have a /data of its own, and dumping *that* would produce a
# cheerful backup of nothing. /.dockerenv (or a container runtime in PID 1's cgroup)
# is the signal; PTD_BACKUP_CONTEXT overrides it for an exotic runtime.
in_container() {
  [ -f /.dockerenv ] && return 0
  grep -qE '(docker|containerd|kubepods|libpod)' /proc/1/cgroup 2>/dev/null && return 0
  return 1
}

CONTEXT="${PTD_BACKUP_CONTEXT:-}"
if [ -z "$CONTEXT" ]; then
  if in_container && [ -d "$DATA_DIR" ] && command -v heliosdb-nano >/dev/null 2>&1; then
    CONTEXT="container"
  else
    CONTEXT="host"
  fi
fi
if [ "$CONTEXT" = "container" ]; then
  [ -d "$DATA_DIR" ] || die "$DATA_DIR is not mounted — the backup sidecar needs the data volume"
  command -v heliosdb-nano >/dev/null 2>&1 || die "heliosdb-nano is not on PATH; run this in the ptd-db image"
  [ -n "$OUT" ] || OUT="/backups"
else
  command -v docker >/dev/null 2>&1 || die "docker is required to back up from the host (or run inside the ptd-db image)"
  [ -n "$OUT" ] || OUT="$(pwd)/backups"
fi
WORK="${BACKUP_WORK_DIR:-$OUT/.work}"

mkdir -p "$OUT" 2>/dev/null || die "cannot create $OUT"
# A named volume mounted at /backups that predates this image's own /backups directory
# is root-owned, and the engine runs as uid 999 — say so in one line rather than
# failing three commands later.
[ -w "$OUT" ] || die "$OUT is not writable by uid $(id -u). Rebuild the image (docker compose build ptd-db) so an empty volume inherits /backups, or chown the directory."

stamp() { date -u +%Y%m%dT%H%M%SZ; }

# ── one backup ─────────────────────────────────────────────────────────────
backup_once() {
  TS="$(stamp)"
  DUMP_NAME="ptd-$TS.heliodump"
  say "mode=$MODE context=$CONTEXT out=$OUT compression=$COMPRESSION"

  if [ "$CONTEXT" = "container" ]; then
    if [ "$MODE" = "cold" ]; then
      die "cold mode needs the docker CLI; run it on the host (the server must be stopped)"
    fi
    rm -rf "$WORK"
    mkdir -p "$WORK"
    cp -a "$DATA_DIR" "$WORK/data"
    heliosdb-nano dump -d "$WORK/data" -o "$OUT/$DUMP_NAME" --compression "$COMPRESSION" >"$WORK/dump.log" 2>&1 || {
      cat "$WORK/dump.log" >&2
      rm -rf "$WORK"
      die "dump failed"
    }
    grep -E '^  (Tables|Rows|Size)' "$WORK/dump.log" 2>/dev/null | while read -r line; do say "$line"; done || :
    rm -rf "$WORK/data"

    if [ "$VERIFY" = "1" ]; then
      rm -rf "$WORK/verify"
      heliosdb-nano restore -i "$OUT/$DUMP_NAME" -t "$WORK/verify" --verify >"$WORK/verify.log" 2>&1 || {
        cat "$WORK/verify.log" >&2
        die "the fresh dump did not verify — keeping it for inspection, but do not trust it"
      }
      say "verified:$(grep -E '^  Rows' "$WORK/verify.log" | tr -s ' ')"
      rm -rf "$WORK/verify"
    fi

    if [ "$AUX" = "1" ]; then
      AUX_PATHS=""
      if [ -d /tls ]; then AUX_PATHS="$AUX_PATHS tls"; fi
      if [ -d /files ]; then AUX_PATHS="$AUX_PATHS files"; fi
      if [ -n "$AUX_PATHS" ]; then
        # shellcheck disable=SC2086
        tar czf "$OUT/ptd-aux-$TS.tar.gz" -C / $AUX_PATHS
        say "wrote $OUT/ptd-aux-$TS.tar.gz ($(echo $AUX_PATHS | tr ' ' ','))"
      else
        say "no /tls or /files mounted — skipping the aux tarball"
      fi
    fi
    rm -rf "$WORK"
  else
    # Host: drive the containers.
    docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || die "no container named $DB_CONTAINER"
    REMOTE_WORK="/tmp/ptd-backup-$TS"

    if [ "$MODE" = "cold" ]; then
      say "stopping $DB_CONTAINER (cold dump)"
      docker stop "$DB_CONTAINER" >/dev/null
      # One-shot container on the same volumes: the server is down, so the real data
      # directory can be opened directly.
      docker run --rm --volumes-from "$DB_CONTAINER" -v "$OUT:/out" --entrypoint heliosdb-nano "$DB_IMAGE" \
        dump -d "$DATA_DIR" -o "/out/$DUMP_NAME" --compression "$COMPRESSION" || {
          docker start "$DB_CONTAINER" >/dev/null
          die "cold dump failed (database restarted)"
        }
      docker start "$DB_CONTAINER" >/dev/null
      say "$DB_CONTAINER restarted"
    else
      docker exec "$DB_CONTAINER" sh -c "
        set -e
        rm -rf '$REMOTE_WORK'; mkdir -p '$REMOTE_WORK'
        cp -a '$DATA_DIR' '$REMOTE_WORK/data'
        heliosdb-nano dump -d '$REMOTE_WORK/data' -o '$REMOTE_WORK/$DUMP_NAME' --compression '$COMPRESSION'
        rm -rf '$REMOTE_WORK/data'
      " | grep -E '^  (Tables|Rows|Size)|successfully' || true
      docker cp "$DB_CONTAINER:$REMOTE_WORK/$DUMP_NAME" "$OUT/$DUMP_NAME"
      docker exec "$DB_CONTAINER" rm -rf "$REMOTE_WORK"
    fi

    if [ "$VERIFY" = "1" ]; then
      docker run --rm -v "$OUT:/out" --entrypoint heliosdb-nano "$DB_IMAGE" \
        restore -i "/out/$DUMP_NAME" -t /tmp/verify --verify >/dev/null || die "the fresh dump did not verify"
      say "verified the dump by restoring it into a throwaway container"
    fi

    if [ "$AUX" = "1" ]; then
      if docker inspect "$APP_CONTAINER" >/dev/null 2>&1; then
        # The app container is where both /tls (read-only) and the attachment files
        # volume are mounted, so one --volumes-from covers the pair.
        docker run --rm --volumes-from "$APP_CONTAINER:ro" -v "$OUT:/out" --entrypoint sh "$DB_IMAGE" -c "
          set -e
          PATHS=''
          [ -d /tls ] && PATHS=\"\$PATHS tls\"
          [ -d /data/files ] && PATHS=\"\$PATHS data/files\"
          [ -n \"\$PATHS\" ] && tar czf '/out/ptd-aux-$TS.tar.gz' -C / \$PATHS || echo 'nothing to archive'
        "
        if [ -f "$OUT/ptd-aux-$TS.tar.gz" ]; then say "wrote $OUT/ptd-aux-$TS.tar.gz"; fi
      else
        say "no container named $APP_CONTAINER — skipping the aux tarball"
      fi
    fi
  fi

  [ -f "$OUT/$DUMP_NAME" ] || die "no dump was written"
  echo "$OUT/$DUMP_NAME"

  # ── retention ──
  case "$KEEP" in
    ''|*[!0-9]*) KEEP=0 ;;
  esac
  if [ "$KEEP" -gt 0 ]; then
    removed=0
    for f in $(find "$OUT" -maxdepth 1 -type f \( -name 'ptd-*.heliodump' -o -name 'ptd-aux-*.tar.gz' \) -mtime "+$KEEP" 2>/dev/null); do
      rm -f "$f"
      removed=$((removed + 1))
    done
    if [ "$removed" -gt 0 ]; then say "retention: removed $removed file(s) older than $KEEP day(s)"; fi
  fi
  return 0
}

if [ "$RUN" = "once" ]; then
  backup_once
  exit 0
fi

say "cron mode: \"$CRON\" (UTC), writing to $OUT"
last=""
while :; do
  now="$(date -u +%s)"
  minute_key="$(date -u -d "@$now" +%Y%m%d%H%M)"
  if [ "$minute_key" != "$last" ] && cron_matches "$CRON" "$now"; then
    last="$minute_key"
    backup_once || say "this run failed; the loop continues"
  fi
  # Wake up on the next minute boundary, not every 60 s from start, so a slow backup
  # cannot drift the schedule.
  sleep $((60 - $(date -u +%-S) % 60))
done
