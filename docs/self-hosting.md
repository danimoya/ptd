# Self-hosting

Self-hosting is free, forever, with no feature flags and no license key. There is
no billing code in the process at all unless `PTD_HOSTED=1` — see
[billing.md](billing.md).

## Requirements

- Docker with Compose v2 (`docker compose`, not `docker-compose`).
- A reverse proxy in front for TLS. PTD serves plain HTTP; it never terminates TLS
  itself.
- x86-64 or arm64. The database image builds for both.

## Quick start

```bash
git clone https://github.com/danimoya/ptd && cd ptd
cp .env.example .env
# set DB_PASSWORD, JWT_SECRET and PTD_SECRET_KEY, and decide about DB_ENCRYPTION_KEY now
docker compose up -d --build
```

The app listens on `http://localhost:3001`. Register the first account in the web
UI: the account that registers becomes the `owner` of a new organization.

Generating the three secrets:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -hex 32      # PTD_SECRET_KEY, and DB_ENCRYPTION_KEY (64 hex chars)
```

## What `docker compose up` starts

| Service | Image | Role |
|---|---|---|
| `ptd-db` | built from `db/image`, tagged `ptd-db:<NANO_VERSION>` | The database: HeliosDB-Nano, listening on 5432 inside the compose network only |
| `ptd` | built from the repo root, tagged `ptd:latest` | Node 24: API, MCP server, WebSocket and the built web client on 3001 |
| `ptd-backup` | the same `ptd-db` image | **Not started by default.** `docker compose --profile backup up -d ptd-backup` adds a nightly dump — see [Backups](#backups) |

Named volumes:

| Volume | Mounted at | Holds |
|---|---|---|
| `ptd_db_data` | `/data` in `ptd-db` | All application data |
| `ptd_db_tls` | `/tls` in `ptd-db`, read-only in `ptd` | The database's TLS key pair, so the app can pin the certificate |
| `ptd_files` | `/data/files` in `ptd`, read-only in `ptd-backup` | Attachment blobs (the rows that describe them are in the database) |
| `ptd_backups` | `/backups` in `ptd-backup` | Dumps and aux tarballs, only when the backup profile is running |

The network is a private bridge. The database publishes **no** host port, so it is
unreachable from outside the compose network; only `ptd` is published
(`${PTD_PORT:-3001}:3001`).

## Environment variables

Set in `.env`, which the `ptd` service reads through `env_file`. Only the first
three have to be set for a working deployment.

### Required

| Variable | Meaning |
|---|---|
| `DB_PASSWORD` | The database password, used for SCRAM-SHA-256 on both ends. Any long random string. Compose refuses to start without it |
| `JWT_SECRET` | Signs browser session tokens (7-day JWTs). Changing it logs everyone out. The process refuses to start in production without it |
| `PTD_SECRET_KEY` | AES-256-GCM key sealing third-party integration secrets at rest (Slack bot tokens, webhook secrets). 64 hex characters are used as the key directly; anything else is hashed to 32 bytes with SHA-256. Required in production |

### Database

| Variable | Default | Meaning |
|---|---|---|
| `DB_ENCRYPTION_KEY` | *(empty)* | 64 hex characters turns on AES-256-GCM **encryption at rest** inside the database. **Decide before the first start** — it cannot be enabled later on an existing data volume, and without the key the data is unreadable. Keep a copy somewhere other than the server |
| `NANO_VERSION` | `4.40.0` | The HeliosDB-Nano release the `ptd-db` image is built from |
| `DATABASE_URL` | set in `docker-compose.yml` | `postgres://postgres:<DB_PASSWORD>@ptd-db:5432/heliosdb`. Because compose sets it under `environment:`, it wins over `.env` — to point at your own database, edit the compose file or add an override file |
| `DATABASE_SSL` | `true` in compose | `true` turns TLS on for the database connection |
| `DATABASE_SSL_CA` | `/tls/server.crt` in compose | Path to the server certificate. With it, the certificate is verified; **without it TLS is still used but the certificate is not checked** |
| `DATABASE_SSL_SERVERNAME` | `ptd-db` | The name the certificate must match. Set it to `localhost` when you connect over a published port |
| `DB_AUTH` | `scram-sha-256` | Database authentication method |
| `DB_AUTH_TIMEOUT` | `30s` | How long the database waits for authentication to complete |
| `DB_MAX_CONNECTIONS` | `100` | Database connection ceiling. The app's own pool is 10 |
| `DB_DEBUG` | *(empty)* | Any value logs every SQL statement (truncated). Development only |

