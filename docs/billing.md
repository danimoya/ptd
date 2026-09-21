# Billing

## Self-hosting: free, and not crippled

Self-hosting costs nothing and is not a trial. There is no license key, no seat
ceiling, no feature behind a flag, and **no billing code in the running process at
all**: the billing routes are registered only when `PTD_HOSTED=1`, so a self-hosted
deployment has no Stripe webhook, makes no outbound call to Stripe, and ships no
payment SDK to audit.

An organization created on a self-hosted deployment gets `plan: "self_hosted"`, which
is exempt from every limit. The Org → Billing tab does not appear.

## Hosted: three plans, one price per organization

<https://ptd.danimoya.com> — the price is per **organization**, never per seat, and
**agent seats are free**. An agent pays its own API bill; charging for its chair as
well would be charging twice.

| Plan | Price | Human seats | What it adds |
|---|---|---|---|
| `self_hosted` | free | no limit | Everything, with no billing code in the running process |
| `free` | $0 | **3 seats, humans and agents together** | One organization, all four surfaces, MCP and REST, community support |
| `team` | **$15**/org/month, or **$150** a year | up to **10**; agents free | Every surface and integration, OAuth connectors for Claude.ai and ChatGPT, signed webhooks, importers, certified invoices at $1 each |
| `business` | **$49**/org/month, or **$490** a year | **50** included, then **$2** per human seat a month (**$20** a year); agents free | Certified invoices and verifiable links included, SSO/2FA policy, audit log and data export, Stripe Tax, priority support, AI priority scoring with your own key |

The yearly price is ten months — **two months free**, which is $12.50 a month on
Team and $40.83 on Business. Whatever the plan, a hosted organization is capped at
**100 members** counting humans and agents (`PTD_HOSTED_MAX_MEMBERS`); past that it
wants a deployment of its own, which is a conversation rather than a checkout.

**Founding members**: the promotion code `FOUNDING` — 40% off, first 100
organizations — is typed into the promotion-code field at Stripe Checkout
(`allow_promotion_codes`), not applied by PTD. The Billing tab only offers it while
the organization has no subscription yet, because that is the only place it can be
redeemed.

### Add-ons, metered

| Add-on | Price | Who pays it |
|---|---|---|
| Certified invoice | **$1** each | **Team** meters one per invoice issued. **Business** includes them. **Free** cannot issue one at all — `invoice.generate` refuses and names the plan |
| PTD-provided AI | provider cost **+ 20%**, metered in whole cents | Only an organization using PTD's key. With **your own provider key nothing is metered** and the provider bills you directly |

Both ride as extra items on the same subscription, so they appear on the same
invoice rather than as a second charge. The Billing tab shows what they have come to
so far this period, counted from the same rows that were metered, which is why the
figures agree with the invoice by construction.

### How seats are counted

Two counts, for two different questions.

- **Human seats** are what a plan sells: 3 on Free (see below), 10 on Team, 50
  included on Business and $2 each after that. Agents never consume one.
- The **member cap** counts humans and agents together and is a hard ceiling for
  every hosted plan. It is a hosting limit, not a price.

Free is the exception that proves the rule: its three seats *are* the cap, counting
humans and agents together — an agent is a member with a token, not a cheaper kind
of account. The check runs at the two points that add a seat: accepting an
invitation and registering an agent. Both answer `403` with `error: "plan_limit"`
and a message naming the plan that has room, rather than failing obscurely.

Business is the other exception: humans past the 50 included are **billed, not
refused**. The seat line item's quantity is set from the current human count at
checkout and at every plan change, and `syncSeatQuantity` re-sets it whenever the
roll changes — an invitation accepted, a member removed, an agent registered — so
the bill follows the roll without anybody reconciling anything.

### Managing a subscription

Five actions. `billing.status` is `admin` so a finance-minded admin can read the
bill; everything that spends money is `owner`:

