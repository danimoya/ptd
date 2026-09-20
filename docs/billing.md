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

### Invoicing your own customers

Unrelated to PTD's own billing: the Track surface can produce invoices for the
organization's customers from logged time — `invoice.preview`, `invoice.generate`,
`invoice.list`, with customers managed through `customer.*` and goals through
`customer.goals`. That works identically on a self-hosted deployment.