### Deployment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | Port the app listens on |
| `PTD_PORT` | `3001` | Host port compose publishes |
| `PTD_ENV_FILE` | `.env` | Alternate env file for the `ptd` service |
| `PTD_BASE_URL` | *(empty)* | Public origin of this deployment. Required behind a proxy: it builds the Slack redirect URI and the slash-command URL |
| `PTD_PUBLIC_URL` | *(empty)* | Public origin used for absolute URLs in action results (the iCal feed, billing return URLs) |
| `NODE_ENV` | `production` in the image | `development` runs Vite in-process; production serves the prebuilt client from `dist/public` |
| `PTD_HOSTED` | *(empty)* | `1` only on the hosted deployment: enables the free/paid plans and the Stripe webhook. Leave empty when self-hosting |
| `PTD_BODY_LIMIT` | `6mb` | Ceiling on a JSON or form request body. It has to clear the CSV importer's 5 MB file; attachment uploads have their own, larger limit |
| `PTD_SHUTDOWN_TIMEOUT_MS` | `8000` | How long SIGTERM waits for in-flight requests before closing anyway. The process exits within 10 s regardless |
| `PTD_CSP` | *(empty)* | Replaces the Content-Security-Policy wholesale. `off` removes the header — for debugging an embed, not as a deployment setting |
| `LOG_FORMAT` | *(empty)* | `json` emits one JSON object per line (`ts`, `level`, `source`, `msg`, `requestId`, `method`, `path`, `status`, `durationMs`); anything else keeps the human-readable line |
| `METRICS_TOKEN` | *(empty)* | Bearer token required by `GET /api/metrics`. **Set it if anything can reach the app through a proxy** — without it the endpoint is loopback-only, and a proxy connects from loopback |
| `PTD_VERSION` | `0.1.0` | What `/api/health?deep=1` reports as the running version |

### Optional integrations

| Variable | Meaning |
|---|---|
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | One Slack app per deployment. Without all three, the Org → Integrations tab says Slack is not configured on this server instead of offering a button that could only fail. See [integrations.md](integrations.md) |
| `SLACK_REDIRECT_URI` | Only if the URI registered with Slack is not `<PTD_BASE_URL>/api/integrations/slack/callback` |
| `SMTP_*` | Optional outgoing mail. Without `SMTP_HOST` nothing is mailed and links are returned by the API instead. The current list, with the meaning of each, is in `.env.example` |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Hosted plan only, and only read when `PTD_HOSTED=1`. See [billing.md](billing.md) |
| `SEED_PASSWORD` | Password for the demo accounts `npm run seed` creates. Development only |

## Security of the bundled database

All of this is in `db/image/entrypoint.sh` and `db/image/Dockerfile`; none of it
needs configuration.

- **The binary is verified.** The image downloads the official HeliosDB-Nano
  release for the build architecture together with its `SHA256SUMS` and checks the
  archive against it before installing. The process runs as an unprivileged user
  (uid 999), not root.
- **TLS with a post-quantum hybrid key exchange.** On first start the entrypoint
  generates a self-signed P-256 EC certificate into `/tls` (valid 3650 days, CN
  `ptd-db`, SANs `ptd-db`, `localhost`, `127.0.0.1`; the private key is written
  `0600`). The server starts with `--tls-post-quantum`, which offers the
  **X25519MLKEM768** hybrid group — HeliosDB-Nano ≥ 4.40 offers it and Node 24's
  OpenSSL 3.5 negotiates it, so the app-to-database connection is not recordable
  now for decryption later.