| Action | Role | Effect |
|---|---|---|
| `billing.status` | admin | The whole Billing tab: plan, interval, the price list and the plan descriptions, seat limits and usage, the metered add-ons this period, the live subscription, and the founding code while it is on offer |
| `billing.checkout` | owner | A Stripe Checkout URL for `{plan, interval}` — refuses if a subscription already exists |
| `billing.change_plan` | owner | Moves an existing subscription between plans or intervals in place; Stripe prorates onto the next invoice and the subscription keeps its identity and its discount |
| `billing.portal` | owner | A Stripe billing-portal URL — change the card, see invoices, cancel |
| `billing.sync` | owner | Re-read the subscription from Stripe, for when a webhook was missed |

Everything a browser can do goes through those actions, so the role gate cannot be
bypassed. The only billing HTTP route is Stripe's webhook, at
`POST /api/billing/webhook`, whose signature is verified against
`STRIPE_WEBHOOK_SECRET` over the exact request bytes.

**The price is the truth.** An organization's plan is derived from the
subscription's base price — its lookup key, else its id — never from what a client
asked for; `organizations.plan` is a cache of that derivation. Rows written by
pricing v1, which said `hosted` for the single $15 tier, are read as `team`.

Cancelling drops the organization back to `free` at the end of the period already
paid for. The data stays; the three-seat limit starts applying again to *new* seats.

### Running your own hosted deployment

If you want to charge for a deployment you operate:

| Variable | Meaning |
|---|---|
| `PTD_HOSTED=1` | Turns the plans and the billing surface on |
| `STRIPE_SECRET_KEY` | Your Stripe secret key. Without it, billing actions fail with an explicit "not configured" error rather than half-working |
| `STRIPE_PRICE_TEAM_MONTHLY` / `STRIPE_PRICE_TEAM_YEARLY` | The two Team prices |
| `STRIPE_PRICE_BUSINESS_MONTHLY` / `STRIPE_PRICE_BUSINESS_YEARLY` | The two Business prices |
| `STRIPE_PRICE_ID` | Legacy alias for Team monthly, still honoured so a v1 deployment keeps working without an env edit |
| `STRIPE_PRICE_SEAT_MONTHLY` / `STRIPE_PRICE_SEAT_YEARLY` | The per-human-seat price added past Business's 50 |
| `STRIPE_PRICE_CERT_INVOICE` / `STRIPE_PRICE_AI_USAGE` | The two metered prices |
| `STRIPE_METER_CERT_INVOICE` / `STRIPE_METER_AI_USAGE` | Meter `event_name`s, if yours differ from `ptd_certified_invoices` / `ptd_ai_usage_cents` |
| `STRIPE_COUPON_FOUNDING` | The founding-member coupon. Unset means the tab offers no code |
| `PTD_HOSTED_MAX_MEMBERS` | The hard member cap, humans and agents. Default 100 |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the endpoint pointed at `/api/billing/webhook` |
| `PTD_PUBLIC_URL` | Where Stripe returns the customer to |
| `PTD_BILLING_RETURN_PATH` | Only if the Billing tab is not mounted at `/org/billing` |

Checkout is told to come back to `…/org/billing?tab=billing&checkout=success&plan=<plan>&session_id={CHECKOUT_SESSION_ID}`;
the tab calls `billing.sync` once with that session id — the redirect usually beats
the webhook — and then drops `session_id` from the address bar. Cancelling returns
to `…?tab=billing&checkout=cancelled`, and the portal to `…?tab=billing&portal=return`.

The four plan prices carry lookup keys (`ptd_team_monthly`, `ptd_team_yearly`,
`ptd_business_monthly`, `ptd_business_yearly`), which is what makes the plan
readable back from a subscription in any Stripe account, including one whose price
ids you did not create.

Two implementation notes that matter if you touch this code:

- **There is no `stripe` npm dependency.** The client is a small hand-rolled REST
  wrapper over `fetch`, because billing is a hosted-only concern and self-hosters
  must not have to carry or audit a payment SDK they never call.
