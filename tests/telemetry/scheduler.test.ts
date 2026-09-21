import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsp from "fs/promises";
import os from "os";
import path from "path";

/**
 * The weekly decision.
 *
 * "Weekly" is the whole promise of the ping — an hourly timer that pinged hourly
 * would be a different product. The tick therefore asks one question, and it is
 * the one tested here: is telemetry on, and is the last *successful* ping seven
 * days old?
 */
vi.mock("../../db", () => ({ db: { execute: vi.fn(async () => []) } }));

import { resetInstallCache, updateInstall, type InstallRecord } from "../../server/telemetry/install";
import {
  TELEMETRY_TICK_MS,
  WEEK_MS,
  dueForWeeklyPing,
  startTelemetryScheduler,
  stopTelemetryScheduler,
  telemetrySchedulerEnabled,
  telemetryTick,
} from "../../server/telemetry/service";

const NOW = new Date("2026-09-21T12:00:00.000Z");

function record(over: Partial<InstallRecord> = {}): InstallRecord {
  return {
    installationId: "0123456789abcdef0123456789abcdef",
    telemetryEnabled: true,
    updateChecksEnabled: false,
    decidedAt: "2026-01-01T00:00:00.000Z",
    lastPingAt: null,
    lastPingResult: null,
    lastUpdateCheckAt: null,
    latestVersionSeen: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ptd-telemetry-"));
  process.env.PTD_FILES_DIR = dir;
  process.env.PTD_TELEMETRY_ENDPOINT = "https://telemetry.example.invalid/v1/ping";
  delete process.env.PTD_TELEMETRY;
  delete process.env.PTD_SCHEDULER;
  resetInstallCache();
  vi.mocked(global.fetch).mockReset();
});

afterEach(async () => {
  stopTelemetryScheduler();
  delete process.env.PTD_FILES_DIR;
  delete process.env.PTD_TELEMETRY_ENDPOINT;
  delete process.env.PTD_SCHEDULER;
  resetInstallCache();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("dueForWeeklyPing", () => {
  it("is never due while telemetry is off", () => {
    expect(dueForWeeklyPing(record({ telemetryEnabled: false }), NOW)).toBe(false);
    expect(dueForWeeklyPing(record({ telemetryEnabled: false, lastPingAt: null }), NOW)).toBe(false);
  });

  it("is due immediately after opting in", () => {
    expect(dueForWeeklyPing(record({ lastPingAt: null }), NOW)).toBe(true);
  });

  it("waits a full seven days after a success", () => {
    const sixDays = new Date(NOW.getTime() - 6 * 86_400_000).toISOString();
    const sevenDays = new Date(NOW.getTime() - WEEK_MS).toISOString();
    const eightDays = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();
    expect(dueForWeeklyPing(record({ lastPingAt: sixDays }), NOW)).toBe(false);
    expect(dueForWeeklyPing(record({ lastPingAt: sevenDays }), NOW)).toBe(true);
    expect(dueForWeeklyPing(record({ lastPingAt: eightDays }), NOW)).toBe(true);
  });

  it("treats an unreadable lastPingAt as never pinged rather than as recent", () => {
    expect(dueForWeeklyPing(record({ lastPingAt: "not a date" }), NOW)).toBe(true);
  });

  it("respects PTD_TELEMETRY=0 even on a record that says otherwise", () => {
    process.env.PTD_TELEMETRY = "0";
    expect(dueForWeeklyPing(record({ lastPingAt: null }), NOW)).toBe(false);
  });
});

describe("the timer", () => {
  it("ticks hourly, not weekly — the interval checks, the record decides", () => {
    expect(TELEMETRY_TICK_MS).toBe(3_600_000);
    expect(WEEK_MS).toBe(604_800_000);
  });

  it("is disabled under PTD_SCHEDULER=0 and in tests, like the recurrence scheduler", () => {
    expect(telemetrySchedulerEnabled()).toBe(false); // NODE_ENV=test
    process.env.PTD_SCHEDULER = "0";
    expect(telemetrySchedulerEnabled()).toBe(false);
    expect(startTelemetryScheduler()).toBe(false);
  });
});

describe("telemetryTick", () => {
  it("sends nothing when telemetry is off", async () => {
    await updateInstall({ telemetryEnabled: false });
    expect(await telemetryTick(NOW)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends nothing when a ping already landed this week", async () => {
    await updateInstall({ telemetryEnabled: true, lastPingAt: new Date(NOW.getTime() - 86_400_000).toISOString() });
    expect(await telemetryTick(NOW)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("pings once when the week has passed", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("{}", { status: 200 }));
    await updateInstall({ telemetryEnabled: true, lastPingAt: new Date(NOW.getTime() - 8 * 86_400_000).toISOString() });
    expect(await telemetryTick(NOW)).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