- **The certificate is pinned, not trusted blindly.** `/tls` is shared read-only
  with the app, which passes `server.crt` as its CA and requires the certificate to
  match `DATABASE_SSL_SERVERNAME`. A self-signed certificate is fine precisely
  because the app verifies *that* certificate and no other.
- **SCRAM-SHA-256 authentication.** The password is never sent, in any form, over
  the wire.
- **The database's HTTP/MCP listener is off** (`--http-port 0`). SQL over the
  pinned TLS socket is the only way in, and that socket is not published to the
  host.
- **Encryption at rest is available and opt-in.** Set `DB_ENCRYPTION_KEY` to 64
  hex characters *before the first start* and the entrypoint writes an
  `[encryption] enabled = true, algorithm = "Aes256Gcm"` configuration and passes
  the key through the environment. With the variable empty, the entrypoint says so
  explicitly on stdout, including that it cannot be turned on later for an
  existing volume.

## Using stock Postgres instead

The application speaks the Postgres wire protocol through `postgres.js`, and the
migrations in `drizzle/` are deliberately plain SQL applied one statement at a
time — no dollar-quoting, no extensions — so they run on either engine.

To use your own Postgres: point `DATABASE_URL` at it, drop the `ptd-db` service
and the `/tls` mount from your compose file, and set `DATABASE_SSL` according to
what your server offers. You then own the TLS, authentication, at-rest encryption
and backups that the bundled image otherwise handles.

## Upgrading

```bash
git pull
docker compose up -d --build
```

**Migrations run on start.** The container's command is
`node dist/db/migrate.js && node dist/server/index.js`: the migrator applies each
file in `drizzle/` in filename order exactly once, recording what it applied in a
`_migrations` table, and the server does not start if a migration fails. Running it
twice is a no-op, so restarts are safe.

To move the database to a newer HeliosDB-Nano, bump `NANO_VERSION` in `.env` and
rebuild. Take a backup first (below) and read the engine's own release notes — a
data-volume format change is the engine's business, not PTD's.

## Backups

> **Encrypted stores.** When `DB_ENCRYPTION_KEY` is set, `heliosdb-nano dump` cannot open the data directory offline (HeliosDB-Nano issue #45), so `backup.sh` switches to `--mode raw`: it archives a crash-consistent copy of the data directory as `ptd-<stamp>.rocksdb.tgz` (+ `.sha256`). The archive stays encrypted at rest; restore it with `restore.sh --input <file>.rocksdb.tgz` and the **same** `DB_ENCRYPTION_KEY`. `--verify` checks archive integrity and the RocksDB manifest.


`scripts/backup.sh` writes two files per run into a backup directory:

| File | What it is |
|---|---|
| `ptd-<timestamp>.heliodump` | A HeliosDB-Nano dump of the whole database: 33 tables, every row, self-describing and verifiable |
| `ptd-aux-<timestamp>.tar.gz` | `/tls` (the pinned key pair) and the `ptd_files` volume (attachment blobs) — the two things the dump does not contain |

Run one now, from the repo root, with the stack up:

```bash
scripts/backup.sh --out ./backups --keep 14 --verify
```

It prints the path it wrote and the dump's own summary (tables, rows, compressed
size). `--verify` restores the fresh dump into a throwaway directory before declaring
success; it costs a few seconds per 100k rows and is the difference between "a file
exists" and "a backup exists".

### Nightly, without a cron entry on the host

```bash
docker compose --profile backup up -d ptd-backup
docker compose logs -f ptd-backup
```

