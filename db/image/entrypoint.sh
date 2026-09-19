#!/bin/sh
# First start: self-signed EC certificate into /tls (shared read-only with the app so it can
# pin it). Every start: TLS + X25519MLKEM768 hybrid KEX, SCRAM-SHA-256 auth, HTTP/MCP listener
# off, and AES-256-GCM encryption at rest when DB_ENCRYPTION_KEY (64 hex chars) is set.
set -eu
: "${DB_PASSWORD:?DB_PASSWORD is required}"
TLS_DIR="${TLS_DIR:-/tls}"
if [ ! -s "$TLS_DIR/server.key" ] || [ ! -s "$TLS_DIR/server.crt" ]; then
  echo "[ptd-db] generating self-signed TLS certificate in $TLS_DIR"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.crt" -days 3650 \
    -subj "/CN=${TLS_CN:-ptd-db}" -addext "subjectAltName=DNS:${TLS_CN:-ptd-db},DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  chmod 0600 "$TLS_DIR/server.key"; chmod 0644 "$TLS_DIR/server.crt"
fi

CONFIG=/tmp/ptd-db.toml
if [ -n "${DB_ENCRYPTION_KEY:-}" ]; then
  case "$DB_ENCRYPTION_KEY" in
    *[!0-9a-fA-F]*|"") echo "[ptd-db] DB_ENCRYPTION_KEY must be 64 hex characters" >&2; exit 1 ;;
  esac
  [ ${#DB_ENCRYPTION_KEY} -eq 64 ] || { echo "[ptd-db] DB_ENCRYPTION_KEY must be 64 hex characters" >&2; exit 1; }
  export HELIOSDB_ENCRYPTION_KEY="$DB_ENCRYPTION_KEY"
  cat > "$CONFIG" <<TOML
[encryption]
enabled = true
algorithm = "Aes256Gcm"

[encryption.key_source]
Environment = "HELIOSDB_ENCRYPTION_KEY"
TOML
  echo "[ptd-db] encryption at rest: enabled (AES-256-GCM)"
else
  cat > "$CONFIG" <<TOML
[encryption]
enabled = false
TOML
  echo "[ptd-db] encryption at rest: DISABLED (set DB_ENCRYPTION_KEY to enable; cannot be enabled later on an existing volume)"
fi

exec heliosdb-nano start -c "$CONFIG" \
  --data-dir /data --listen 0.0.0.0 --port 5432 \
  --auth "${DB_AUTH:-scram-sha-256}" --password "$DB_PASSWORD" \
  --tls-cert "$TLS_DIR/server.crt" --tls-key "$TLS_DIR/server.key" --tls-post-quantum \
  --http-port 0 --authentication-timeout "${DB_AUTH_TIMEOUT:-30s}" \
  --max-connections "${DB_MAX_CONNECTIONS:-100}" "$@"
