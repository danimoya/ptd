import { timingSafeEqual } from "crypto";
import { hostname } from "os";
import type { Express, Request, RequestHandler, Response } from "express";
import { sql } from "drizzle-orm";
import { publishDbProbe, publishPoolMax, lastDbProbe } from "./runtime";
import { renderMetrics } from "./registry";

/**
 * `/api/health` and `/api/metrics`.
 *
 * Health has two depths on purpose. The plain call answers as soon as the HTTP
 * server is up and is what the image's HEALTHCHECK and any dumb uptime monitor
 * should poll — it must not depend on the database, or a database blip would make
 * Docker kill a process that is serving the SPA perfectly well. `?deep=1` is the
 * one that runs `SELECT 1`, counts applied migrations, and answers 503 when the
 * database is unreachable: that is the readiness check a load balancer in front of
 * several replicas wants.
 *
 * Metrics are guarded two ways: a bearer token when `METRICS_TOKEN` is set, and
 * otherwise loopback only. "Loopback" means the *socket* address, not `req.ip` —
 * `trust proxy` makes `req.ip` a header value, and a header must never be able to
 * open an endpoint. A request that carries `X-Forwarded-For` is refused as well,
 * because a proxy on the same host would otherwise hand the whole internet a
 * loopback connection; behind a proxy, set `METRICS_TOKEN`.
 */

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const PROBE_TIMEOUT_MS = 3_000;
/** A deep probe is cached this long, so a keen monitor cannot become a load test. */
const PROBE_CACHE_MS = 5_000;

export interface DbProbe {
  ok: boolean;
  latencyMs: number;
  migrations: number | null;
  connections: number | null;
  error?: string;
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Imported lazily: the health module is unit-tested without a database. */
async function database() {
  return (await import("../../db")).db;
}

export async function probeDatabase(): Promise<DbProbe> {
  const started = Date.now();
  try {
    const db = await database();
    const rows = await withTimeout(
      db.execute<{ one: number; migrations: unknown; connections: unknown }>(
        sql`SELECT 1 AS one, (SELECT count(*) FROM _migrations) AS migrations, (SELECT count(*) FROM pg_stat_activity) AS connections`,
      ),
      PROBE_TIMEOUT_MS,
      "database probe",
    );
    const row = (rows as unknown as Record<string, unknown>[])[0] ?? {};
    const probe: DbProbe = {
      ok: true,
      latencyMs: Date.now() - started,
      migrations: row.migrations === undefined ? null : Number(row.migrations),
      connections: row.connections === undefined ? null : Number(row.connections),
    };
    publishDbProbe({ ok: true, durationMs: probe.latencyMs, at: Date.now(), serverConnections: probe.connections });
    return probe;
  } catch (err) {
    const probe: DbProbe = {
      ok: false,
      latencyMs: Date.now() - started,
      migrations: null,
      connections: null,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
    publishDbProbe({ ok: false, durationMs: probe.latencyMs, at: Date.now(), serverConnections: null });
    return probe;
  }
}

let cached: { at: number; probe: DbProbe } | null = null;

async function cachedProbe(probe: () => Promise<DbProbe>): Promise<DbProbe> {
  const now = Date.now();
  if (cached && now - cached.at < PROBE_CACHE_MS) return cached.probe;
  const fresh = await probe();
  cached = { at: now, probe: fresh };
  return fresh;
}

export interface HealthDeps {
  probe?: () => Promise<DbProbe>;
  now?: () => number;
  version?: string;
}

const bootedAt = Date.now();

/**
 * `GET /api/health` — shallow by default, `?deep=1` (or `?deep=true`) to include the
 * database. Deep and unhealthy answers 503; shallow always answers 200 while the
 * process is serving.
 */
export function healthHandler(deps: HealthDeps = {}): RequestHandler {
  const probe = deps.probe ?? probeDatabase;
  const now = deps.now ?? (() => Date.now());
  return async (req: Request, res: Response) => {
    const uptimeSeconds = Math.round(((now() - bootedAt) / 1000) * 1000) / 1000;
    const deep = req.query.deep === "1" || req.query.deep === "true";
    if (!deep) return res.json({ status: "ok", uptimeSeconds });

    const db = await cachedProbe(probe);
    res.status(db.ok ? 200 : 503).json({
      status: db.ok ? "ok" : "degraded",
      uptimeSeconds,
      instance: hostname(),
      version: deps.version ?? process.env.PTD_VERSION ?? "0.1.0",
      database: db,
    });
  };
}

/** Test seam: drop the cached deep probe. */
export function resetHealthCache(): void {
  cached = null;
}

/* ── metrics endpoint ────────────────────────────────────────────────────── */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return LOOPBACK.has(address) || address.startsWith("127.");
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  const presented = (header ?? "").replace(/^Bearer\s+/i, "");
  if (presented.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  } catch {
    return false;
  }
}

export interface MetricsGuardResult {
  allowed: boolean;
  status: number;
  reason: string;
}

/** The whole access decision, so a test can assert it without an HTTP server. */
export function metricsGuard(input: {
  authorization?: string;
  socketAddress?: string;
  forwarded?: string;
  token?: string;
}): MetricsGuardResult {
  const token = input.token ?? "";
  if (token) {
    return tokenMatches(input.authorization, token)
      ? { allowed: true, status: 200, reason: "token" }
      : { allowed: false, status: 401, reason: "bad_token" };
  }
  if (input.forwarded) return { allowed: false, status: 403, reason: "forwarded" };
  if (!isLoopback(input.socketAddress)) return { allowed: false, status: 403, reason: "not_loopback" };
  return { allowed: true, status: 200, reason: "loopback" };
}

export function metricsHandler(): RequestHandler {
  return (req: Request, res: Response) => {
    const guard = metricsGuard({
      authorization: req.header("authorization") ?? undefined,
      socketAddress: req.socket?.remoteAddress ?? undefined,
      forwarded: req.header("x-forwarded-for") ?? undefined,
      token: process.env.METRICS_TOKEN ?? "",
    });
    if (!guard.allowed) {
      if (guard.status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="ptd-metrics"');
      return res.status(guard.status).type("text/plain").send(`metrics: ${guard.reason}\n`);
    }
    res.setHeader("Content-Type", METRICS_CONTENT_TYPE);
    res.setHeader("Cache-Control", "no-store");
    res.send(renderMetrics());
  };
}

/**
 * Wire both endpoints. Called from server/routes.ts *before* the `/api` rate limiter,
 * so a 15-second scrape and a monitor polling health cannot spend the API budget of
 * whatever address they share.
 */
export function registerObservability(app: Express): void {
  app.get("/api/health", healthHandler());
  app.get("/api/metrics", metricsHandler());
}

export { lastDbProbe, publishPoolMax };