That starts a sidecar from the **same `ptd-db` image**, so the dump is written by
exactly the engine that wrote the data. It mounts the data volume read-only, keeps
its own `ptd_backups` volume for output, and runs one backup per minute that matches
`BACKUP_CRON` (default `17 3 * * *`, UTC). Nothing is stopped and nothing is written
to `/data`.

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_CRON` | `17 3 * * *` | 5-field cron, UTC. `*`, `*/n`, `a-b`, `a,b` and plain numbers; no names, no `@daily`. Check an expression with `scripts/backup.sh --check-cron "<expr>" "$(date -u +%s)"` |
| `BACKUP_KEEP_DAYS` | `14` | Delete `ptd-*.heliodump` / `ptd-aux-*.tar.gz` older than this. `0` keeps everything |
| `BACKUP_COMPRESSION` | `gzip` | Codec inside the dump: `zstd` (smallest), `gzip`, `brotli`, `none` |
| `BACKUP_VERIFY` | `0` | `1` verifies every dump by restoring it into a scratch directory |
| `BACKUP_DIR` | `/backups` in the sidecar, `./backups` on the host | Where the files go |

Copy the `ptd_backups` volume off the machine on your own schedule — a backup that
lives on the disk it is protecting is not a backup:

```bash
docker run --rm -v ptd_ptd_backups:/b:ro -v "$PWD":/out alpine \
  tar cf /out/ptd-backups.tar -C /b .
```

### Why the dump is taken from a copy

HeliosDB-Nano 4.40 has no online dump, and the three ways you might expect to get one
all say so out loud:

- `heliosdb-nano dump --connection postgres://…` → `Server mode dump not yet implemented. Use --data-dir for embedded mode.`
- `heliosdb-nano dump --data-dir /data` against the running server → `Failed to open RocksDB: IO error: While lock file: /data/LOCK: Resource temporarily unavailable`
- `heliosdb-nano start --dump-schedule "0 */6 * * *"` → the server refuses at startup: `dump-schedule is not implemented yet; use OS cron with "heliosdb-nano dump"`

So the script does what that last message asks for, with one extra step: it copies the
data directory (`cp -a`), dumps the **copy**, and deletes the copy. RocksDB files are
written once and replaced rather than edited, so the copy is a crash-consistent
snapshot — the same state the engine would recover from after a power cut, which is a
state it is built to handle. It needs free space equal to the data directory for the
duration of the copy.

Two consequences worth knowing:

- A dump can be a fraction of a second behind the live database. For a work tracker
  that is a non-issue; if it ever is one for you, use the cold mode below.
- A snapshot taken while the engine happens to be compacting could in principle be
  incomplete. That shows up as a **failed dump**, not a silent one — and `--verify`
  (or `BACKUP_VERIFY=1`) restores every dump before declaring it good, so the failure
  is found at backup time.

Before an engine upgrade, or any time you want the guarantee rather than the
argument, take a cold dump. It stops the database container, dumps the real directory
and starts it again — a few seconds of downtime:

```bash
scripts/backup.sh --mode cold --out ./backups --verify
```

## Restoring

`scripts/restore.sh` refuses to do anything without `--yes`, and prints the two
commands you might have meant.

### Rehearse it first (nothing is touched)

```bash
scripts/restore.sh --input ./backups/ptd-20260920T191643Z.heliodump --scratch --yes
```

That restores the dump into a **new** volume, starts a throwaway HeliosDB-Nano
container on `127.0.0.1:5499`, and prints how to connect and how to delete it. Then
count what came back:

```bash
NAME=ptd-restore-test-…          # the script prints the name
docker cp $NAME:/tls/server.crt /tmp/$NAME.crt
export DATABASE_URL=postgres://postgres:scratch@127.0.0.1:5499/heliosdb \
       DATABASE_SSL=true DATABASE_SSL_CA=/tmp/$NAME.crt DATABASE_SSL_SERVERNAME=localhost
node -e "…"                       # or psql, or any Postgres client
docker rm -f $NAME && docker volume rm ptd_restore_test_… ptd_restore_test_tls_…
```

The row counts must match the live database, table for table. That is the whole test,
and it is worth running after any change to the backup arrangement — a backup nobody
has restored is a hypothesis.

### The real thing

```bash
scripts/restore.sh --input ./backups/ptd-<timestamp>.heliodump \
                   --aux ./backups/ptd-aux-<timestamp>.tar.gz \
                   --replace --yes
```

