import express, { type Express, type Request, type RequestHandler } from "express";

/**
 * Raw request bodies for signed webhooks.
 *
 * Slack, GitHub and Teams all sign the EXACT bytes they send, so the raw body has to
 * survive Express's global JSON/urlencoded parsers — and server/index.ts installs
 * those *before* any route exists. Once body-parser has run, the stream is gone and
 * the signed bytes are unrecoverable.
 *
 * This is the one slightly devious thing in the integrations layer, and it is shared
 * rather than copied three times: `mountRawBodyCapture(app, basePath)` moves one
 * `express.raw({type:"*\/*"})` layer to just before the first body parser in the
 * app's own router stack. Everything downstream then sees `req.body` as a Buffer for
 * that base path only, and the global parsers stand down (body-parser sets
 * `req._body` and later parsers skip an already-parsed request).
 */

/** 256 KiB is far above any slash command, issue payload or Teams message. */
export const RAW_BODY_LIMIT = "256kb";

interface RawBodyRequest extends Request {
  rawBody?: string;
}

/** The raw request body as a string, or null when something already parsed it away. */
export function rawBodyOf(req: Request): string | null {
  const r = req as RawBodyRequest;
  if (typeof r.rawBody === "string") return r.rawBody;
  const body: unknown = (req as { body?: unknown }).body;
  if (Buffer.isBuffer(body)) {
    r.rawBody = body.toString("utf8");
    return r.rawBody;
  }
  if (typeof body === "string" && body.length > 0) {
    r.rawBody = body;
    return r.rawBody;
  }
  return null;
}

/** body-parser names its middleware, which is how we find where parsing starts. */
const PARSER_NAMES = new Set(["jsonParser", "urlencodedParser", "textParser", "rawParser"]);

interface LayerLike {
  handle?: { name?: string };
}

function routerStack(app: Express): LayerLike[] | null {
  // Express 4 keeps the app router on _router; Express 5 exposes `router`.
  const holder = app as unknown as { _router?: { stack?: unknown }; router?: { stack?: unknown } };
  const stack = holder._router?.stack ?? holder.router?.stack;
  return Array.isArray(stack) ? (stack as LayerLike[]) : null;
}

/**
 * Capture the raw body for everything under `basePath`.
 *
 * Returns where the layer ended up, which the tests assert on. `appended` means the
 * app had no body parser to get in front of (fine — nothing will have eaten the
 * body) or that the parsers are the last layers in the stack, which is the case a
 * caller should warn about.
 */
export function mountRawBodyCapture(app: Express, basePath: string, name = "rawBodyCapture"): "before-parsers" | "appended" {
  const raw = express.raw({ type: "*/*", limit: RAW_BODY_LIMIT });
  const capture: RequestHandler = (req, res, next) => {
    raw(req, res, (err?: unknown) => {
      if (!err) rawBodyOf(req);
      next(err as never);
    });
  };
  Object.defineProperty(capture, "name", { value: name });
  app.use(basePath, capture);

  const stack = routerStack(app);
  if (!stack || stack.length === 0) return "appended";
  const firstParser = stack.findIndex((layer) => PARSER_NAMES.has(layer?.handle?.name ?? ""));
  if (firstParser === -1 || firstParser >= stack.length - 1) return "appended";
  const layer = stack.pop();
  if (!layer) return "appended";
  stack.splice(firstParser, 0, layer);
  return "before-parsers";
}
