import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import {
  endpointUrl,
  loadInstall,
  telemetryEnvOverride,
  telemetryIsEnabled,
  updateCheckUrl,
  updateInstall,
  type InstallRecord,
  type PingOutcome,
} from "./install";

/**
 * Installation telemetry, and the update check — two clearly separated things,
 * both off by default, mirroring Claude-Dashboard's
 * `backend/src/services/telemetry.service.ts` field for field.
 *
 *   1. checkUpdates() — GETs a public release feed and reports the latest
 *      published version. **Sends no client payload.** Pure GET.
 *
 *   2. ping() — submits the install ping. **Only runs when the operator has
 *      explicitly opted in.** The payload is exactly:
 *         { installation_id, dashboard_version, heliosdb_version, timestamp }
 *      No IP, no username, no email, no hostname, no OS or architecture, no
 *      organization names, no counts, no task or session content. The receiver
 *      hashes `salt|week|ip|installation_id` and stores neither the IP nor the
 *      raw id (see `docs/self-hosting.md` § Telemetry), but PTD never sends a
 *      re-identifiable address in the first place.
 *
 * The payload is exposed by `buildPayload()` so the UI can show the operator the
 * exact bytes *before* they opt in — the same transparency contract the
 * dashboard's /telemetry page makes.
 *
 * `dashboard_version` carries the product tag `ptd/<version>`: the receiver is
 * shared across the family and keys its per-version breakdown on this field, so
 * the prefix is what tells a PTD install apart from a dashboard install without
 * the receiver needing to change.
 */

/** Exactly four keys. Anything added here is a policy change, not a refactor. */
export interface TelemetryPayload {
  installation_id: string;
  dashboard_version: string;
  heliosdb_version: string | null;
  timestamp: string;
}

export interface TelemetryStatus {
  installationId: string;
  telemetryEnabled: boolean;
  updateChecksEnabled: boolean;
  /** True when PTD_TELEMETRY pins the ping toggle, so the UI can say the file is not in charge. */
  envPinned: boolean;
  decided: boolean;
  decidedAt: string | null;
  lastPingAt: string | null;
  lastPingResult: PingOutcome | null;
  lastUpdateCheckAt: string | null;
  latestVersionSeen: string | null;
  version: string;
  endpoint: string;
  updateCheckUrl: string;
  nextPingDueAt: string | null;
}

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  upgradeAvailable: boolean;
  notes: string | null;
  fetchedAt: string;
  url: string | null;
}

export interface TelemetryPingResult {
  ok: boolean;
  sentAt: string;
  payload: TelemetryPayload;
  receiverStatus: number | null;
  error: string | null;
}

/** 10 s, matching the timeout printed in the offline `curl` snippet. */
export const PING_TIMEOUT_MS = 10_000;

/* ── version ─────────────────────────────────────────────────────────────── */

let cachedVersion: string | null = null;

/** `PTD_VERSION`, else package.json, else the same fallback `/api/health` reports. */
export function productVersion(): string {
  if (process.env.PTD_VERSION) return process.env.PTD_VERSION;
  if (cachedVersion) return cachedVersion;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, "../../package.json"), path.resolve(process.cwd(), "package.json")]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "ptd" && typeof parsed.version === "string" && parsed.version) {
        cachedVersion = parsed.version;
        return cachedVersion;
      }
    } catch {
      /* try the next candidate */
    }
  }
  cachedVersion = "0.1.0";
  return cachedVersion;
}

/**
 * The `dashboard_version` field: `ptd/<version>`. The receiver validates
 * 1–64 characters, so the tag is clamped and anything outside a conservative
 * character set is dropped rather than risking a 400 on a hand-set PTD_VERSION.
 */
export function productTag(): string {
  const cleaned = productVersion().replace(/[^A-Za-z0-9._+-]/g, "").slice(0, 56) || "0.0.0";
  return `ptd/${cleaned}`;
}

/* ── the payload ─────────────────────────────────────────────────────────── */

/** Lazily imported, exactly as `server/metrics/health.ts` does it, so this module unit-tests without a database. */
async function database() {
  return (await import("../../db")).db;
}

/**
 * Probe the running database for its HeliosDB-Nano version — the same
 * `SELECT version()` and the same regex the dashboard uses. Returns null on
 * stock Postgres or when the query fails; informational, never PII.
 */