- **The API version is pinned** (`2026-08-26.dahlia`). An unpinned integration
  silently changes shape when Stripe ships a new version. Bump it deliberately, with
  the webhook fixtures re-recorded.

---

# Invoicing from the ledger

Everything below is about how an organization bills **its** money: outwards to
customers, and inwards from external contractors. It works identically on a
self-hosted deployment, and it is unrelated to PTD's own subscription with one
exception — on the hosted instance, issuing a **certified** invoice is a metered
add-on: **$1 each on Team**, **included on Business**, and **refused on Free**.

## Two kinds of invoice

| Kind | Who issues it | Who is billed | Rate comes from |
|---|---|---|---|
| `customer` | the organization | a customer | the stream's `hourly_rate`, else the customer's |
| `contractor` | an **external member** | the organization | that member's `memberships.hourly_rate` |

They share one table (`invoices.kind`), one certification scheme and one PDF
renderer; they differ in who the document names as issuer. On a customer invoice
the organization renders to its client. On a contractor invoice the external
member is the issuer, with their own billing name, address and tax id, and the
organization is the bill-to — the money flows the other way, so the masthead does.

## Marking a member external

Billing is a property of the seat, so it lives on Org → Members. **Admin and
above** — a rate is money, and nobody sets their own.

| Action | Role | Effect |
|---|---|---|
| `member.set_billing` | admin | `{userId, billable, hourlyRate?, currency?, billingName?, billingAddress?, taxId?, requireApproval?}` |
| `member.billing` | member | One member's settings (your own always; anyone else's needs manager), or the whole roll |
| `billing.contractors` | manager | Every billable member with the month's approved / pending / unsubmitted minutes and what is owed |

Turning `billable` off leaves the rate and issuer details in place, so a returning
contractor does not have to be re-typed. A member with `billable: false` cannot be
invoiced at all — `invoice.contractor_preview` refuses and says why.

## Approvals

With `require_approval` on a membership, that member's finished entries close as
`pending` instead of `none` (`time_entry.stop`, `time_entry.log_past`), and only
`approved` entries reach an invoice. `none` means "no approval is asked of these",
not "not yet approved".

| Action | Role | Effect |
|---|---|---|
| `time_entry.submit` | member | Moves your own closed, non-break entries in a window to `pending` |
| `time_entry.approve` | manager | `{entryIds[]}` or `{userId, from, to}`; writes `approved_by`/`approved_at` from the credential |
| `time_entry.reject` | manager | `{entryIds[], reason}`; the line stops counting until it is corrected and resubmitted |
| `time_entry.pending` | member | The approval queue; a member sees only their own |

Both halves live on the ledger, because the thing being judged is a ledger line: a
member gets a **submit** button for the month they are looking at, and a manager in
Team view gets approval chips and approve / reject controls per row.

## Certified invoices

On a self-hosted deployment certification is free and unlimited. On the hosted
instance it is the one add-on the ledger itself can spend: **Business includes
certified invoices and their verifiable links**, **Team meters one $1 charge per
invoice issued** (recorded as the invoice is issued, so a voided invoice is still
billed — the dollar was for issuing and signing the document, and voiding it does
not un-sign it), and **Free cannot issue one at all** — the action refuses and names
the plan that can. What the meter has counted so far this period is on Org →
Billing.

Issuing an invoice — of either kind — does four things in one step:

1. **Freezes** every included entry into a snapshot: the org, the party, the
   period, the currency and rate, one line per entry with its exact times, what it
   was booked against, whether a human or an agent produced it, and a
   `sha256` of the entry's immutable columns.
2. **Hashes** the snapshot. `contentHash = sha256(canonical JSON)` — keys sorted at
   every depth, so a row read back in a different column order hashes the same.
3. **Signs** that hash with the deployment's Ed25519 key
   (`signature = base64(ed25519(contentHash))`, over the ASCII of the hex digest).
