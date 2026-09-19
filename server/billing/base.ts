/**
 * Where to send a customer back to after Stripe.
 *
 * Actions receive an ActionContext, not the Express request, so the public base
 * URL is carried per-request in an AsyncLocalStorage that the billing middleware
 * fills from `baseUrl(req)`. Env and a last-resort constant cover the paths that
 * never see a request (a webhook-driven sync, a script).
 */
import { AsyncLocalStorage } from "node:async_hooks";

const requestBase = new AsyncLocalStorage<string>();

export const DEFAULT_PUBLIC_URL = "https://ptd.danimoya.com";

/** Path of the Org → Billing tab; override if the tab is mounted elsewhere. */
export function billingTabPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.PTD_BILLING_RETURN_PATH || "/org/billing").trim();
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function runWithRequestBase<T>(base: string, fn: () => T): T {
  return requestBase.run(base, fn);
}

export function currentBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromRequest = requestBase.getStore();
  const raw = fromRequest || env.PTD_PUBLIC_URL || DEFAULT_PUBLIC_URL;
  return raw.replace(/\/+$/, "");
}

/** `<base>/org/billing?tab=billing&checkout=success&session_id={CHECKOUT_SESSION_ID}` */
export function billingReturnUrl(
  params: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
  base = currentBaseUrl(env),
): string {
  // Stripe's `{CHECKOUT_SESSION_ID}` template must survive verbatim, so the
  // braces are restored after encoding rather than left percent-escaped.
  const query = Object.entries({ tab: "billing", ...params })
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%7B/g, "{").replace(/%7D/g, "}")}`)
    .join("&");
  return `${base}${billingTabPath(env)}?${query}`;
}
