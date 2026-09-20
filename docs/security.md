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
| TOTP secret | AES-256-GCM under `PTD_SECRET_KEY` | Until 2FA is turned off |
| Recovery codes | AES-256-GCM under `PTD_SECRET_KEY`, rewritten without the code that was spent | Single use each; ten at a time |
| Pre-auth token (between a password and a code) | JWT with `purpose: "mfa"`, never accepted as a session | 5 minutes |
| OIDC hand-off code | In memory, single use | 2 minutes |
| Export download token | In memory, single use, bound to one organization and one user | 5 minutes |

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

## Second factor (TOTP)

Optional per account, and requirable per organization.

- **RFC 6238**, HMAC-SHA1 over a 160-bit secret, 30-second steps, six digits, ±1
  step accepted for clock drift. No dependency: it is `crypto` and forty lines.
  Any authenticator app works — there is nothing PTD-specific in the QR code,
  which the server draws itself as an SVG.
- **Enrolment is two steps.** `POST /api/auth/totp/setup` stores the sealed secret
  with 2FA still *off*; only `POST /api/auth/totp/verify`, with a code the app
  actually produced, turns it on. A half-finished enrolment locks nobody out.
- **Sign-in becomes two calls.** `POST /api/auth/login` answers
  `{ mfaRequired: true, preAuthToken }` — a five-minute, purpose-scoped JWT that
  the session verifier refuses — and `POST /api/auth/totp/login` trades it plus a
  code (or one recovery code) for the real session. Five wrong codes in five
  minutes and that account's step-up stops answering, whatever the IP.
- **Ten recovery codes**, shown once, sealed at rest, each good once: spending one
  rewrites the stored list without it. `POST /api/auth/totp/recovery-codes`
  replaces the set, and turning 2FA off needs a live code or a recovery code, so a
  borrowed session cannot quietly remove the second factor.
- **A provider sign-in honours it too**: the callback hands back the same 2FA
  challenge rather than a session.

### Requiring it

`org.set_security { requireTotp: true }` (admin) makes it mandatory. Then every
org-scoped request from a human without 2FA answers:

```json
403 { "error": "totp_required", "setupPath": "/auth?setup=2fa" }
```

Three deliberate details:

- The action **refuses unless the caller already has 2FA**, so it cannot lock out
  the person who turned it on.
- **Agent seats are exempt.** An agent cannot hold a phone; its credential is a
  `ptd_` token an admin mints and revokes. The test is `users.is_agent`, not the
  authentication path, so a *human's* API token is not exempt and the CLI is not a
  way around the policy.
- **The account surface `/api/auth/**` is outside the organization scope**, and the
  setup page hangs off `/auth`, not off the Org tab — which is admin-only and
  whose own data this rule refuses. Whoever is refused can always reach the page
  that fixes it.

## Signing in with a provider (OIDC)

Google, GitHub and Microsoft, each present only when its client id *and* secret are
configured — an unconfigured provider is not advertised and its start route 404s.

```
GET  /api/auth/providers                which are configured
GET  /api/auth/oidc/:provider/start     → the provider, with signed state + PKCE
GET  /api/auth/oidc/:provider/callback  ← the provider, → /auth?oidc=<code>
POST /api/auth/oidc/exchange            the code for the session token
```

- **No token in a URL.** The callback can only redirect, and a JWT in a redirect
  lands in browser history, the proxy's access log and the next page's `Referer`.
  So it redirects with a two-minute single-use code, which the SPA posts back.
- **State is signed** (HMAC-SHA256 over `{nonce, redirectTo, inviteToken}`) and its
  nonce is single-use, so it cannot be replayed or forged. `redirectTo` is only
  ever a path inside PTD — an open redirector on the sign-in page is a phishing
  primitive.
- **PKCE `S256`** for the providers that support it; the verifier is kept
  server-side, keyed by the nonce, so it never travels with its own challenge.
  GitHub's OAuth app endpoints ignore PKCE, so it is not claimed there.
- **Identity is `(provider, subject)`**, not the address: a renamed GitHub login or
  a changed work address is still the same person.