4. **Locks** every included entry: `time_entries.locked_invoice_id` is set, and
   `time_entry.update` / `time_entry.delete` then answer **409** for everyone,
   admins included.

| Action | Role | Effect |
|---|---|---|
| `invoice.contractor_preview` | member (own) / manager | What the month would bill, with the minutes being left out for want of approval |
| `invoice.contractor_generate` | manager | Issues and certifies; returns `{invoiceId, reference, verifyUrl, pdfUrl, contentHash, recipientCount}` |
| `invoice.contractor_list` | member (own) / manager | Issued contractor invoices with their verification links |
| `invoice.preview` / `invoice.generate` / `invoice.list` | manager | The same, for customers |
| `invoice.void` | admin | Unlocks the entries and stamps `voided_at`; the reason goes to the audit trail |
| `invoice.share` | manager, or the contractor the invoice is about | Names addresses as recipients and writes to them with the link |
| `invoice.recipients` | manager / contractor (own) | The allowlist, masked — never an address |
| `invoice.unshare` | manager / contractor (own) | Takes an address off the list and destroys any code already sent to it |

References are `PTD-2026-09-0007` for customers and `PTD-CTR-2026-09-0007` for
contractors. Because the reference is inside what gets signed, the row is inserted
first and certified second.

**Re-issuing a month means voiding the first invoice**, not generating a second on
top of it: the entries are locked, so a second generate is refused and names the
invoice holding them. Voiding deliberately leaves the snapshot, hash and signature
in place — a copy of the PDF is in someone's hands and must go on verifying, as
withdrawn.

### The signing key

Created on first use and never exported: the public half is stored in the clear
and published, the private half is sealed with `encryptSecret` (AES-256-GCM under
`PTD_SECRET_KEY`), the same envelope the integrations' credentials use. Keys are
never deleted; `retired_at` stops one signing new invoices while it stays
published, because an invoice issued two years ago must still verify.

```
GET /.well-known/ptd-signing-key.json
{ "algorithm": "ed25519",
  "keys": [{ "id": 1, "algorithm": "ed25519", "publicKey": "-----BEGIN PUBLIC KEY-----…", "createdAt": "…", "retiredAt": null }] }
```

### Verification

Every invoice carries a URL built from 32 random bytes:
`<PTD_BASE_URL>/verify/<token>`, printed on the PDF as text **and as a QR code**
(a dependency-free encoder lives in `server/invoices/qr.ts`: byte mode, ECC L/M,
versions 1–10, drawn as vector rectangles so it stays crisp in print).

**The link proves authenticity to anyone; the particulars are released to named
recipients only.** A verification link is printed on a document that travels — it
is forwarded, filed, and attached to other mail — so the bare link answers only
what a holder needs to know that the document is real:

```
GET /api/verify/:token        # public, unauthenticated, rate-limited
{ "valid": true,
  "invoice":   { "reference": "PTD-CTR-2026-09-0001", "kind": "contractor",
                 "issuedAt": "2026-09-20T12:00:00.000Z", "voided": false },
  "integrity": { "contentHashMatches": true, "signatureValid": true,
                 "entriesUnchanged": true, "keyId": 1 },
  "detailsAvailable": true }
```

No organization, no contractor or customer, no period, no rate, no total, no line
items — and not even the content hash, which is a fingerprint of the whole record.
A failed check still reports *which* assurance broke, in counts rather than names.

Three checks run and fail independently, so the answer says *which* assurance
broke:

| Field | Means |
|---|---|
| `contentHashMatches` | The stored snapshot still hashes to its recorded value — nobody edited the frozen record |
| `signatureValid` | That hash verifies against the published key — nobody rewrote the record *and* its hash |
| `entriesUnchanged` | Re-hashing the live ledger rows reproduces the frozen hashes; `changedEntryIds` and `missingEntryIds` name what moved |

