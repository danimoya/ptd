/**
 * The only billing HTTP surface: Stripe's webhook. Everything a browser can do
 * goes through the action registry, so the role gate cannot be bypassed.
 *
 * Two problems this file solves:
 *
 * 1. *Raw body.* Signature verification needs the exact bytes Stripe sent, but
 *    `server/index.ts` mounts `express.json()` before any route is registered, and
 *    body-parser consumes the stream once. So the webhook's `express.raw` layer is
 *    registered here and then moved to the front of the router stack, ahead of the
 *    JSON parser. body-parser marks `req._body`, which makes the later JSON parser
 *    skip the request instead of fighting over the stream.
 * 2. *Public base URL.* Actions get an ActionContext, not the request, so the same
 *    front-of-stack middleware records `baseUrl(req)` in an AsyncLocalStorage for
 *    the lifetime of the request; `billing.checkout` reads it from there.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { baseUrl } from "../discovery";
import { runWithRequestBase } from "./base";
import { isHosted } from "./service";
import { constructEvent, handleStripeEvent } from "./webhook";

export const BILLING_WEBHOOK_PATH = "/api/billing/webhook";

type RawRequest = Request & { rawBody?: Buffer };

/** The exact bytes of the request, if any layer managed to keep them. */
export function rawBodyOf(req: Request): Buffer | string | null {
  const r = req as RawRequest;
  if (Buffer.isBuffer(r.rawBody)) return r.rawBody;
  const body: unknown = r.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string" && body.length > 0) return body;
  return null;
}

export function billingRequestMiddleware() {
  const raw = express.raw({ type: "application/json", limit: "1mb" });
  return function ptdBillingRequest(req: Request, res: Response, next: NextFunction) {
    runWithRequestBase(baseUrl(req), () => {
      if (req.method !== "POST" || req.path !== BILLING_WEBHOOK_PATH) return next();
      raw(req, res, (err?: unknown) => {
        if (err) return next(err as Error);
        if (Buffer.isBuffer(req.body)) (req as RawRequest).rawBody = req.body;
        next();
      });
    });
  };
}

/**
 * Move a just-registered middleware ahead of everything except express's own
 * `query` / `expressInit` layers. Returns false if the router shape is not what
 * we expect, in which case the webhook still works for any host that sets
 * `req.rawBody` itself — and says so loudly at boot.
 */
export function hoistToFrontOfStack(app: Express, handler: unknown): boolean {
  const stack = (app as unknown as { _router?: { stack?: { name?: string; handle?: unknown }[] } })._router?.stack;
  if (!Array.isArray(stack)) return false;
  const index = stack.findIndex((layer) => layer?.handle === handler);
  if (index < 0) return false;
  const [layer] = stack.splice(index, 1);
  let insertAt = 0;
  while (insertAt < stack.length && (stack[insertAt]?.name === "query" || stack[insertAt]?.name === "expressInit")) insertAt++;
  stack.splice(insertAt, 0, layer);
  return true;
}

export function registerBillingRoutes(app: Express): void {
  // Self-hosters get no route, no Stripe call, no billing surface whatsoever.
  if (!isHosted()) return;

  const middleware = billingRequestMiddleware();
  app.use(middleware);
  if (!hoistToFrontOfStack(app, middleware)) {
    console.warn("[billing] could not hoist the raw-body middleware ahead of express.json(); webhook signature checks need req.rawBody from the host");
  }

  app.post(BILLING_WEBHOOK_PATH, async (req: Request, res: Response) => {
    const raw = rawBodyOf(req);
    if (!raw) {
      console.error("[billing] webhook received without a raw body — signature cannot be verified");
      return res.status(400).json({ error: "raw_body_unavailable" });
    }

    const parsed = constructEvent(raw, req.header("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET);
    if (!parsed.ok) {
      console.warn(`[billing] rejected webhook: ${parsed.error}`);
      return res.status(400).json({ error: "invalid_signature", message: parsed.error });
    }

    // handleStripeEvent never throws and does at most one Stripe read, so it is
    // awaited: Stripe sees the 200 only once the state is actually applied, which
    // keeps its retries meaningful instead of cosmetic.
    const result = await handleStripeEvent(parsed.event);
    res.status(200).json(result);
  });
}
