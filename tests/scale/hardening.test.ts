import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// server/discovery.ts builds its manifest from the action registry, which reaches the
// database module at import time. Nothing here queries; the stub is there so the file
// can be imported without DATABASE_URL.
vi.mock("../../db", () => ({ db: {} }));
import {
  REQUEST_ID_HEADER,
  contentSecurityPolicy,
  inFlightCount,
  requestContext,
  requestIdFrom,
  resetInFlight,
  securityHeaders,
} from "../../server/metrics/hardening";
import { httpMetrics, httpRequests } from "../../server/metrics/http";
import { healthHandler, metricsHandler, resetHealthCache } from "../../server/metrics/health";
import { publicDocumentCors } from "../../server/discovery";
import { resetMetrics } from "../../server/metrics/registry";

/**
 * The hardening middlewares, driven through a real Express app.
 *
 * server/index.ts wires them in this order — request context, metrics, security
 * headers, body parsers — and cannot be imported here, because importing it starts a
 * listening server. What is asserted below is the order-independent behaviour: the
 * headers on the way out, the request id in both directions, the body ceiling, the
 * preflight answers and what health says when the database is unreachable.
 */

function appWith(options: { draining?: () => boolean; limit?: string } = {}) {
  const app = express();
  app.use(requestContext(options.draining ?? (() => false)));
  app.use(httpMetrics());
  app.use(securityHeaders("production"));
  app.use(express.json({ limit: options.limit ?? "6mb" }));
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  app.post("/api/echo", (req, res) => res.json({ got: req.body }));
  app.get("/api/tasks/:id", (_req, res) => res.json({ ok: true }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ message: "too large" });
    res.status(500).json({ message: "boom" });
  });
  return app;
}

beforeEach(() => {
  resetInFlight();
  resetMetrics();
  resetHealthCache();
  delete process.env.METRICS_TOKEN;
  delete process.env.PTD_CSP;
});

afterEach(() => {
  delete process.env.METRICS_TOKEN;
  delete process.env.PTD_CSP;
});

describe("X-Request-Id", () => {
  it("echoes an id the proxy already assigned", async () => {
    const res = await request(appWith()).get("/api/ping").set(REQUEST_ID_HEADER, "abc-123_XY");
    expect(res.headers["x-request-id"]).toBe("abc-123_XY");
  });

  it("generates one when there is none, and refuses a hostile one", async () => {
    const generated = await request(appWith()).get("/api/ping");
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);

    expect(requestIdFrom("has spaces")).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom("x".repeat(200))).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom("line\nbreak")).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom("keep-this.one:2")).toBe("keep-this.one:2");
  });
});

describe("security headers", () => {
  it("sets the four flat headers on every response", async () => {
    const res = await request(appWith()).get("/api/ping");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["permissions-policy"]).toContain("camera=()");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("ships a CSP that allows the Google Fonts stylesheet and the SPA's inline styles", async () => {
    const res = await request(appWith()).get("/api/ping");
    const csp = res.headers["content-security-policy"];
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com data:");
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).toContain("frame-ancestors 'none'");
    // Production must not hand out eval; development has to, because Vite uses it.
    expect(csp).toContain("script-src 'self' blob:");
    expect(csp).not.toContain("unsafe-eval");
    expect(contentSecurityPolicy("development")).toContain("'unsafe-eval'");
  });

  it("can be replaced or switched off from the environment", () => {
    expect(contentSecurityPolicy("production", "off")).toBeNull();
    expect(contentSecurityPolicy("production", "default-src 'none'")).toBe("default-src 'none'");
  });
});

describe("body limits", () => {
  it("accepts a body under the ceiling and answers 413 over it", async () => {
    const app = appWith({ limit: "1kb" });
    const small = await request(app).post("/api/echo").send({ a: "x".repeat(100) });
    expect(small.status).toBe(200);

    const big = await request(app).post("/api/echo").send({ a: "x".repeat(4000) });
    expect(big.status).toBe(413);
  });
});

describe("in-flight accounting", () => {
  it("returns to zero once the responses have finished", async () => {
    const app = appWith();
    await Promise.all([request(app).get("/api/ping"), request(app).get("/api/ping"), request(app).get("/api/ping")]);
    expect(inFlightCount()).toBe(0);
  });

  it("tells a client not to reuse the connection while draining", async () => {
    const res = await request(appWith({ draining: () => true })).get("/api/ping");
    expect(res.headers["connection"]).toBe("close");
  });
});

describe("request metrics", () => {
  it("counts by method, matched route pattern and status", async () => {
    const app = appWith();
    await request(app).get("/api/tasks/42");
    await request(app).get("/api/tasks/99");
    expect(httpRequests.get({ method: "GET", route: "/api/tasks/:id", status: 200 })).toBe(2);
  });
});

describe("CORS on the public documents", () => {
  it("answers the preflight itself and lets a GET through", async () => {
    const app = express();
    app.use("/.well-known", publicDocumentCors());
    app.get("/.well-known/thing.json", (_req, res) => res.json({ ok: true }));

    const preflight = await request(app).options("/.well-known/thing.json");
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    expect(preflight.headers["access-control-expose-headers"]).toContain("WWW-Authenticate");

    const get = await request(app).get("/.well-known/thing.json");
    expect(get.status).toBe(200);
    expect(get.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("health", () => {
  const app = (probe: () => Promise<any>) => {
    const a = express();
    a.get("/api/health", healthHandler({ probe }));
    return a;
  };

  it("is shallow and cheap by default — it never touches the database", async () => {
    let probed = 0;
    const res = await request(
      app(async () => {
        probed += 1;
        return { ok: true, latencyMs: 1, migrations: 4, connections: 2 };
      }),
    ).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(probed).toBe(0);
  });

  it("deep reports the migration count, the probe latency and this instance", async () => {
    const res = await request(app(async () => ({ ok: true, latencyMs: 3, migrations: 4, connections: 2 }))).get(
      "/api/health?deep=1",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", database: { ok: true, migrations: 4, connections: 2 } });
    expect(typeof res.body.instance).toBe("string");
  });

  it("answers 503 when the database does not", async () => {
    const res = await request(app(async () => ({ ok: false, latencyMs: 3000, migrations: null, connections: null, error: "timeout" }))).get(
      "/api/health?deep=true",
    );
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "degraded", database: { ok: false, error: "timeout" } });
  });

  it("caches the deep probe, so a keen monitor is not a load test", async () => {
    let probed = 0;
    const a = app(async () => {
      probed += 1;
      return { ok: true, latencyMs: 1, migrations: 4, connections: 1 };
    });
    await request(a).get("/api/health?deep=1");
    await request(a).get("/api/health?deep=1");
    expect(probed).toBe(1);
  });
});

describe("the metrics endpoint", () => {
  const app = () => {
    const a = express();
    a.get("/api/metrics", metricsHandler());
    return a;
  };

  it("serves the exposition format to a loopback client", async () => {
    const res = await request(app()).get("/api/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toContain("# TYPE ");
  });

  it("refuses a forwarded request, and wants the token once one is set", async () => {
    const forwarded = await request(app()).get("/api/metrics").set("X-Forwarded-For", "203.0.113.9");
    expect(forwarded.status).toBe(403);

    process.env.METRICS_TOKEN = "scrape-me";
    const anonymous = await request(app()).get("/api/metrics");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toContain("Bearer");

    const authorised = await request(app()).get("/api/metrics").set("Authorization", "Bearer scrape-me");
    expect(authorised.status).toBe(200);
  });
});
