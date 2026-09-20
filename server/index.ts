import express, { type Request, Response, NextFunction } from "express";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import type { Server } from "http";
import { registerRoutes } from "./routes";
import { httpMetrics } from "./metrics/http";
import {
  contentSecurityPolicy,
  inFlightCount,
  requestContext,
  requestIdOf,
  securityHeaders,
} from "./metrics/hardening";
import { setWebSocketSource, startRuntimeMetrics, publishPoolMax } from "./metrics/runtime";
import { getWebSocketManager } from "./websocket";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* ── logging ─────────────────────────────────────────────────────────────── */

/**
 * Two shapes, one call site. `LOG_FORMAT=json` emits one JSON object per line —
 * what a log shipper wants — and anything else keeps the human-readable line PTD
 * has always printed. Both carry the request id when there is one, so a line in the
 * app log and a line in the proxy log can be matched up.
 */
const JSON_LOGS = (process.env.LOG_FORMAT ?? "").toLowerCase() === "json";

export interface LogFields {
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export function log(message: string, source = "express", fields: LogFields = {}) {
  if (JSON_LOGS) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", source, msg: message, ...fields }));
    return;
  }
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const id = fields.requestId ? ` [${fields.requestId}]` : "";
  console.log(`${formattedTime} [${source}]${id} ${message}`);
}

export function logError(message: string, fields: LogFields = {}) {
  if (JSON_LOGS) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", source: "express", msg: message, ...fields }));
    return;
  }
  const id = fields.requestId ? ` [${fields.requestId}]` : "";
  console.error(`[express]${id} ${message}`, fields.error ?? "");
}

/* ── static client ───────────────────────────────────────────────────────── */

function serveStatic(app: express.Express) {
  // Built layout: dist/server/index.js next to dist/public (vite output).
  const distPath = path.resolve(__dirname, "..", "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Build directory not found: ${distPath}. Run "npm run build" first.`
    );
  }
  app.use(express.static(distPath));
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

const app = express();
// Behind NPM / nginx — trust the single forwarding hop so real client IPs
// flow through to rate-limit, logging, and cookies.
app.set("trust proxy", 1);
app.disable("x-powered-by");

/** Set by SIGTERM: health starts failing and connections stop being reused. */
let draining = false;

// First in the stack: X-Request-Id (inbound or generated, echoed on the response and
// on every log line) and the in-flight count that the drain waits on.
app.use(requestContext(() => draining));

/**
 * While draining, health says so and answers 503 — a load balancer in front of
 * several replicas then stops sending new work before the process disappears.
 */
app.use("/api/health", (_req, res, next) => {
  if (!draining) return next();
  res.status(503).json({ status: "draining" });
});

app.use(httpMetrics());
app.use(securityHeaders(app.get("env")));

/**
 * Body limits. The CSV importer accepts a 5 MB file inside a JSON body, so the
 * ceiling has to clear that; attachment uploads have their own `express.raw` layer
 * with its own (larger) limit and are not affected by this one.
 */
const BODY_LIMIT = process.env.PTD_BODY_LIMIT || "6mb";
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));

app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;
  let capturedJsonResponse: Record<string, any> | undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api")) {
      const fields = {
        requestId: requestIdOf(res),
        method: req.method,
        path: reqPath,
        status: res.statusCode,
        durationMs: duration,
      };
      if (JSON_LOGS) {
        log("request", "express", fields);
        return;
      }
      let logLine = `${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) logLine = logLine.slice(0, 79) + "…";
      log(logLine, "express", fields);
    }
  });

  next();
});

/* ── graceful shutdown ───────────────────────────────────────────────────── */

/** Total budget is ten seconds: drain, then close the pool, then exit regardless. */
const DRAIN_TIMEOUT_MS = Number(process.env.PTD_SHUTDOWN_TIMEOUT_MS ?? 8000);
const HARD_EXIT_MS = 10_000;

async function shutdown(server: Server, signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  log(`${signal} received — draining (${inFlightCount()} request${inFlightCount() === 1 ? "" : "s"} in flight)`, "shutdown");

  // Nothing new gets accepted; idle keep-alive sockets are closed immediately so
  // the drain waits for real work only.
  server.close();
  server.closeIdleConnections?.();

  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  const hard = setTimeout(() => {
    logError("shutdown timed out — exiting anyway");
    process.exit(1);
  }, HARD_EXIT_MS);
  hard.unref();

  while (inFlightCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (inFlightCount() > 0) {
    log(`${inFlightCount()} request(s) still running after ${DRAIN_TIMEOUT_MS}ms — closing anyway`, "shutdown");
  }

  // WebSocket connections are upgraded sockets: server.close() leaves them alone,
  // so they are dropped here and the client reconnects to another instance.
  server.closeAllConnections?.();

  try {
    const { createPool } = await import("../db/connection");
    await createPool().end({ timeout: 3 });
    log("database pool closed", "shutdown");
  } catch (err) {
    logError("closing the database pool failed", { error: err instanceof Error ? err.message : err });
  }

  clearTimeout(hard);
  log("bye", "shutdown");
  process.exit(0);
}

(async () => {
  const server = registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    const requestId = requestIdOf(res);
    // Body-parser's own error: answer it as a 413 rather than a bare 500.
    if (err.type === "entity.too.large") {
      logError(`request body over ${BODY_LIMIT}`, { requestId });
      if (!res.headersSent) res.status(413).json({ message: `Request body too large (limit ${BODY_LIMIT}).`, requestId });
      return;
    }
    logError(message, { requestId, status, error: err instanceof Error ? err.stack : err });
    // Answer, then stop: rethrowing here (as this handler used to) reaches Express's
    // default handler with the response already sent, which destroys the socket.
    if (!res.headersSent) res.status(status).json({ message, requestId });
  });

  if (app.get("env") === "development") {
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  startRuntimeMetrics();
  setWebSocketSource(() => {
    const manager = getWebSocketManager();
    if (!manager) return null;
    const users = manager.getConnectedUsers();
    return { users: users.length, clients: users.reduce((total, id) => total + manager.getUserConnectionCount(id), 0) };
  });
  try {
    const { createPool } = await import("../db/connection");
    publishPoolMax(Number(createPool().options.max ?? 0));
  } catch {
    // No database configured yet: the gauge simply stays unset.
  }

  const PORT = Number(process.env.PORT) || 3001;
  server.listen(PORT, "0.0.0.0", () => {
    log(`Server running on port ${PORT}`);
    log(
      `hardening: body limit ${BODY_LIMIT}, CSP ${contentSecurityPolicy(app.get("env")) ? "on" : "off"}, ` +
        `metrics ${process.env.METRICS_TOKEN ? "bearer-token" : "loopback-only"}, logs ${JSON_LOGS ? "json" : "text"}`,
    );
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdown(server, signal);
    });
  }
})();