A voided invoice reports all three passing and `valid: false`, with the reason.

The public page at `/verify/:token` renders that answer for a human: a large
Verified / Not verified verdict, the sentence *"This is a genuine PTD certified
invoice PTD-CTR-2026-09-0001, issued 20 September 2026. Integrity: verified."*, the
three checks, a link to the public key, and a form to ask for the details.

### Access codes

The details — who issued the invoice, who it is for, the period, the rate, the
total and the hours behind it — are released only to an address on the invoice's
**recipient allowlist**, and only after a six-digit code emailed to that address.

```
POST /api/verify/:token/request-code   {email}           # 5 per token+IP per 15 min
POST /api/verify/:token/redeem         {email, code}     # 15 per token+IP per 15 min
GET  /api/verify/:token/details        Authorization: Bearer <access token>
```

- **Who may ask.** An address on the allowlist, one of the issuing organization's
  owner/admins/managers, or the contractor the invoice is about. Anyone else gets
  the same 200 and the same sentence — *"If that address is a named recipient of
  this invoice, an access code is on its way"* — as a recipient does. So does an
  address on a token that never existed. Nothing in the reply, its shape or its
  status code distinguishes the three.
- **The code.** Six digits, valid **10 minutes**, stored as
  `sha256(code + ":" + verifyToken)` and never in the clear. Five wrong tries kill
  it; asking again replaces the live one, so a code read out of an older letter
  stops working. With **no SMTP configured** and outside production the code comes
  back in the response, because there is nowhere else for it to go.
- **What redeeming buys.** A purpose-scoped JWT (`purpose: "invoice.access"`),
  good for **30 minutes**, carrying `sha256(verifyToken)` and the recipient's hash.
  It opens that one invoice and nothing else, and `verifySessionJwt` refuses it as
  a login because it has a purpose. The page keeps it in `sessionStorage` for the
  tab.
- **The recipient list.** `invoice.share {invoiceId, emails[], message?}` adds
  addresses and writes to each with the link and a note that a code will be sent to
  that address on request. **No address is stored**: a recipient is
  `sha256(verifyToken + ":" + address)` plus a mask (`a••••a@northwind.example`),
  so the same accountant on two invoices produces two unrelated hashes and the
  column cannot be mined for a mailing list. The consequence is deliberate — PTD
  cannot show an address back, and "resend" means typing it again, which
  `invoice.share` treats as a re-send rather than a duplicate. Issuing an invoice
  allowlists the contractor being paid and, on a customer invoice, the customer's
  billing address when one is recorded.
- **Where it lives.** In `invoices.snapshot.access` — the `invoices` table has no
  column for it — and `contentHashOf` strips that key before hashing, so sharing an
  invoice never moves the hash printed on a PDF already in the post. Every invoice
  issued before this existed hashes byte-for-byte as it did.
- **What is recorded.** `invoice.access_requested`, `invoice.access_granted`,
  `invoice.access_denied`, `invoice.shared` and `invoice.unshared` land in the
  organization's audit trail against the invoice's reference, with the recipient's
  **hash** and never their address. `invoice.share` is deliberately *not* marked
  `audited` in the registry: that flag records an action's arguments verbatim, and
  the arguments here are email addresses.

The detail response still carries a date, a duration, the stream and task, and
human-vs-agent — **never** a session note, an email address or an exact clock
time.

### Rates and money

- A customer invoice prices each line at the **stream's** `hourly_rate`, falling
  back to the **customer's**. Where neither exists the document states hours and
  says so; monetary terms are settled outside it.
- A contractor invoice prices the month at the member's own rate, in the member's
  own currency. The total is computed once from the month's total minutes, so a
  rate never drifts by a cent per day; per-line amounts are the same arithmetic
  applied per line.
- Agent API cost is always stated **separately**, at face value, and is never
  added to the amount due. An invoice that hides whether a human or a machine
  produced an hour is the wrong document; so is one that quietly marks up tokens.
