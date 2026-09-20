import type { NextFunction, Request, Response } from "express";
import { Counter, Gauge, Histogram, type LabelValues } from "./registry";

/**
 * HTTP and action instrumentation.
 *
 * The label that decides whether this endpoint is useful or a cardinality bomb is
 * `route`. Express knows the pattern a request matched — but only *after* the router
 * has run, which is exactly when `res.on("finish")` fires, so the middleware reads
 * `req.route` then and falls back to a normalised path (ids, hashes and tokens
 * replaced by placeholders) for the requests no route claimed.
 */

export const httpRequests = new Counter(
  "ptd_http_requests_total",
  "HTTP requests handled, by method, matched route and response status.",
);
export const httpDuration = new Histogram(
  "ptd_http_request_duration_seconds",
  "Time from the first middleware to the response finishing, by method and matched route.",
);
export const httpInFlight = new Gauge("ptd_http_requests_in_flight", "Requests currently being served.");
export const httpResponseBytes = new Counter(
  "ptd_http_response_bytes_total",
  "Bytes written as response bodies, by matched route (Content-Length only).",
);

export const actionCalls = new Counter(
  "ptd_action_calls_total",
  "Registry actions invoked, by action name, calling surface and outcome.",
);

/** Where an action call came in: the REST face, or an MCP tool call. */
export type ActionSurface = "http" | "mcp";
export type ActionOutcome = "ok" | "refused" | "error";

export function recordAction(name: string, surface: ActionSurface, outcome: ActionOutcome): void {
  actionCalls.inc({ action: name.slice(0, 64), surface, outcome });
}

/** 2xx/3xx is ok, 4xx is the caller's fault ("refused"), 5xx is ours. */
export function outcomeForStatus(status: number): ActionOutcome {
  if (status >= 500) return "error";
  if (status >= 400) return "refused";
  return "ok";
}

const HEX = /^[0-9a-f]{8,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path with its variable parts flattened: `/api/tasks/42` → `/api/tasks/:n`,
 * `/api/ical/ptd_abc…/me.ics` → `/api/ical/:token/me.ics`. Anything that survives
 * is a literal segment the app actually routes on.
 */
export function normalisePath(path: string): string {
  const segments = path.split("/").map((segment) => {
    if (segment === "") return segment;
    if (/^\d+$/.test(segment)) return ":n";
    if (UUID.test(segment)) return ":uuid";
    if (segment.startsWith("ptd_")) return ":token";
    if (HEX.test(segment)) return ":hex";
    if (segment.length > 40) return ":long";
    return segment;
  });
  const out = segments.join("/");
  return out.length > 120 ? `${out.slice(0, 117)}...` : out;
}

/** The route pattern Express matched, e.g. `/api/actions/:name`, else a normalised path. */
export function routeOf(req: Request): string {
  const route = (req as Request & { route?: { path?: string } }).route;
  const pattern = typeof route?.path === "string" ? route.path : null;
  // No matched route (a `use` middleware answered, or nothing did): `req.path` is
  // relative to the mount point, so the full URL is the honest label.
  if (!pattern) return normalisePath((req.originalUrl || req.path).split("?")[0]);
  const base = (req.baseUrl ?? "").replace(/\/+$/, "");
  const joined = pattern === "/" ? base || "/" : `${base}${pattern}`;
  return normalisePath(joined);
}

/** `/api/actions/<name>` → the action name, for the action counter. */
function actionNameOf(req: Request): string | null {
  const match = /^\/api\/actions\/([A-Za-z0-9_.]{1,64})$/.exec(req.path);
  return req.method === "POST" && match ? match[1] : null;
}

/**
 * One middleware, mounted first, that times every request. It writes no log line —
 * that is server/index.ts's business — and never touches the response.
 */
export function httpMetrics() {
  return function metrics(req: Request, res: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    httpInFlight.inc();
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      httpInFlight.dec();
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = routeOf(req);
      const labels: LabelValues = { method: req.method, route };
      httpDuration.observe(seconds, labels);
      httpRequests.inc({ ...labels, status: res.statusCode });
      const length = Number(res.getHeader("content-length") ?? 0);
      if (Number.isFinite(length) && length > 0) httpResponseBytes.inc({ route }, length);

      const action = actionNameOf(req);
      if (action) recordAction(action, "http", outcomeForStatus(res.statusCode));
    };

    res.on("finish", finish);
    // A client that hangs up mid-response never fires "finish"; without this the
    // in-flight gauge would drift upwards for the lifetime of the process.
    res.on("close", finish);
    next();
  };
}
