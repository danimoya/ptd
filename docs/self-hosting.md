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

Two named volumes:

| Volume | Mounted at | Holds |
|---|---|---|
| `ptd_db_data` | `/data` in `ptd-db` | All application data |
| `ptd_db_tls` | `/tls` in `ptd-db`, read-only in `ptd` | The database's TLS key pair, so the app can pin the certificate |

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

Everything that matters is in the two named volumes. `ptd_db_data` is the data;
`ptd_db_tls` is a key pair you can regenerate, but restoring it saves you from
having to reconfigure the pinned certificate.

```bash
docker compose stop ptd            # stop writers first
docker run --rm \
  -v ptd_ptd_db_data:/data:ro -v ptd_ptd_db_tls:/tls:ro \
  -v "$PWD":/backup alpine \
  tar czf /backup/ptd-$(date +%F).tar.gz -C / data tls
docker compose start ptd
```

Restore into empty volumes with the same two mounts and `tar xzf … -C /`.

Volume names are prefixed with the compose project name — `ptd_ptd_db_data` for a
project called `ptd`. Check with `docker volume ls`.

Back up `.env` too, separately and encrypted. Losing `DB_ENCRYPTION_KEY` means
losing the data; losing `PTD_SECRET_KEY` means every stored integration secret has
to be re-entered.

## Reverse proxy

PTD sets `trust proxy` for exactly one hop, so `X-Forwarded-For` and
`X-Forwarded-Proto` from your proxy are honored — client IPs reach the rate
limiter and generated absolute URLs use `https`.

Requirements:

- Forward `Host`, `X-Forwarded-Proto` and `X-Forwarded-For`.
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

## Health check

`GET /api/health` → `{"status":"ok"}`, unauthenticated and unrated. The image's
own `HEALTHCHECK` polls it every 30 s with a 20 s start period and 3 retries, so
`docker ps` reports `healthy` only once the process is actually serving. Point your
external monitor at the same URL.

It answers as soon as the HTTP server is up; it does not prove the database is
reachable. For that, watch the logs on start (the migrator fails loudly) or call an
authenticated action.

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
