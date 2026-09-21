import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsp from "fs/promises";
import os from "os";
import path from "path";

/**
 * The payload, and the promise around it.
 *
 * The policy is a claim about bytes on the wire: "the payload is exactly
 * { installation_id, dashboard_version, heliosdb_version, timestamp }" and
 * "nothing is sent unless the operator opted in". Both are testable, so they are
 * tested here rather than asserted in a README.
 */
vi.mock("../../db", () => ({ db: { execute: vi.fn(async () => [{ version: "PostgreSQL 16.0 (HeliosDB Nano 4.40.0)" }]) } }));

import { loadInstall, readInstall, resetInstallCache, updateInstall } from "../../server/telemetry/install";
import { buildPayload, detectHeliosdbVersion, productTag, ping, setPreferences, statusOf } from "../../server/telemetry/service";

const ENDPOINT = "https://telemetry.example.invalid/v1/ping";
let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ptd-telemetry-"));
  process.env.PTD_FILES_DIR = dir;
  process.env.PTD_TELEMETRY_ENDPOINT = ENDPOINT;
  process.env.PTD_VERSION = "9.9.9-test";
  delete process.env.PTD_TELEMETRY;
  resetInstallCache();
  vi.mocked(global.fetch).mockReset();
});

afterEach(async () => {
  delete process.env.PTD_FILES_DIR;
  delete process.env.PTD_TELEMETRY_ENDPOINT;
  delete process.env.PTD_VERSION;
  resetInstallCache();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("buildPayload", () => {
  it("has exactly the four fields and nothing else", async () => {
    const payload = await buildPayload();
    expect(Object.keys(payload).sort()).toEqual(["dashboard_version", "heliosdb_version", "installation_id", "timestamp"]);
  });

  it("carries no host, user or organization identity", async () => {
    const serialized = JSON.stringify(await buildPayload()).toLowerCase();
    for (const forbidden of ["hostname", "host", "user", "email", "org", "ip", "platform", "arch", "count", "task"]) {
      expect(serialized.includes(`"${forbidden}"`)).toBe(false);
    }
  });

  it("tags the product so the shared receiver can tell PTD apart", async () => {
    expect(productTag()).toBe("ptd/9.9.9-test");
    const payload = await buildPayload();
    expect(payload.dashboard_version).toBe("ptd/9.9.9-test");
    expect(payload.dashboard_version.length).toBeLessThanOrEqual(64);
  });

  it("reads the HeliosDB version out of SELECT version(), and tolerates a Postgres that has none", async () => {
    expect(await detectHeliosdbVersion()).toBe("4.40.0");
    const { db } = (await import("../../db")) as unknown as { db: { execute: ReturnType<typeof vi.fn> } };
    db.execute.mockResolvedValueOnce([{ version: "PostgreSQL 16.4 (Debian 16.4-1)" }]);
    expect(await detectHeliosdbVersion()).toBeNull();
    db.execute.mockRejectedValueOnce(new Error("no database"));
    expect(await detectHeliosdbVersion()).toBeNull();
  });

  it("stamps an RFC 3339 timestamp", async () => {
    const { timestamp } = await buildPayload();
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("ping while telemetry is off", () => {
  it("sends nothing at all", async () => {
    const result = await ping();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("telemetry-disabled");
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await readInstall())?.lastPingAt).toBeNull();
  });

  it("is still off after PTD_TELEMETRY=0, whatever the file says", async () => {
    await updateInstall({ telemetryEnabled: true });
    process.env.PTD_TELEMETRY = "0";
    expect((await ping()).error).toBe("telemetry-disabled");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("ping once opted in", () => {
  beforeEach(async () => {
    await setPreferences({ telemetryEnabled: true });
  });

  it("posts the exact payload to the configured endpoint, and nothing else", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("{\"ok\":true}", { status: 200 }));
    const result = await ping();

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(Object.keys(init as object).sort()).toEqual(["body", "headers", "method", "signal"]);

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["dashboard_version", "heliosdb_version", "installation_id", "timestamp"]);
    expect(body).toEqual(result.payload);
    expect(String(body.installation_id)).toMatch(/^[a-f0-9]{32}$/);
  });

  it("records the success so the section can show it, and moves lastPingAt", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await ping();
    const record = await readInstall();
    expect(record?.lastPingAt).toBe(result.sentAt);
    expect(record?.lastPingResult).toEqual({ ok: true, at: result.sentAt, status: 200, error: null });
  });

  it("never throws on a network failure, and does not move lastPingAt", async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const result = await ping();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOTFOUND");
    const record = await readInstall();
    expect(record?.lastPingAt).toBeNull();
    expect(record?.lastPingResult?.ok).toBe(false);
  });

  it("reports a rejection from the receiver as a failure", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("{\"error\":\"invalid installation_id\"}", { status: 400 }));
    const result = await ping();
    expect(result.ok).toBe(false);
    expect(result.receiverStatus).toBe(400);
    expect((await readInstall())?.lastPingAt).toBeNull();
  });
});

describe("setPreferences", () => {
  it("answers the first-run question either way", async () => {
    expect(statusOf(await loadInstall()).decided).toBe(false);
    const dismissed = await setPreferences({ dismissed: true });
    expect(dismissed.decided).toBe(true);
    expect(dismissed.telemetryEnabled).toBe(false);
    expect(dismissed.updateChecksEnabled).toBe(false);
  });

  it("moves the two toggles independently", async () => {
    const onlyUpdates = await setPreferences({ updateChecksEnabled: true });
    expect(onlyUpdates.updateChecksEnabled).toBe(true);
    expect(onlyUpdates.telemetryEnabled).toBe(false);
  });
});
