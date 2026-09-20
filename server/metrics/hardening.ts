import { randomUUID } from "crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * The request-shaped half of the hardening: request identity, in-flight accounting
 * and the security headers.
 *
 * It lives here rather than in server/index.ts because importing that module *starts
 * a server* — it builds the app and listens at import time — and these are the pieces
 * worth unit-testing on their own (tests/scale/hardening.test.ts drives them through
 * supertest). server/index.ts is where they are wired, in order, and nowhere else.
 */

export const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * Trust an inbound id only if it looks like one: a proxy's request id is echoed into
 * every log line, so it has to be short and printable, and anything else is replaced
 * rather than sanitised (a half-kept id would correlate with nothing).
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestIdFrom(header: string | undefined): string {
  const candidate = (header ?? "").trim();
  return SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

export function requestIdOf(res: Response): string {
  return (res.locals?.requestId as string | undefined) ?? "";
}

let inFlight = 0;

/** How many requests are being served right now — what SIGTERM waits on. */
export function inFlightCount(): number {
  return inFlight;
}

/** Test seam: forget the in-flight count between cases. */
export function resetInFlight(): void {
  inFlight = 0;
}

/**
 * First middleware in the stack: stamp the request, count it, and — once the process
 * is draining — tell the client not to reuse the connection, so a keep-alive socket
 * cannot hold the server open past the last response.
 */
export function requestContext(isDraining: () => boolean = () => false): RequestHandler {
  return function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
    const requestId = requestIdFrom(req.header(REQUEST_ID_HEADER) ?? undefined);
    res.locals.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    inFlight += 1;
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      inFlight -= 1;
    };
    res.on("finish", release);
    res.on("close", release);

    if (isDraining()) res.setHeader("Connection", "close");
    next();
  };
}

/**
 * A conservative CSP the SPA actually runs under.
 *
 * What it has to allow, all of it verified in a headless browser against /overview:
 * the Google Fonts *stylesheet* (`style-src https://fonts.googleapis.com`) and the
 * font files it pulls (`font-src https://fonts.gstatic.com`), the inline styles React
 * and the Gantt view compute, and `blob:` — the client builds CSV and PDF downloads
 * with `createObjectURL`.
 *
 * In development Vite injects an inline module script and compiles with `eval`, so the
 * two unsafe script directives exist there and nowhere else. `PTD_CSP` replaces the
 * policy wholesale; `PTD_CSP=off` drops the header for someone debugging a third-party
 * embed.
 */
export function contentSecurityPolicy(env: string, override = process.env.PTD_CSP): string | null {
  if (override) return override.toLowerCase() === "off" ? null : override;
  const dev = env === "development";
  const scriptSrc = dev ? "'self' 'unsafe-inline' 'unsafe-eval' blob:" : "'self' blob:";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function securityHeaders(env: string): RequestHandler {
  return function security(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // Nothing in PTD asks for a camera, a microphone, a location or a payment sheet.
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    res.setHeader("X-Frame-Options", "DENY");
    const csp = contentSecurityPolicy(env);
    if (csp) res.setHeader("Content-Security-Policy", csp);
    next();
  };
}
