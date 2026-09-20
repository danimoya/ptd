# Billing

## Self-hosting: free, and not crippled

Self-hosting costs nothing and is not a trial. There is no license key, no seat
ceiling, no feature behind a flag, and **no billing code in the running process at
all**: the billing routes are registered only when `PTD_HOSTED=1`, so a self-hosted
deployment has no Stripe webhook, makes no outbound call to Stripe, and ships no
payment SDK to audit.

An organization created on a self-hosted deployment gets `plan: "self_hosted"`, which
is exempt from every limit. The Org → Billing tab does not appear.

## Hosted: $15/month per organization

<https://ptd.danimoya.com> — one flat price per organization, any number of seats,
humans and agents alike. There is no per-seat quantity to reconcile and no
proration to reason about: a subscription either exists and is healthy, or it does
not.

| Plan | Price | Seats | Who gets it |
|---|---|---|---|
| `self_hosted` | free | unlimited | Every organization on a deployment without `PTD_HOSTED=1` |
| `free` | free | **3** | A new organization on the hosted deployment |
| `hosted` | $15/month | unlimited | A hosted organization with a healthy subscription |

### The free tier's one limit

Three members, **humans and agents counted together** — an agent is a member with a
token, not a cheaper kind of account. The check runs at the two points that add a
seat: accepting an invitation and registering an agent. Both answer `403` with
`error: "plan_limit"` and a message naming the price, rather than failing
obscurely. Nothing else is limited: the same actions, the same API, the same MCP
server, the same integrations.

### Managing a subscription

Four actions, all `owner`:

| Action | Effect |
|---|---|
| `billing.status` | Current plan, seat usage, whether the limit is being enforced, and the subscription's state |
| `billing.checkout` | A Stripe Checkout URL for this organization |
| `billing.portal` | A Stripe billing-portal URL — change the card, see invoices, cancel |
| `billing.sync` | Re-read the subscription from Stripe, for when a webhook was missed |

Everything a browser can do goes through those actions, so the role gate cannot be
bypassed. The only billing HTTP route is Stripe's webhook, at
`POST /api/billing/webhook`, whose signature is verified against
`STRIPE_WEBHOOK_SECRET` over the exact request bytes.

Cancelling drops the organization back to `free`. The data stays; the three-seat
limit starts applying again to *new* seats.

### Running your own hosted deployment

If you want to charge for a deployment you operate:

| Variable | Meaning |
|---|---|
| `PTD_HOSTED=1` | Turns the plans and the billing surface on |
| `STRIPE_SECRET_KEY` | Your Stripe secret key. Without it, billing actions fail with an explicit "not configured" error rather than half-working |
| `STRIPE_PRICE_ID` | The recurring price to subscribe organizations to |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the endpoint pointed at `/api/billing/webhook` |
| `PTD_PUBLIC_URL` | Where Stripe returns the customer to |
| `PTD_BILLING_RETURN_PATH` | Only if the Billing tab is not mounted at `/org/billing` |

Two implementation notes that matter if you touch this code:

- **There is no `stripe` npm dependency.** The client is a small hand-rolled REST
  wrapper over `fetch`, because billing is a hosted-only concern and self-hosters
  must not have to carry or audit a payment SDK they never call.
- **The API version is pinned** (`2026-08-26.dahlia`). An unpinned integration
  silently changes shape when Stripe ships a new version. Bump it deliberately, with
  the webhook fixtures re-recorded.

---

# Invoicing from the ledger

Everything below is unrelated to PTD's own subscription. It is how an organization
bills **its** money: outwards to customers, and inwards from external contractors.
It works identically on a self-hosted deployment.

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
| `invoice.contractor_generate` | manager | Issues and certifies; returns `{invoiceId, reference, verifyUrl, pdfUrl, contentHash}` |
| `invoice.contractor_list` | member (own) / manager | Issued contractor invoices with their verification links |
| `invoice.preview` / `invoice.generate` / `invoice.list` | manager | The same, for customers |
| `invoice.void` | admin | Unlocks the entries and stamps `voided_at`; the reason goes to the audit trail |

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

```
GET /api/verify/:token        # public, unauthenticated, rate-limited
```

Three checks run and fail independently, so the answer says *which* assurance
broke:

| Field | Means |
|---|---|
| `contentHashMatches` | The stored snapshot still hashes to its recorded value — nobody edited the frozen record |
| `signatureValid` | That hash verifies against the published key — nobody rewrote the record *and* its hash |
| `entriesUnchanged` | Re-hashing the live ledger rows reproduces the frozen hashes; `changedEntryIds` and `missingEntryIds` name what moved |

A voided invoice reports all three passing and `valid: false`, with the reason.

The response carries a date, a duration, the stream and task, and human-vs-agent —
**never** a session note, an email address or an exact clock time. The public page
at `/verify/:token` renders the same answer for a human: a large Verified / Not
verified verdict, the reasons, the document's own terms, the three checks, the
hours, a link to the public key and a copy of the raw JSON.

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
