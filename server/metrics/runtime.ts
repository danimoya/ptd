import { monitorEventLoopDelay, type IntervalHistogram } from "perf_hooks";
import { Counter, Gauge, registerCollector } from "./registry";

/**
 * Process, event-loop, database-pool and WebSocket gauges.
 *
 * All of these are *read* at scrape time rather than accumulated, so they are
 * registered as collectors: `renderMetrics()` calls them, they set their gauges, and
 * nothing runs on a timer except the event-loop histogram (which is a libuv counter,
 * not a JavaScript timer).
 */

const startedAt = Date.now();

const uptime = new Gauge("ptd_uptime_seconds", "Seconds since this process started serving.");
const rss = new Gauge("process_resident_memory_bytes", "Resident set size of this process.");
const heapUsed = new Gauge("nodejs_heap_size_used_bytes", "V8 heap in use.");
const heapTotal = new Gauge("nodejs_heap_size_total_bytes", "V8 heap reserved.");
const external = new Gauge("nodejs_external_memory_bytes", "Memory held outside the V8 heap (buffers).");
const cpuSeconds = new Counter("process_cpu_seconds_total", "User + system CPU time consumed by this process.");
const startTime = new Gauge("process_start_time_seconds", "Unix epoch second this process started.");
const handles = new Gauge("nodejs_active_handles", "Active libuv handles, by type.");
const loopLag = new Gauge("nodejs_eventloop_lag_seconds", "Event-loop delay over the life of the process, by quantile.");
const buildInfo = new Gauge("ptd_build_info", "1, labelled with the Node version and NODE_ENV of the running process.");

const dbPoolMax = new Gauge("ptd_db_pool_max", "Configured ceiling on the app's database connection pool.");
const dbServerConnections = new Gauge(
  "ptd_db_server_connections",
  "Connections the database reports (pg_stat_activity), from the cached deep health probe.",
);
const dbUp = new Gauge("ptd_db_up", "1 when the last database probe answered, 0 when it failed.");
const dbProbeSeconds = new Gauge("ptd_db_probe_duration_seconds", "How long the last database probe took.");
const dbProbeAge = new Gauge("ptd_db_probe_age_seconds", "Age of the cached database probe.");

const wsClients = new Gauge("ptd_websocket_clients", "Open WebSocket connections on this instance.");
const wsUsers = new Gauge("ptd_websocket_users", "Distinct users with at least one open WebSocket on this instance.");

let loop: IntervalHistogram | null = null;
let lastCpu = process.cpuUsage();

/**
 * Start the event-loop monitor. Called once from server/index.ts — not at import
 * time, because a unit test that imports the registry should not leave a libuv
 * histogram running.
 */
export function startRuntimeMetrics(): void {
  if (loop) return;
  loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
}

export interface DbProbeSnapshot {
  ok: boolean;
  durationMs: number;
  at: number;
  serverConnections: number | null;
}

let probe: DbProbeSnapshot | null = null;

/** The deep health check publishes its result here, so a scrape costs no query. */
export function publishDbProbe(snapshot: DbProbeSnapshot): void {
  probe = snapshot;
}

export function lastDbProbe(): DbProbeSnapshot | null {
  return probe;
}

/** Set once at startup: the pool size the app was configured with. */
export function publishPoolMax(max: number): void {
  dbPoolMax.set(max);
}

type WsSource = () => { clients: number; users: number } | null;
let wsSource: WsSource = () => null;

/** server/index.ts wires this to the WebSocket manager, which routes.ts creates. */
export function setWebSocketSource(source: WsSource): void {
  wsSource = source;
}

function countHandles(): void {
  const active = (process as unknown as { _getActiveHandles?: () => { constructor?: { name?: string } }[] })._getActiveHandles;
  if (typeof active !== "function") return;
  const byType = new Map<string, number>();
  for (const handle of active.call(process)) {
    const type = handle?.constructor?.name ?? "unknown";
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  for (const [type, count] of byType) handles.set(count, { type });
}

registerCollector(() => {
  const now = Date.now();
  uptime.set((now - startedAt) / 1000);
  startTime.set(Math.floor((now - process.uptime() * 1000) / 1000));
  buildInfo.set(1, { node: process.versions.node, env: process.env.NODE_ENV ?? "development" });

  const mem = process.memoryUsage();
  rss.set(mem.rss);
  heapUsed.set(mem.heapUsed);
  heapTotal.set(mem.heapTotal);
  external.set(mem.external);

  // cpuUsage() is cumulative-since-start, but taking the delta keeps the counter
  // monotonic even if a future caller resets it.
  const cpu = process.cpuUsage();
  const deltaUs = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
  lastCpu = cpu;
  if (deltaUs > 0) cpuSeconds.inc({}, deltaUs / 1e6);

  if (loop) {
    loopLag.set(loop.mean / 1e9, { quantile: "mean" });
    loopLag.set(loop.percentile(99) / 1e9, { quantile: "0.99" });
    loopLag.set(loop.max / 1e9, { quantile: "max" });
  }

  countHandles();

  if (probe) {
    dbUp.set(probe.ok ? 1 : 0);
    dbProbeSeconds.set(probe.durationMs / 1000);
    dbProbeAge.set((now - probe.at) / 1000);
    if (probe.serverConnections !== null) dbServerConnections.set(probe.serverConnections);
  }

  const ws = wsSource();
  if (ws) {
    wsClients.set(ws.clients);
    wsUsers.set(ws.users);
  }
});
