import { describe, expect, it, vi } from "vitest";

/**
 * Offline submission: six shapes of one payload, for a host that cannot reach
 * the receiver. Two things must hold — the URL form has to survive a round trip
 * through an address bar (so every reserved character is encoded), and the shell
 * forms must not let a payload value escape its quoting.
 */
vi.mock("../../db", () => ({ db: { execute: vi.fn(async () => []) } }));

import {
  OFFLINE_FORMATS,
  buildOfflineCommand,
  escapeForSingleQuotedShell,
  offlineCommandsFor,
  type TelemetryPayload,
} from "../../server/telemetry/service";

const ENDPOINT = "https://telemetry.danimoya.com/v1/ping";

const payload: TelemetryPayload = {
  installation_id: "0123456789abcdef0123456789abcdef",
  dashboard_version: "ptd/0.1.0",
  heliosdb_version: "4.40.0",
  timestamp: "2026-09-21T10:11:12.345Z",
};

describe("the URL (browser-paste) form", () => {
  it("percent-encodes everything the address bar would otherwise eat", () => {
    const url = buildOfflineCommand("url", payload, ENDPOINT);
    expect(url.startsWith(`${ENDPOINT}?`)).toBe(true);
    expect(url).toContain("timestamp=2026-09-21T10%3A11%3A12.345Z");
    expect(url).toContain("dashboard_version=ptd%2F0.1.0");
    expect(url).toContain("heliosdb_version=4.40.0");
    expect(url).not.toMatch(/[ "<>]/);
  });

  it("round-trips back to the same four values", () => {
    const url = new URL(buildOfflineCommand("url", payload, ENDPOINT));
    expect(url.searchParams.get("installation_id")).toBe(payload.installation_id);
    expect(url.searchParams.get("dashboard_version")).toBe(payload.dashboard_version);
    expect(url.searchParams.get("heliosdb_version")).toBe(payload.heliosdb_version);
    expect(url.searchParams.get("timestamp")).toBe(payload.timestamp);
    expect([...url.searchParams.keys()].sort()).toEqual(["dashboard_version", "heliosdb_version", "installation_id", "timestamp"]);
  });

  it("omits heliosdb_version rather than sending the string 'null'", () => {
    const url = new URL(buildOfflineCommand("url", { ...payload, heliosdb_version: null }, ENDPOINT));
    expect(url.searchParams.has("heliosdb_version")).toBe(false);
    expect([...url.searchParams.keys()].sort()).toEqual(["dashboard_version", "installation_id", "timestamp"]);
  });
});

describe("the shell forms", () => {
  it("quote the body and cap the timeout", () => {
    const curl = buildOfflineCommand("curl", payload, ENDPOINT);
    expect(curl).toContain("--max-time 10");
    expect(curl).toContain(`-X POST '${ENDPOINT}'`);
    expect(curl).toContain(`-d '${JSON.stringify(payload)}'`);
    expect(buildOfflineCommand("wget", payload, ENDPOINT)).toContain("--timeout=10");
  });

  it("cannot be escaped by a value carrying a single quote", () => {
    const hostile: TelemetryPayload = { ...payload, heliosdb_version: "4.40.0'; rm -rf /; echo '" };
    const json = JSON.stringify(hostile);
    const curl = buildOfflineCommand("curl", hostile, ENDPOINT);

    // Read the -d argument back the way bash would: the quoted run is closed,
    // an escaped quote inserted, and the quote reopened, so undoing exactly that
    // must return the payload — and every remaining segment must be quote-free,
    // which is what proves no bare ' survives to terminate the argument early.
    const arg = /\n {2}-d '([\s\S]*)'$/.exec(curl)?.[1];
    expect(arg).toBeTypeOf("string");
    const segments = String(arg).split(`'\\''`);
    for (const segment of segments) expect(segment).not.toContain("'");
    expect(segments.join("'")).toBe(json);

    expect(escapeForSingleQuotedShell("a'b")).toBe("a'\\''b");
  });
});

describe("every format", () => {
  it("renders all six, non-empty, from one payload", () => {
    const commands = offlineCommandsFor(payload, ENDPOINT);
    expect(Object.keys(commands).sort()).toEqual(["curl", "httpie", "json", "powershell", "url", "wget"]);
    for (const f of OFFLINE_FORMATS) {
      expect(commands[f.id].length).toBeGreaterThan(0);
      expect(commands[f.id]).toContain(payload.installation_id);
    }
    // One payload, one timestamp: the URL and the curl body cannot disagree.
    for (const f of OFFLINE_FORMATS) expect(commands[f.id]).toContain("2026-09-21T10");
  });

  it("offers the browser URL first, marked preferred in the UI", () => {
    expect(OFFLINE_FORMATS[0].id).toBe("url");
  });

  it("renders plain JSON as the payload and nothing but", () => {
    expect(JSON.parse(buildOfflineCommand("json", payload, ENDPOINT))).toEqual(payload);
  });
});