export async function detectHeliosdbVersion(): Promise<string | null> {
  try {
    const db = await database();
    const rows = (await db.execute<{ version: string }>(sql`SELECT version()`)) as unknown as Record<string, unknown>[];
    const v = String(rows?.[0]?.version ?? "");
    const m = v.match(/HeliosDB[^\s]*\s*Nano\s*([0-9.]+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * The exact JSON that would be posted, right now. Exposed to the UI so nobody
 * has to take the policy on trust: what the section shows is what `ping()` sends.
 */
export async function buildPayload(record?: InstallRecord): Promise<TelemetryPayload> {
  const install = record ?? (await loadInstall());
  return {
    installation_id: install.installationId,
    dashboard_version: productTag(),
    heliosdb_version: await detectHeliosdbVersion(),
    timestamp: new Date().toISOString(),
  };
}

/* ── status ──────────────────────────────────────────────────────────────── */

export const WEEK_MS = 7 * 86_400_000;

export function statusOf(record: InstallRecord): TelemetryStatus {
  const enabled = telemetryIsEnabled(record);
  return {
    installationId: record.installationId,
    telemetryEnabled: enabled,
    updateChecksEnabled: record.updateChecksEnabled,
    envPinned: telemetryEnvOverride() !== null,
    decided: record.decidedAt !== null,
    decidedAt: record.decidedAt,
    lastPingAt: record.lastPingAt,
    lastPingResult: record.lastPingResult,
    lastUpdateCheckAt: record.lastUpdateCheckAt,
    latestVersionSeen: record.latestVersionSeen,
    version: productTag(),
    endpoint: endpointUrl(),
    updateCheckUrl: updateCheckUrl(),
    nextPingDueAt: enabled ? new Date((record.lastPingAt ? Date.parse(record.lastPingAt) : Date.now()) + WEEK_MS).toISOString() : null,
  };
}

export async function getStatus(): Promise<TelemetryStatus> {
  return statusOf(await loadInstall());
}

export async function setPreferences(prefs: {
  telemetryEnabled?: boolean;
  updateChecksEnabled?: boolean;
  /** A dismissal: no toggle moves, but the question counts as answered. */
  dismissed?: boolean;
}): Promise<TelemetryStatus> {
  const patch: Partial<InstallRecord> = { decidedAt: new Date().toISOString() };
  if (prefs.telemetryEnabled !== undefined) patch.telemetryEnabled = prefs.telemetryEnabled;
  if (prefs.updateChecksEnabled !== undefined) patch.updateChecksEnabled = prefs.updateChecksEnabled;
  return statusOf(await updateInstall(patch));
}

/* ── the ping ────────────────────────────────────────────────────────────── */

/**
 * Post the payload. Never throws: a telemetry failure is not an application
 * failure, so every outcome comes back as a result and is recorded on the
 * install record for the UI to show.
 */
export async function ping(): Promise<TelemetryPingResult> {
  const install = await loadInstall();
  const payload = await buildPayload(install);

  if (!telemetryIsEnabled(install)) {
    return { ok: false, sentAt: new Date().toISOString(), payload, receiverStatus: null, error: "telemetry-disabled" };
  }

  const sentAt = new Date().toISOString();
  let outcome: PingOutcome;
  try {
    // 10 s ceiling: an unreachable receiver must not hold a request handler or
    // the hourly timer open. No credentials, no cookies, one header.
    const res = await fetch(endpointUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    outcome = { ok: res.ok, at: sentAt, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    outcome = { ok: false, at: sentAt, status: null, error: err instanceof Error ? err.message.slice(0, 200) : "network error" };
  }

  // lastPingAt only moves on success, so a week of failures keeps retrying.
  await updateInstall(outcome.ok ? { lastPingAt: sentAt, lastPingResult: outcome } : { lastPingResult: outcome });
  return { ok: outcome.ok, sentAt, payload, receiverStatus: outcome.status, error: outcome.error };
}

/* ── the update check ────────────────────────────────────────────────────── */

/**
 * A bare GET against the public releases feed. Nothing is sent: no id, no
 * version, no header beyond what fetch must send to make the request.
 */
export async function checkUpdates(): Promise<UpdateCheckResult> {
  const install = await loadInstall();
  const current = productTag();
  const fetchedAt = new Date().toISOString();

  if (!install.updateChecksEnabled) {
    return { current, latest: null, upgradeAvailable: false, notes: "update-checks-disabled", fetchedAt, url: null };
  }

  try {
    const res = await fetch(updateCheckUrl(), { method: "GET", signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    if (!res.ok) {
      return { current, latest: null, upgradeAvailable: false, notes: `Feed returned HTTP ${res.status}`, fetchedAt, url: null };
    }
    // GitHub's release shape; a plain `{ latest, notes }` feed works too.
    const feed = (await res.json()) as { tag_name?: string; name?: string; body?: string; html_url?: string; latest?: string; notes?: string };
    const latest = (feed.tag_name ?? feed.latest ?? feed.name ?? "").replace(/^v/, "") || null;
    await updateInstall({ lastUpdateCheckAt: fetchedAt, latestVersionSeen: latest });
    return {
      current,
      latest,
      upgradeAvailable: latest !== null && latest !== productVersion(),
      notes: (feed.notes ?? feed.body ?? null)?.slice(0, 500) ?? null,
      fetchedAt,
      url: feed.html_url ?? null,
    };
  } catch (err) {
    return { current, latest: null, upgradeAvailable: false, notes: `Fetch failed: ${err instanceof Error ? err.message : "unknown"}`, fetchedAt, url: null };
  }
}

/* ── offline / restricted-egress submission ──────────────────────────────── */

export type OfflineFormat = "url" | "curl" | "wget" | "httpie" | "powershell" | "json";

export const OFFLINE_FORMATS: { id: OfflineFormat; label: string; lang: string }[] = [
  { id: "url", label: "URL (browser)", lang: "url" },
  { id: "curl", label: "curl", lang: "bash" },
  { id: "wget", label: "wget", lang: "bash" },
  { id: "httpie", label: "HTTPie", lang: "bash" },
  { id: "powershell", label: "PowerShell", lang: "powershell" },
  { id: "json", label: "Plain JSON", lang: "json" },
];

/**
 * Inside single-quoted bash only `'` itself cannot appear literally. Close the
 * quote, insert an escaped one, reopen. The payload is JSON so this fires only
 * for a stray quote — none today, but the escape belongs here rather than in a
 * comment promising there will never be one.
 */
export function escapeForSingleQuotedShell(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

/**
 * Render the payload in one ready-to-paste shape. Same six formats, same flags
 * and same defaults as the dashboard's `OfflineSubmission`, because an operator
 * who has used one should recognise the other.
 */
export function buildOfflineCommand(fmt: OfflineFormat, p: TelemetryPayload, baseUrl: string): string {
  const json = JSON.stringify(p);
  switch (fmt) {
    case "url": {
      // Browser-paste path: the receiver's GET /v1/ping takes the payload as
      // query parameters and answers a small "Ping received" page. No terminal,
      // no curl, just an address bar.
      const qs = new URLSearchParams({
        installation_id: p.installation_id,
        dashboard_version: p.dashboard_version,
        timestamp: p.timestamp,
      });
      if (p.heliosdb_version) qs.set("heliosdb_version", p.heliosdb_version);
      return `${baseUrl}?${qs.toString()}`;
    }
    case "curl":
      // --silent -S: hide progress, still show errors.
      // --max-time: cap at 10 s so a hung receiver cannot lock the script.
      // --fail-with-body: non-zero exit on 4xx/5xx but still print the response.
      return [
        `curl --silent --show-error --fail-with-body --max-time 10 \\`,
        `  -X POST '${baseUrl}' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '${escapeForSingleQuotedShell(json)}'`,
      ].join("\n");
    case "wget":
      return [
        `wget --quiet --timeout=10 -O- \\`,
        `  --header='Content-Type: application/json' \\`,
        `  --post-data='${escapeForSingleQuotedShell(json)}' \\`,
        `  '${baseUrl}'`,
      ].join("\n");
    case "httpie":
      // The explicit form, to avoid nullable surprises with heliosdb_version.
      return [
        `http POST '${baseUrl}' \\`,
        `  Content-Type:application/json \\`,
        `  installation_id='${p.installation_id}' \\`,
        `  dashboard_version='${p.dashboard_version}' \\`,
        `  heliosdb_version:='${p.heliosdb_version === null ? "null" : `"${p.heliosdb_version}"`}' \\`,
        `  timestamp='${p.timestamp}'`,
      ].join("\n");
    case "powershell":
      return [`$body = @'`, json, `'@`, `Invoke-RestMethod -Method POST -Uri '${baseUrl}' \``, `  -ContentType 'application/json' \``, `  -Body $body`].join("\n");
    case "json":
      return JSON.stringify(p, null, 2);
  }
}

/** Every format for one payload — one timestamp across all six, so they agree. */
export function offlineCommandsFor(payload: TelemetryPayload, baseUrl = endpointUrl()): Record<OfflineFormat, string> {
  const out = {} as Record<OfflineFormat, string>;
  for (const f of OFFLINE_FORMATS) out[f.id] = buildOfflineCommand(f.id, payload, baseUrl);
  return out;
}

/** The same, with a freshly stamped payload. `baseUrl` defaults to the configured endpoint. */
export async function offlineCommands(baseUrl = endpointUrl()): Promise<Record<OfflineFormat, string>> {
  return offlineCommandsFor(await buildPayload(), baseUrl);
}

/* ── policy text ─────────────────────────────────────────────────────────── */

/**
 * The retention and aggregation policy, verbatim from the receiver's own README
 * (`~/telemetry/README.md`) so the page cannot drift from what the service does.
 */
export const TELEMETRY_POLICY = {
  summary:
    "Telemetry is opt-in and off by default. When enabled, PTD posts a weekly ping containing four fields and nothing else. " +
    "It does not send your IP, username, email, hostname, OS, organization names, counts, or any contents of your tasks, " +
    "time entries or invoices. The receiver keeps a salted hash of (IP, installation_id) bucketed by ISO week, so active " +
    "installs are deduplicated without anyone holding a re-identifiable address.",
  // Plain prose, no markdown: these strings are rendered into a table cell as
  // text, so a backtick would show up as a backtick.
  fields: [
    { key: "installation_id", source: "random 16-byte hex, minted once on first boot and stored in the install record", risk: "none \u2014 opaque to us" },
    { key: "dashboard_version", source: "the tag ptd/ plus PTD_VERSION (or package.json), so the shared receiver can tell products apart", risk: "none" },
    { key: "heliosdb_version", source: "SELECT version() parsed for the HeliosDB-Nano version; null on stock Postgres", risk: "none" },
    { key: "timestamp", source: "new Date().toISOString() at submit time", risk: "none" },
  ],
  retention: [
    "The receiver hashes (client_ip, installation_id) with a rotating server-side salt under a YYYY-WW bucket key. The raw IP and the raw (ip, id) tuple are never persisted.",
    "Only (week_bucket, hash) rows are kept, plus the version columns. “Active installs this week” is SELECT COUNT(DISTINCT hash) WHERE week_bucket = current_week.",
    "The salt rotates weekly, so hashes from week N can never be cross-correlated with hashes from week N+1 at the receiver.",
    "Per-row data is dropped after 90 days. Aggregate weekly counts are kept indefinitely.",
    "No third-party processors, no analytics SDK, no client-side trackers. The endpoint is operated by the PTD maintainer and the data is not resold.",
  ],
  receiverSource: "https://github.com/danimoya/telemetry",
  /** Why an out-of-band submission from another network still counts exactly once. */
  offlineNote:
    "The receiver dedupes on SHA-256(salt || ip || installation_id) per ISO week, so a one-off submission from a different " +
    "network still counts this install exactly once for that week. The timestamp is stored for diagnostics and is not load-bearing for dedupe.",
} as const;

/* ── the weekly timer ────────────────────────────────────────────────────── */

export const TELEMETRY_TICK_MS = 3_600_000;

/** Same switch as the recurrence scheduler, for the same reasons: tests and one-off CLI processes. */
export function telemetrySchedulerEnabled(): boolean {
  return process.env.PTD_SCHEDULER !== "0" && process.env.NODE_ENV !== "test";
}

/**
 * One ping a week, no more: the hourly tick pings only when telemetry is on and
 * the last *successful* ping is at least seven days old. A never-pinged install
 * that has just opted in is due immediately.
 */
export function dueForWeeklyPing(record: InstallRecord, now = new Date()): boolean {
  if (!telemetryIsEnabled(record)) return false;
  if (!record.lastPingAt) return true;
  const last = Date.parse(record.lastPingAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= WEEK_MS;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export async function telemetryTick(now = new Date()): Promise<boolean> {
  if (ticking) return false;
  ticking = true;
  try {
    const install = await loadInstall();
    if (!dueForWeeklyPing(install, now)) return false;
    const result = await ping();
    console.log(`[telemetry] weekly ping ${result.ok ? "accepted" : `failed (${result.error})`}`);
    return result.ok;
  } catch (err) {
    console.error("[telemetry] weekly tick failed:", err instanceof Error ? err.message : err);
    return false;
  } finally {
    ticking = false;
  }
}

export function startTelemetryScheduler(): boolean {
  if (!telemetrySchedulerEnabled()) return false;
  if (timer) return true;
  timer = setInterval(() => {
    void telemetryTick();
  }, TELEMETRY_TICK_MS);
  // Never hold the process open for the sake of the timer.
  if (typeof timer.unref === "function") timer.unref();
  return true;
}

export function stopTelemetryScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