It stops `ptd` and `ptd-db`, empties the data volume, restores the dump with
`--verify`, unpacks the aux archive over `/tls` and the files volume, and starts both
containers again. Everything written after the backup is gone — that is what
`--replace` is acknowledging. The app runs its migrations on start, so a dump taken
against an older schema catches up by itself.

If the dump was taken from a database whose rows violate a constraint it carries (a
`NOT ENFORCED` constraint, or `helios.fk_validation = 'audit'`), the engine's restore
needs `--no-validate`; run `heliosdb-nano restore` by hand in that case, the script
does not offer the flag.

### Volume-level backups still work

The older recipe — stop the app, tar the volumes — is still valid and is the fastest
way to clone a whole deployment:

```bash
docker compose stop ptd            # stop writers first
docker run --rm \
  -v ptd_ptd_db_data:/data:ro -v ptd_ptd_db_tls:/tls:ro \
  -v "$PWD":/backup alpine \
  tar czf /backup/ptd-$(date +%F).tar.gz -C / data tls
docker compose start ptd
```

Restore into empty volumes with the same two mounts and `tar xzf … -C /`. Volume names
are prefixed with the compose project name — `ptd_ptd_db_data` for a project called
`ptd`. Check with `docker volume ls`.

Back up `.env` too, separately and encrypted. Losing `DB_ENCRYPTION_KEY` means losing
the data; losing `PTD_SECRET_KEY` means every stored integration secret has to be
re-entered.

## Reverse proxy

PTD sets `trust proxy` for exactly one hop, so `X-Forwarded-For` and
`X-Forwarded-Proto` from your proxy are honored — client IPs reach the rate
limiter and generated absolute URLs use `https`.

Requirements:

- Forward `Host`, `X-Forwarded-Proto` and `X-Forwarded-For`.
- Forward `X-Request-Id` if your proxy assigns one — PTD echoes it and logs it, so
  one identifier ties an access-log line to the application's own line. It only
  accepts a short printable id (`[A-Za-z0-9._:-]`, ≤ 128 chars) and generates a UUID
  otherwise.
- **Do not expose `/api/metrics`.** Either block it at the proxy or set
  `METRICS_TOKEN`: adding `X-Forwarded-For` is what makes the endpoint's own
  loopback-only rule refuse the request, so an unblocked, tokenless proxy pass gets
  403 rather than data — but a token is the arrangement to rely on.
- **Allow WebSocket upgrades**: the Track surface pushes timer and dashboard
  updates over a WebSocket on the same origin.
- Do not buffer or rewrite `POST /mcp`; MCP clients use streamable HTTP.
- Set `PTD_BASE_URL` (and `PTD_PUBLIC_URL`) to the public origin, or Slack
  redirects and calendar URLs will be built from the internal hostname.

nginx, in outline:

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;  # "upgrade" when $http_upgrade is set
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## HTTP hardening

Set on every response, with no configuration:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| `X-Frame-Options` | `DENY` (and `frame-ancestors 'none'` in the CSP) |
| `X-Request-Id` | the inbound id, or a fresh UUID |

The Content-Security-Policy in production:

