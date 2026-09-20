#!/bin/sh
# PTD restore — put a `.heliodump` back, either over the live database or into a
# scratch instance you can poke at first.
#
# READ THIS FIRST. A restore over the live volume is destructive: the target data
# directory is emptied and rebuilt from the dump, so anything written after the
# backup is gone. The script therefore refuses to do anything without `--yes`, and
# refuses to overwrite a non-empty data volume without `--replace` on top of that.
#
# The safe rehearsal is `--scratch`: it restores into a brand-new volume, starts a
# throwaway HeliosDB-Nano container on a loopback port, and prints how to query it and
# how to delete it. Do that after changing anything about your backups, and do it
# before you ever need the real thing. docs/self-hosting.md walks through it.
#
# USAGE
#   scripts/restore.sh --input FILE --yes [options]
#     --input FILE        the dump to restore (a file on this host)
#     --yes               required; without it nothing happens
#     --scratch           restore into a new volume + throwaway container (non-destructive)
#     --replace           allow emptying a non-empty target data volume (live restore)
#     --port N            loopback port for the scratch container (default 5499)
#     --volume NAME       target data volume (default: the volume ptd-db has at /data)
#     --aux FILE          also unpack a ptd-aux-*.tar.gz into /tls and the files volume
#     --app NAME          app container to stop and start again (default ptd)
#     --db NAME           database container (default ptd-db)
#     --keep-down         do not start the containers again afterwards
#
# ENVIRONMENT
#   PTD_DB_IMAGE          image for the one-shot restore container (default ptd-db:4.40.0)
#   DB_PASSWORD           password for the scratch container (default "scratch")
set -eu

INPUT=""
AUX=""
YES=0
SCRATCH=0
REPLACE=0
PORT=5499
VOLUME=""
APP_CONTAINER="${PTD_APP_CONTAINER:-ptd}"
DB_CONTAINER="${PTD_DB_CONTAINER:-ptd-db}"
DB_IMAGE="${PTD_DB_IMAGE:-ptd-db:4.40.0}"
KEEP_DOWN=0

say() { echo "[restore] $*"; }
die() { echo "[restore] $*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) INPUT="${2:?--input needs a path}"; shift 2 ;;
    --aux) AUX="${2:?--aux needs a path}"; shift 2 ;;
    --yes) YES=1; shift ;;
    --scratch) SCRATCH=1; shift ;;
    --replace) REPLACE=1; shift ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --volume) VOLUME="${2:?--volume needs a name}"; shift 2 ;;
    --app) APP_CONTAINER="${2:?--app needs a name}"; shift 2 ;;
    --db) DB_CONTAINER="${2:?--db needs a name}"; shift 2 ;;
    --keep-down) KEEP_DOWN=1; shift ;;
    -h|--help) sed -n "2,30p" "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ -n "$INPUT" ] || die "--input FILE is required"
[ -f "$INPUT" ] || die "no such file: $INPUT"
command -v docker >/dev/null 2>&1 || die "docker is required"

if [ "$YES" != "1" ]; then
  cat >&2 <<EOF
[restore] refusing to run without --yes.

  Rehearsal (safe, nothing is touched):
    scripts/restore.sh --input $INPUT --scratch --yes

  Over the live database (DESTRUCTIVE — everything written since the backup is lost):
    scripts/restore.sh --input $INPUT --replace --yes
EOF
  exit 2
fi

DIR="$(cd "$(dirname "$INPUT")" && pwd)"
FILE="$(basename "$INPUT")"

# ── scratch: a throwaway instance to check a backup is really restorable ────
if [ "$SCRATCH" = "1" ]; then
  TS="$(date -u +%Y%m%d%H%M%S)"
  SVOL="ptd_restore_test_$TS"
  STLS="ptd_restore_test_tls_$TS"
  SNAME="ptd-restore-test-$TS"
  say "restoring $FILE into the new volume $SVOL"
  docker run --rm -v "$SVOL:/data" -v "$DIR:/in:ro" --entrypoint heliosdb-nano "$DB_IMAGE" \
    restore -i "/in/$FILE" -t /data --verify
  say "starting $SNAME on 127.0.0.1:$PORT"
  docker run -d --name "$SNAME" -e "DB_PASSWORD=${DB_PASSWORD:-scratch}" \
    -v "$SVOL:/data" -v "$STLS:/tls" -p "127.0.0.1:$PORT:5432" "$DB_IMAGE" >/dev/null
  sleep 4
  cat <<EOF
[restore] scratch instance up.

  Certificate:  docker cp $SNAME:/tls/server.crt /tmp/$SNAME.crt
  Connect:      DATABASE_URL=postgres://postgres:${DB_PASSWORD:-scratch}@127.0.0.1:$PORT/heliosdb \\
                DATABASE_SSL=true DATABASE_SSL_CA=/tmp/$SNAME.crt DATABASE_SSL_SERVERNAME=localhost
  Row counts:   docker logs $SNAME | tail -3   (and query it with any Postgres client)
  Throw away:   docker rm -f $SNAME && docker volume rm $SVOL $STLS
EOF
  exit 0
fi

# ── live restore ───────────────────────────────────────────────────────────
if [ -z "$VOLUME" ]; then
  VOLUME="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$DB_CONTAINER" 2>/dev/null || true)"
  [ -n "$VOLUME" ] || die "could not work out the data volume of $DB_CONTAINER — pass --volume"
fi
say "target volume: $VOLUME"

NONEMPTY="$(docker run --rm -v "$VOLUME:/data" --entrypoint sh "$DB_IMAGE" -c 'ls -A /data 2>/dev/null | head -1')"
if [ -n "$NONEMPTY" ] && [ "$REPLACE" != "1" ]; then
  die "$VOLUME already holds a database. Re-run with --replace to empty it first (this is irreversible)."
fi

for c in "$APP_CONTAINER" "$DB_CONTAINER"; do
  if docker inspect "$c" >/dev/null 2>&1; then
    say "stopping $c"
    docker stop "$c" >/dev/null || true
  fi
done

if [ -n "$NONEMPTY" ]; then
  say "emptying $VOLUME"
  docker run --rm -v "$VOLUME:/data" --entrypoint sh "$DB_IMAGE" -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; true'
fi

say "restoring $FILE"
docker run --rm -v "$VOLUME:/data" -v "$DIR:/in:ro" --entrypoint heliosdb-nano "$DB_IMAGE" \
  restore -i "/in/$FILE" -t /data --verify

if [ -n "$AUX" ]; then
  [ -f "$AUX" ] || die "no such aux archive: $AUX"
  AUX_DIR="$(cd "$(dirname "$AUX")" && pwd)"
  AUX_FILE="$(basename "$AUX")"
  say "unpacking $AUX_FILE (TLS key pair and attachment files)"
  docker run --rm --volumes-from "$APP_CONTAINER" -v "$AUX_DIR:/in:ro" --entrypoint sh "$DB_IMAGE" -c \
    "tar xzf '/in/$AUX_FILE' -C /"
fi

if [ "$KEEP_DOWN" = "1" ]; then
  say "containers left stopped (--keep-down). Start them with: docker start $DB_CONTAINER $APP_CONTAINER"
  exit 0
fi

for c in "$DB_CONTAINER" "$APP_CONTAINER"; do
  if docker inspect "$c" >/dev/null 2>&1; then
    say "starting $c"
    docker start "$c" >/dev/null || die "could not start $c"
  fi
done

say "done. The app runs its migrations on start, so a dump from an older schema catches up by itself."
say "Check: curl -s localhost:3001/api/health?deep=1"
