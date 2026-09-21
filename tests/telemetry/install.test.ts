import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

/**
 * The install record.
 *
 * Three rules this feature rests on: the id is opaque and minted once, both
 * toggles are created OFF (opt-in, never opt-out), and nothing in the file is
 * readable by another account on the host.
 */
import {
  INSTALLATION_ID_SHAPE,
  INSTALL_FILENAME,
  installFilePath,
  loadInstall,
  mintInstallationId,
  normalizeInstall,
  resetInstallCache,
  telemetryEnvOverride,
  telemetryIsEnabled,
  updateInstall,
} from "../../server/telemetry/install";

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ptd-telemetry-"));
  process.env.PTD_FILES_DIR = dir;
  delete process.env.PTD_TELEMETRY;
  resetInstallCache();
});

afterEach(async () => {
  delete process.env.PTD_FILES_DIR;
  delete process.env.PTD_TELEMETRY;
  resetInstallCache();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("the installation id", () => {
  it("is 32 lowercase hex characters and matches what the receiver accepts", () => {
    for (let i = 0; i < 20; i++) {
      const id = mintInstallationId();
      expect(id).toHaveLength(32);
      expect(id).toMatch(/^[a-f0-9]{32}$/);
      expect(INSTALLATION_ID_SHAPE.test(id)).toBe(true);
    }
  });

  it("is minted once and then read back, not re-minted", async () => {
    const first = await loadInstall();
    resetInstallCache();
    const second = await loadInstall();
    expect(second.installationId).toBe(first.installationId);
    expect(INSTALLATION_ID_SHAPE.test(first.installationId)).toBe(true);
  });

  it("cannot be rotated by a caller sending one in", async () => {
    const first = await loadInstall();
    const after = await updateInstall({ installationId: "f".repeat(32) } as never);
    expect(after.installationId).toBe(first.installationId);
  });
});

describe("the file", () => {
  it("lives at ${PTD_FILES_DIR}/.ptd-install.json with mode 0600", async () => {
    await loadInstall();
    expect(installFilePath()).toBe(path.join(dir, INSTALL_FILENAME));
    const stat = fs.statSync(installFilePath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("holds the frozen shape and persists a change", async () => {
    const created = await loadInstall();
    expect(Object.keys(JSON.parse(fs.readFileSync(installFilePath(), "utf8")) as object).sort()).toEqual([
      "createdAt",
      "decidedAt",
      "installationId",
      "lastPingAt",
      "lastPingResult",
      "lastUpdateCheckAt",
      "latestVersionSeen",
      "telemetryEnabled",
      "updateChecksEnabled",
    ]);
    expect(created.telemetryEnabled).toBe(false);
    expect(created.updateChecksEnabled).toBe(false);
    expect(created.decidedAt).toBeNull();

    await updateInstall({ telemetryEnabled: true, decidedAt: "2026-09-21T00:00:00.000Z" });
    resetInstallCache();
    const reread = await loadInstall();
    expect(reread.telemetryEnabled).toBe(true);
    expect(reread.decidedAt).toBe("2026-09-21T00:00:00.000Z");
  });

  it("keeps an unknown key written by a newer PTD", async () => {
    await loadInstall();
    const raw = JSON.parse(fs.readFileSync(installFilePath(), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(installFilePath(), JSON.stringify({ ...raw, somethingNewer: 7 }));
    resetInstallCache();
    await updateInstall({ updateChecksEnabled: true });
    expect((JSON.parse(fs.readFileSync(installFilePath(), "utf8")) as Record<string, unknown>).somethingNewer).toBe(7);
  });
});

describe("normalizeInstall", () => {
  it("reads a corrupt or hand-edited record as telemetry OFF", () => {
    for (const bad of [null, "nonsense", 42, {}, { telemetryEnabled: "yes" }, { telemetryEnabled: 1 }]) {
      const r = normalizeInstall(bad);
      expect(r.telemetryEnabled).toBe(false);
      expect(r.updateChecksEnabled).toBe(false);
      expect(INSTALLATION_ID_SHAPE.test(r.installationId)).toBe(true);
    }
  });

  it("replaces an id the receiver would reject", () => {
    expect(normalizeInstall({ installationId: "nope" }).installationId).not.toBe("nope");
    expect(normalizeInstall({ installationId: "ABCDEF0123456789" }).installationId).toBe("abcdef0123456789");
  });
});

describe("PTD_TELEMETRY", () => {
  it("outranks the stored toggle in both directions and is otherwise ignored", async () => {
    const record = await updateInstall({ telemetryEnabled: false });
    expect(telemetryEnvOverride()).toBeNull();
    expect(telemetryIsEnabled(record)).toBe(false);

    process.env.PTD_TELEMETRY = "1";
    expect(telemetryEnvOverride()).toBe(true);
    expect(telemetryIsEnabled(record)).toBe(true);

    process.env.PTD_TELEMETRY = "0";
    expect(telemetryIsEnabled({ ...record, telemetryEnabled: true })).toBe(false);

    process.env.PTD_TELEMETRY = "maybe";
    expect(telemetryEnvOverride()).toBeNull();
    expect(telemetryIsEnabled({ ...record, telemetryEnabled: true })).toBe(true);
  });
});
