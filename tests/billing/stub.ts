/**
 * A local stand-in for api.stripe.com.
 *
 * Two faces on one router: `stripeStub().fetchImpl` for unit tests (inject it into
 * StripeClient) and `startStripeStub(port)` for the manual dev loop, where the
 * server process talks to it over HTTP via STRIPE_API_BASE. Both record every
 * request so a test can assert the exact form-encoded body Stripe would receive.
 */
import { createHmac } from "crypto";
import { createServer, type Server } from "http";
import type { FetchLike } from "../../server/billing/stripe";

export interface StubCall {
  method: string;
  path: string;
  rawBody: string;
  body: Record<string, string>;
  headers: Record<string, string>;
}

export interface StubOptions {
  /** Subscriptions by id, as GET /v1/subscriptions/:id would answer. */
  subscriptions?: Record<string, Record<string, unknown>>;
  /** Customers Stripe already knows about (GET /v1/customers/:id). */
  customers?: Record<string, Record<string, unknown>>;
  checkoutUrl?: string;
  portalUrl?: string;
  newCustomerId?: string;
  checkoutSessionId?: string;
  /** Checkout sessions by id, as GET /v1/checkout/sessions/:id would answer. */
  checkoutSessions?: Record<string, Record<string, unknown>>;
}

export interface StubResponse {
  status: number;
  body: Record<string, unknown>;
}

export function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw).entries()) out[k] = v;
  return out;
}

export function stripeStub(opts: StubOptions = {}) {
  const calls: StubCall[] = [];
  const subscriptions = { ...(opts.subscriptions ?? {}) };
  const customers = { ...(opts.customers ?? {}) };
  const checkoutSessions = { ...(opts.checkoutSessions ?? {}) };
  const newCustomerId = opts.newCustomerId ?? "cus_stub_org";
  const checkoutSessionId = opts.checkoutSessionId ?? "cs_test_stub";
  const checkoutUrl = opts.checkoutUrl ?? `https://checkout.stripe.com/c/pay/${checkoutSessionId}`;
  const portalUrl = opts.portalUrl ?? "https://billing.stripe.com/p/session/stub";

  function route(method: string, path: string, form: Record<string, string>): StubResponse {
    if (method === "POST" && path === "/v1/customers") {
      const created = { id: newCustomerId, object: "customer", email: form.email, name: form.name, metadata: { orgId: form["metadata[orgId]"] } };
      customers[newCustomerId] = created;
      return { status: 200, body: created };
    }
    if (method === "GET" && path.startsWith("/v1/customers/")) {
      const id = decodeURIComponent(path.slice("/v1/customers/".length));
      const found = customers[id];
      return found
        ? { status: 200, body: found }
        : { status: 404, body: { error: { message: `No such customer: '${id}'`, code: "resource_missing", type: "invalid_request_error" } } };
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const session = {
        id: checkoutSessionId,
        object: "checkout.session",
        url: checkoutUrl,
        mode: form.mode,
        customer: form.customer,
        client_reference_id: form.client_reference_id,
      };
      checkoutSessions[checkoutSessionId] = { ...session, status: "complete", payment_status: "paid", subscription: Object.keys(subscriptions)[0] ?? "sub_stub" };
      return { status: 200, body: session };
    }
    if (method === "GET" && path.startsWith("/v1/checkout/sessions/")) {
      const id = decodeURIComponent(path.slice("/v1/checkout/sessions/".length));
      const found = checkoutSessions[id];
      return found ? { status: 200, body: found } : { status: 404, body: { error: { message: `No such checkout session: '${id}'` } } };
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") {
      return { status: 200, body: { id: "bps_stub", object: "billing_portal.session", url: portalUrl, customer: form.customer, return_url: form.return_url } };
    }
    if (method === "GET" && path === "/v1/subscriptions") {
      return { status: 200, body: { object: "list", data: Object.values(subscriptions) } };
    }
    if (method === "GET" && path.startsWith("/v1/subscriptions/")) {
      const id = decodeURIComponent(path.slice("/v1/subscriptions/".length));
      const found = subscriptions[id];
      return found ? { status: 200, body: found } : { status: 404, body: { error: { message: `No such subscription: '${id}'`, code: "resource_missing" } } };
    }
    return { status: 404, body: { error: { message: `stub has no route for ${method} ${path}`, type: "invalid_request_error" } } };
  }

  function handle(method: string, url: string, rawBody: string, headers: Record<string, string> = {}): StubResponse {
    const [path, query = ""] = url.split("?");
    const form = method === "GET" ? parseForm(query) : parseForm(rawBody);
    calls.push({ method, path, rawBody: method === "GET" ? query : rawBody, body: form, headers });
    return route(method, path, form);
  }

  const fetchImpl: FetchLike = async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const url = input.replace(/^https?:\/\/[^/]+/, "");
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const rawBody = typeof init.body === "string" ? init.body : "";
    const { status, body } = handle(method, url, rawBody, headers);
    const text = JSON.stringify(body);
    // A minimal Response: the client only reads ok / status / text().
    return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
  };

  return {
    calls,
    fetchImpl,
    handle,
    subscriptions,
    customers,
    /** Calls to one path, in order. */
    callsTo: (path: string) => calls.filter((c) => c.path === path),
    last: () => calls[calls.length - 1],
  };
}

/** The same router behind a real HTTP port, for the manual dev loop. */
export function startStripeStub(port: number, opts: StubOptions = {}): Promise<{ server: Server; stub: ReturnType<typeof stripeStub> }> {
  const stub = stripeStub(opts);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const { status, body } = stub.handle((req.method ?? "GET").toUpperCase(), req.url ?? "/", Buffer.concat(chunks).toString("utf8"));
      const payload = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, stub })));
}

/** Build the `Stripe-Signature` header Stripe would send for this exact payload. */
export function signPayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Minimal Stripe subscription fixture. */
export function subscriptionFixture(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const periodEnd = Math.floor(Date.UTC(2026, 9, 19, 12, 0, 0) / 1000);
  return {
    id: "sub_stub",
    object: "subscription",
    status: "active",
    customer: "cus_stub_org",
    cancel_at_period_end: false,
    items: { object: "list", data: [{ id: "si_stub", current_period_end: periodEnd, price: { id: "price_test" } }] },
    metadata: { orgId: "1", product: "ptd-hosted" },
    ...over,
  };
}

/** Minimal Stripe event envelope. */
export function eventFixture(type: string, object: Record<string, unknown>, id = `evt_${Math.random().toString(36).slice(2, 10)}`) {
  return { id, object: "event", api_version: "2026-08-26.dahlia", created: Math.floor(Date.now() / 1000), type, data: { object } };
}