- **Linking needs a verified address.** An unverified one would let anyone who can
  create an account at a provider take over a PTD account by typing someone else's
  address into it. Microsoft Graph exposes no verification flag — an address a
  tenant or Microsoft itself issued is treated as verified; GitHub's comes from
  `/user/emails` and must be `primary` and `verified`.
- **A new account gets a random password** (32 bytes, bcrypt) that nobody knows.
  "Forgot password" is how it ever becomes usable, which is also why unlinking the
  last provider asks for confirmation.
- The ID token is deliberately **not** trusted for identity: the profile is read
  from the userinfo endpoint over TLS with the access token, so there is no JWKS to
  fetch, cache, rotate or mis-verify.

## The audit log

`audit_events` is the history of the *account and the organization* — distinct from
`task_events`, which is the history of a task and part of the product.

- Recorded: sign-ins and refused sign-ins, second factors asked for, accepted,
  refused, turned on and off, recovery codes used, providers linked and unlinked,
  organizations created and deleted, roles changed, members removed and joined,
  invitations and invite-code regeneration, tokens minted, revoked and rotated,
  agent seats opened, integrations connected and disconnected, billing opened, the
  security policy changed, data exported.
- Each row carries the organization, the actor, a kind, a target, a JSON `meta` and
  the client IP as `trust proxy` resolves it.
- **Actions marked `audited` in the registry write their row after the handler
  succeeds.** A refused or failed action records nothing, because nothing happened.
- **Anything in `meta` whose key reads like a credential** (`token`, `secret`,
  `password`, `code`, `key`, `hash`, …) is stored as `[redacted]`. A log that leaks
  what it logs about is worse than no log.
- A sign-in has no organization context, so it is filed against the actor's oldest
  membership — the same organization a request with no `X-Org-Id` resolves to.
- `audit.list` (admin+) pages up to 200 rows and filters by date range and kind — a
  kind ending in a dot is a prefix, so `token.` matches every token event.
  `audit.export` writes the range as RFC 4180 CSV.

## Taking your data out, and deleting it

- `org.export` (owner) mints a **single-use, five-minute** link;
  `GET /api/org/export?token=…` builds the archive when it is fetched and re-checks
  that the caller is still the owner — a role can be taken away between minting and
  clicking. No Authorization header is needed, which is what lets a browser follow
  it; the token is the credential, and it works exactly once.
- The archive is a stored (uncompressed) ZIP written by PTD itself:
  `organization.json`, `members.csv`, `streams.csv`, `apps.csv`, `tasks.csv`,
  `task_events.csv`, `time_entries.csv`, `invoices.json`, `audit_events.csv` and a
  README naming each. CSV is RFC 4180, and a cell beginning `=`, `+`, `-` or `@` is
  prefixed with an apostrophe so no spreadsheet reads it as a formula.
- `org.delete` (owner) needs the organization's exact name and refuses while a
  hosted subscription is live. Deletion cascades through the foreign keys; human
  members keep their accounts, and an agent seat that existed only there goes with
  it. The audit row it writes has a **null** organization — the column is a foreign
  key to the row being deleted — and names what was deleted in its target.

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
| `/api/auth/*` (sign-in, reset, TOTP setup/verify/step-up, OIDC start and exchange), `POST /api/agent/register` | 20 per 15 minutes |
| A single account's 2FA step-up | 5 wrong codes per 5 minutes, then refused regardless of IP |
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

- **No SAML, and no SCIM provisioning.** OIDC sign-in with Google, GitHub and
  Microsoft is supported (above); enterprise directory sync is not.
- **No WebAuthn / passkeys.** The second factor is TOTP; hardware keys are not
  supported yet.
- **No trusted devices.** Every sign-in asks for the second factor; there is no
  "remember this browser for 30 days".
- **No per-token scopes.** A `ptd_` token carries its user's full role in one
  organization. Narrower access means a narrower *seat* — give the agent `member`
  rather than `manager`.
- **No audit log of reads.** `audit_events` records account and organization
  changes and `task_events` records task changes; queries are recorded nowhere.
- **Webhooks are not retried.** One attempt, 5-second timeout, failures logged.
  Reconcile from `task.history` if your endpoint can miss events.
- **No secrets management.** `.env` is a file on disk; if you need Vault or KMS,
  inject the variables from it.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository rather than a public
issue.
