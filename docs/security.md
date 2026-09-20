# Security

What PTD does by default, what it expects from you, and what it deliberately does
not try to do.

## Credentials

| Kind | Stored as | Lifetime |
|---|---|---|
| Password | bcrypt, cost 12 | Until changed |
| Session token | JWT signed with `JWT_SECRET` | 7 days |
| API token (`ptd_…`) | scrypt hash (64-byte key, per-token 16-byte salt) | Until revoked, or its optional expiry |
| OAuth authorization code / refresh token | Hashed, single-use code | Short-lived code, revocable refresh token |

An API token is `ptd_` + an 8-character hex **prefix** + a 32-character hex
**secret**. Only the prefix is stored in the clear — it is what the lookup is keyed
on — and the secret is compared against its scrypt hash in constant time. So:

- A token's secret is shown **exactly once**, when it is minted. It cannot be read
  back out of the database, by anyone, including whoever has the database.
- A leaked token is revoked, not recovered: `DELETE /api/tokens/:id`, or
  `POST /api/tokens/rotate` to replace every one of yours in an organization at once.
- Each token is bound to one user *and* one organization.
- `lastUsedAt` is recorded at most once a minute per token — a liveness signal, not
  an audit log. The audit log is `task.history`.

Rotate `JWT_SECRET` to invalidate every browser session at once. API tokens are
unaffected by that, since they are not JWTs.

## Transport

**App ↔ database** (with the bundled `ptd-db` image, no configuration needed):

- TLS with the **X25519MLKEM768** post-quantum hybrid key exchange, so a recorded
  session is not decryptable later by an attacker who acquires a quantum computer.
- The server certificate is **pinned**: it is shared read-only through the `/tls`
  volume and passed to the client as its CA, with the hostname checked. Self-signed
  is fine precisely because exactly one certificate is accepted.
- **SCRAM-SHA-256** authentication — the password never crosses the wire in any form.
- The database's HTTP/MCP listener is off, and its port is not published to the host.

Without `DATABASE_SSL_CA` the connection still uses TLS but does **not** verify the
certificate. That is a deliberate escape hatch for a managed database whose CA you
do not have; it is not the default, and it is worth fixing rather than living with.

**Browser ↔ app**: PTD serves plain HTTP and expects your reverse proxy to
terminate TLS. Add HSTS there. See
[self-hosting.md](self-hosting.md#reverse-proxy).

## Secrets at rest

| What | How |
|---|---|
| Database rows | AES-256-GCM, when `DB_ENCRYPTION_KEY` is set **before the first start**. It cannot be turned on later on an existing volume, and without the key the data is unreadable |
| Third-party integration secrets (Slack bot tokens, webhook signing secrets) | AES-256-GCM under `PTD_SECRET_KEY`, sealed as `v1.<iv>.<ciphertext>.<tag>` |
| Passwords, API tokens | One-way hashes (above) — not encryption, and not reversible |

A 256-bit symmetric key keeps a 128-bit security margin against a quantum attacker
(Grover halves it), which is why AES-256-GCM is what holds the third-party secrets.

Keep `.env` out of version control and back it up encrypted, separately from the
data. Losing `DB_ENCRYPTION_KEY` loses the data; losing `PTD_SECRET_KEY` means every
stored integration secret must be re-entered.

## Authorization

- **Every action declares its minimum role, and the registry checks it before the
  handler runs.** No adapter — REST, MCP, Slack, the CLI, the web client — has a
  path around it, and none has a privilege the others lack.
- **Every query is filtered by the organization resolved from the request**, never by
  an id the caller supplied. A credential for one organization cannot read another by
  passing its ids.
- **A missing id and another organization's id both answer `404`.** The endpoint
  cannot be used to probe which ids exist elsewhere.
- **An MCP session is built per request** and registers only the tools the caller's
  role allows, so an agent never sees a tool it would be refused for.
- Two rules are finer-grained than roles: a `member` may complete only a task
  assigned to themselves, and may correct or delete only their own ledger lines.

## Attribution integrity

The human-vs-agent record is the product's core claim, so it is enforced structurally
rather than by convention: `entry_source` comes from the credential, no input schema
accepts it, tokens and cost are stored only for agent sources, and `time_entry.update`
cannot touch any of those four columns. Full reasoning in
[concepts.md](concepts.md#attribution-human-or-agent).

## Webhook and Slack signatures

Outgoing webhooks are signed `X-PTD-Signature: sha256=<hex HMAC-SHA256 of the raw
body>`. Verify over the **raw** bytes and compare in constant time — see
[integrations.md](integrations.md#verifying-the-signature).

Incoming Slack requests are verified as Slack v0 signatures over
`v0:<timestamp>:<raw body>`, in constant time, with a five-minute replay window.
Stripe's webhook is verified the same way against `STRIPE_WEBHOOK_SECRET`. In all
three cases the raw body is captured before any JSON parser sees it, because a
re-serialized body does not match.

## Rate limits

| Scope | Limit |
|---|---|
| Everything under `/api` | 300 requests/minute |
| `/api/auth/*`, `POST /api/agent/register` | 20 per 15 minutes |
| OAuth client registration, CSV upload | 10/minute |

Limits are per client IP, and PTD trusts exactly **one** proxy hop. Two chained
proxies, or a misconfigured one, will make every request appear to come from the same
address and turn the auth limiter into an outage. Put one reverse proxy in front.

## The public surface

Unauthenticated endpoints, on purpose:

| Endpoint | Why |
|---|---|
| `GET /api/health` | Container and monitor health checks |
| `GET /.well-known/ai-agent.json`, `GET /llms.txt`, `GET /openapi.json` | Self-description; they list the registry, never any data |
| `GET /.well-known/oauth-*` | Connector discovery (RFC 8414 / RFC 9728) |
| `POST /oauth/register`, `POST /oauth/token`, `POST /oauth/revoke` | The OAuth 2.1 flow. PKCE `S256` is required, so an intercepted code is useless |
| `POST /api/agent/register` | Agent signup. Needs a valid invite code to join an existing organization, and is rate limited |
| `GET /ical/:token.ics` | Calendar clients cannot send headers, so the credential is in the path |

The discovery documents describe the *registry*, not your data: which actions exist
and what they take. What a given credential may call is `GET /api/actions`, which
needs that credential.

Treat two things as secrets in their own right: an **invite code** (it lets anyone
create an agent seat in your organization — regenerate it from Org → Agents when it
leaks) and an **iCal URL** (the URL *is* the credential; revoke the `ical` token to
kill it).

## What is not in scope

Stated plainly, so nobody assumes otherwise:

- **No SSO/SAML/OIDC login.** Email and password, or an API token.
- **No 2FA on password login** yet.
- **No per-token scopes.** A `ptd_` token carries its user's full role in one
  organization. Narrower access means a narrower *seat* — give the agent `member`
  rather than `manager`.
- **No audit log of reads.** Mutations are recorded in `task_events`; queries are not.
- **Webhooks are not retried.** One attempt, 5-second timeout, failures logged.
  Reconcile from `task.history` if your endpoint can miss events.
- **No secrets management.** `.env` is a file on disk; if you need Vault or KMS,
  inject the variables from it.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository rather than a public
issue.
