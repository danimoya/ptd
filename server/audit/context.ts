/**
 * Who is calling, from where — carried per request so the audit log can record an
 * IP even from code that never sees the Express request.
 *
 * Actions receive an ActionContext, not a `req`; the registry hook that writes an
 * audit row therefore has no access to the socket. An AsyncLocalStorage filled by
 * one middleware (registered from `registerAuthRoutes`, ahead of every route that
 * can mutate anything) closes that gap without threading a parameter through the
 * whole action surface. The same trick the billing base URL already uses.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

export interface RequestFacts {
  ip: string | null;
  userAgent: string | null;
  path: string | null;
}

const store = new AsyncLocalStorage<RequestFacts>();

/** `req.ip` honours `trust proxy`, so this is the client address, not the proxy's. */
export function factsOf(req: Request): RequestFacts {
  const ip = (req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "") || null;
  return { ip, userAgent: req.header("User-Agent")?.slice(0, 200) ?? null, path: req.path ?? null };
}

export function auditContextMiddleware() {
  return function ptdAuditContext(req: Request, _res: Response, next: NextFunction) {
    store.run(factsOf(req), () => next());
  };
}

export function currentRequestFacts(): RequestFacts | null {
  return store.getStore() ?? null;
}

export function withRequestFacts<T>(facts: RequestFacts, fn: () => T): T {
  return store.run(facts, fn);
}
