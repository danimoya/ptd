/**
 * A hand-rolled Stripe REST client.
 *
 * PTD ships no `stripe` npm dependency on purpose: billing is a hosted-only
 * concern and self-hosters must not carry (or audit) a payment SDK they never
 * call. Everything Stripe needs from us is form-encoded HTTP, so `fetch` is
 * enough. `fetchImpl` is injectable so tests drive a stub instead of the network.
 */

/**
 * Pinned on purpose: an unpinned integration silently changes shape when Stripe
 * ships a new version. Bump deliberately, with the webhook fixtures re-recorded.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";
export const STRIPE_API_BASE = "https://api.stripe.com";

/** Dashboard label for this checkout flow (Stripe asks for an 8-letter suffix). */
export const INTEGRATION_IDENTIFIER = "ptd-hosted-org-qkvmzrhd";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly stripeType?: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/** Thrown when the deployment claims to be hosted but has no key configured. */
export class StripeNotConfiguredError extends Error {
  constructor(message = "Stripe is not configured (STRIPE_SECRET_KEY is unset)") {
    super(message);
    this.name = "StripeNotConfiguredError";
  }
}

function appendField(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => appendField(params, `${key}[${i}]`, item));
    return;
  }
  if (value instanceof Date) {
    params.append(key, String(Math.floor(value.getTime() / 1000)));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) appendField(params, `${key}[${k}]`, v);
    return;
  }
  params.append(key, String(value));
}

/**
 * Stripe's flavour of form encoding: nested objects and arrays become
 * `line_items[0][price]`, booleans become `true`/`false`, undefined/null keys
 * are dropped rather than sent empty.
 */
export function encodeForm(data: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) appendField(params, key, value);
  return params.toString();
}

export interface StripeClientOptions {
  secretKey: string;
  apiBase?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  apiVersion?: string;
}

export interface StripeRequestOptions {
  /** Sent as `Idempotency-Key`; makes a retried POST safe. */
  idempotencyKey?: string;
}

export class StripeClient {
  /** Kept private so no stack trace, log line or JSON dump can carry the key. */
  readonly #secretKey: string;
  readonly #apiBase: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly apiVersion: string;

  constructor(opts: StripeClientOptions) {
    if (!opts.secretKey) throw new StripeNotConfiguredError();
    this.#secretKey = opts.secretKey;
    this.#apiBase = (opts.apiBase || STRIPE_API_BASE).replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
    this.apiVersion = opts.apiVersion || STRIPE_API_VERSION;
  }

  async request<T = Record<string, unknown>>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, unknown> = {},
    opts: StripeRequestOptions = {},
  ): Promise<T> {
    const body = method === "GET" ? undefined : encodeForm(params);
    const query = method === "GET" ? encodeForm(params) : "";
    const url = `${this.#apiBase}${path}${query ? `?${query}` : ""}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#secretKey}`,
      "Stripe-Version": this.apiVersion,
      "User-Agent": "ptd-billing/1 (fetch)",
    };
    if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new StripeError(controller.signal.aborted ? `Stripe request timed out after ${this.#timeoutMs}ms` : message, 0);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      const error = (parsed as { error?: { message?: string; code?: string; type?: string } } | null)?.error;
      throw new StripeError(error?.message || `Stripe responded ${res.status}`, res.status, error?.code, error?.type);
    }
    return (parsed ?? {}) as T;
  }

  post<T = Record<string, unknown>>(path: string, params: Record<string, unknown> = {}, opts: StripeRequestOptions = {}) {
    return this.request<T>("POST", path, params, opts);
  }

  get<T = Record<string, unknown>>(path: string, params: Record<string, unknown> = {}) {
    return this.request<T>("GET", path, params);
  }
}

export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_API_BASE?: string;
  [key: string]: string | undefined;
}

/**
 * Build a client from the process environment. `STRIPE_API_BASE` exists so a
 * local stub can stand in for api.stripe.com during development.
 */
export function stripeFromEnv(env: StripeEnv = process.env, fetchImpl?: FetchLike): StripeClient {
  return new StripeClient({
    secretKey: env.STRIPE_SECRET_KEY ?? "",
    apiBase: env.STRIPE_API_BASE,
    fetchImpl,
  });
}

/** For log lines: `sk_live_…4f2a`, never the key itself. */
export function redactKey(key: string | undefined): string {
  if (!key) return "(unset)";
  const head = key.slice(0, key.startsWith("rk_") || key.startsWith("sk_") ? 8 : 4);
  return `${head}…${key.slice(-4)}`;
}