```
default-src 'self'; script-src 'self' blob:;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:;
connect-src 'self' ws: wss:; worker-src 'self' blob:; manifest-src 'self';
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

`style-src 'unsafe-inline'` is there because the SPA computes inline styles (the Gantt
bars, and every React `style` prop) and because the Google Fonts stylesheet is a
cross-origin `<link>`; `blob:` is there because CSV and PDF downloads are built in the
browser with `createObjectURL`. Script `'unsafe-inline'` and `'unsafe-eval'` are added
**only** when `NODE_ENV=development`, where Vite injects an inline module script and
compiles with `eval`. If you serve the client from another origin or embed a
third-party widget, replace the policy with `PTD_CSP` rather than loosening this one.

Also applied:

- **Body limits**: `PTD_BODY_LIMIT` (6 MB) for JSON and form bodies, answered as 413
  when exceeded. Signed webhook payloads have their own 256 KB raw-body layer;
  attachment uploads their own larger one.
- **Rate limits**: 300/min per IP across `/api`, 20 per 15 min on the auth endpoints,
  60/min on `POST /oauth/token` and `POST /oauth/register` (registration additionally
  keeps its 10/min), and health and metrics outside all of them.
- **CORS**: `/mcp`, `/.well-known/*`, `/llms.txt` and `/api/agent/discovery` answer
  the preflight and expose `WWW-Authenticate`, which is how a browser-based MCP client
  discovers it needs a token. Nothing else is cross-origin.

## Health check

Two depths, both unauthenticated and both outside the `/api` rate limiter.

```bash
curl -s localhost:3001/api/health
{"status":"ok","uptimeSeconds":10.633}

curl -s "localhost:3001/api/health?deep=1"
{"status":"ok","uptimeSeconds":16.341,"instance":"dm26","version":"0.1.0",
 "database":{"ok":true,"latencyMs":35,"migrations":4,"connections":2}}
```

- **`/api/health`** answers as soon as the HTTP server is up and never touches the
  database — which is the point: a database blip must not make Docker kill a process
  that is serving the web client perfectly well. The image's own `HEALTHCHECK` polls
  this one every 30 s with a 20 s start period and 3 retries.
- **`?deep=1`** runs `SELECT 1`, counts the applied migrations and reports the
  database's own connection count, and answers **503** with `status: "degraded"` when
  the database does not answer. That is the readiness check to put in front of several
  replicas. The result is cached for 5 s, so polling it hard costs one query per 5 s.
- During a graceful shutdown both answer **503** with `{"status":"draining"}`, so a
  load balancer stops sending work before the process disappears.

## Metrics and logs

`GET /api/metrics` serves Prometheus text format (`version=0.0.4`) — process,
HTTP, action, database-pool and WebSocket series:

```
ptd_http_requests_total{method="POST",route="/api/actions/:name",status="200"} 214
ptd_http_request_duration_seconds_bucket{le="0.25",method="GET",route="/api/tasks/query"} 61
ptd_action_calls_total{action="task.create",outcome="ok",surface="mcp"} 7
ptd_db_pool_max 10
ptd_db_server_connections 2
ptd_db_up 1
ptd_websocket_clients 3
nodejs_eventloop_lag_seconds{quantile="0.99"} 0.010314
process_resident_memory_bytes 2.11e+08
```

Who may scrape it:

- **`METRICS_TOKEN` set** → `Authorization: Bearer <token>` is required. Use this
  whenever the app is reachable through a proxy.
- **`METRICS_TOKEN` empty** → loopback only, and a request carrying
  `X-Forwarded-For` is refused outright, because a proxy on the same host would
  otherwise hand the endpoint to everyone. The socket address decides, not `req.ip`:
  a header can never open this endpoint.

Route labels are the Express route *pattern* (`/api/tasks/:id`), and anything
unmatched has its ids, UUIDs, hex digests and `ptd_` tokens replaced with
placeholders, so a scrape cannot grow without bound. Each metric also has a hard cap
of 500 label sets; overflow is counted in `ptd_metrics_series_dropped_total` rather
than hidden.

Every response carries `X-Request-Id` — the inbound one if your proxy set it (and it
looks like an id), otherwise a fresh UUID — and every `/api` log line carries the
same value. With `LOG_FORMAT=json`:

```json
{"ts":"2026-09-20T19:15:35.438Z","level":"info","source":"express","msg":"request",
 "requestId":"34be1a74-a7ca-4b57-9c69-dcc52cd46119","method":"POST",
 "path":"/api/auth/login","status":200,"durationMs":255}
```

## Restarts and rolling updates

On `SIGTERM` (what `docker stop` and `docker compose up -d` send) the process:

1. starts answering `/api/health` with 503 `draining`, and stops reusing connections
   (`Connection: close` on every response);
2. closes the listener — new connections are refused — and drops idle keep-alive
   sockets;
3. waits for in-flight requests, up to `PTD_SHUTDOWN_TIMEOUT_MS` (8 s);
4. drops WebSocket connections (an upgraded socket is not an idle one; clients
   reconnect);
5. closes the database pool and exits 0 — within 10 s in every case.

`docker stop` gives 10 s by default before SIGKILL; if you raise
`PTD_SHUTDOWN_TIMEOUT_MS`, raise `stop_grace_period` in compose to match.

## Running more than one app replica

Since the phase that made this list, PTD keeps in the database everything that two
replicas have to agree about. Point several `ptd` containers at one `ptd-db` and put
your proxy in front of them.

**Safe across replicas:**

- **Chat link codes** (`link_codes`). A code minted by the replica that served the web
  request is spent by whichever replica receives the Slack, Telegram or Teams
  webhook. Spending is one guarded `UPDATE … WHERE used_at IS NULL RETURNING`, so two
  replicas racing the same code produce exactly one winner; the loser is told the code
  is not valid. The row also counts attempts.
- **The Telegram `/org` choice** (`chat_identities.org_id`). Set on one replica, read
  by all of them, and it survives a restart.
- **AI usage** (`ai_usage`, one row per provider call). `ai.usage` reports the
  organization's real totals — by day, by member, by model, by action — whichever
  replica answers. Each process also keeps the last 500 calls it made itself, reported
  separately as `thisProcess`.
- **Import history** (`import_runs`). `import.history` shows every replica's runs.
- **Stripe webhooks.** The handlers are idempotent, so a redelivery to another replica
  is harmless.
- **OAuth codes and tokens, sessions, API tokens.** All rows, always were.

**Per replica — know what you are getting:**

- **WebSocket fan-out.** A client is connected to *one* replica, and
  `notifyTimerUpdate` and friends only reach the clients of that replica. The running
  timer also refetches every 60 s (`TimerPage`), so the effect is a slower update
  rather than a wrong one, but a push another replica produced is simply not delivered.
  A shared bus (or sticky sessions with per-organization affinity) would be the fix;
  PTD does not ship one.
- **Slack budget alerts.** The "alerted in the last 12 hours" cooldown is per process,
  so a stream over budget can be announced once per replica per window. Making it
  durable would mean a write on every event fan-out to spare Slack a duplicate line.
- **Failed link-code attempts.** The ten-tries-then-cool-off counter is per replica,
  which means ten tries per replica. Against a 32^6 keyspace and a ten-minute TTL that
  is not a weakening worth a table.
- **SSO sign-in state.** `server/oidc/state.ts` keeps the pending authorization
  request and the one-time hand-off code in memory, so a provider callback that lands
  on a different replica than the one that started the sign-in cannot be completed.
  Give `/api/auth/oidc/*` sticky sessions (or accept that an SSO attempt occasionally
  has to be retried); password sign-in is unaffected.
- **The iCal URL cache.** `ical.url` reuses a link only if *this* process minted it;
  another replica rotates the token and says so (`rotated: 1`). Unchanged by
  multi-replica, but more visible with it.
- **The recurrence scheduler.** Every replica runs it every 60 s. The work is
  idempotent (it looks for cards due to be created and creates the missing ones), but
  two replicas can race on the same card; run the scheduler on one replica only if
  that matters to you.
- **Metrics.** Each replica exposes its own; scrape them all and aggregate in
  Prometheus. `ptd_build_info` and the WebSocket gauges are per instance by nature.

## Demo data

```bash
npm install
export DATABASE_URL=… JWT_SECRET=dev PTD_SECRET_KEY=dev
npm run migrate && npm run seed
```

`npm run seed` creates the "Atelier 14" organization: four humans, two agent seats
with printed tokens, three apps, four streams (one crossing several apps), 18 tasks
with dependencies and priority inputs, and a week of human and agent time entries
with token and cost figures. It is idempotent — it does nothing if the
organization already exists — and it prints the agent tokens exactly once.
