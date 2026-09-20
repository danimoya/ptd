import { execFile } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";

/**
 * The two shell scripts.
 *
 * Their real work needs docker and a database, which is done by hand before a release
 * (and written up in docs/self-hosting.md). What is worth a unit test is the part that
 * decides *when* a backup runs and *whether* a restore is allowed to — a cron
 * expression nobody checked and a restore with no confirmation are the two ways this
 * pair could quietly do the wrong thing.
 */

const exec = promisify(execFile);
const root = path.resolve(__dirname, "..", "..");
const backup = path.join(root, "scripts", "backup.sh");
const restore = path.join(root, "scripts", "restore.sh");

const epoch = (iso: string) => String(Math.floor(new Date(iso).getTime() / 1000));

async function cronMatches(expr: string, iso: string): Promise<boolean> {
  try {
    await exec("sh", [backup, "--check-cron", expr, epoch(iso)]);
    return true;
  } catch {
    return false;
  }
}

describe("the backup schedule", () => {
  it("matches a plain nightly expression on the minute and nowhere else", async () => {
    await expect(cronMatches("17 3 * * *", "2026-09-20T03:17:00Z")).resolves.toBe(true);
    await expect(cronMatches("17 3 * * *", "2026-09-20T03:18:00Z")).resolves.toBe(false);
    await expect(cronMatches("17 3 * * *", "2026-09-20T04:17:00Z")).resolves.toBe(false);
  });

  it("understands steps, ranges and lists", async () => {
    await expect(cronMatches("*/15 * * * *", "2026-09-20T03:30:00Z")).resolves.toBe(true);
    await expect(cronMatches("*/15 * * * *", "2026-09-20T03:31:00Z")).resolves.toBe(false);
    await expect(cronMatches("0 0-6/2 * * *", "2026-09-20T04:00:00Z")).resolves.toBe(true);
    await expect(cronMatches("0 0-6/2 * * *", "2026-09-20T05:00:00Z")).resolves.toBe(false);
    await expect(cronMatches("5,35 * * * *", "2026-09-20T09:35:00Z")).resolves.toBe(true);
    await expect(cronMatches("5,35 * * * *", "2026-09-20T09:36:00Z")).resolves.toBe(false);
  });

  it("follows cron's day-of-month / day-of-week rule", async () => {
    // 2026-09-20 is a Sunday.
    await expect(cronMatches("0 2 * * 0", "2026-09-20T02:00:00Z")).resolves.toBe(true);
    await expect(cronMatches("0 2 * * 0", "2026-09-21T02:00:00Z")).resolves.toBe(false);
    await expect(cronMatches("30 4 1 * *", "2026-10-01T04:30:00Z")).resolves.toBe(true);
    await expect(cronMatches("30 4 1 * *", "2026-10-02T04:30:00Z")).resolves.toBe(false);
    // Both restricted: either matching is enough, as crontab(5) says.
    await expect(cronMatches("0 5 1 * 3", "2026-09-30T05:00:00Z")).resolves.toBe(true); // Wednesday
    await expect(cronMatches("0 5 1 * 3", "2026-10-01T05:00:00Z")).resolves.toBe(true); // the 1st
    await expect(cronMatches("0 5 1 * 3", "2026-10-02T05:00:00Z")).resolves.toBe(false);
  });

  it("refuses an expression that is not five fields rather than guessing", async () => {
    await expect(exec("sh", [backup, "--check-cron", "17 3 *", epoch("2026-09-20T03:17:00Z")])).rejects.toThrow(
      /five fields/,
    );
  });
});

describe("the scripts' own guard rails", () => {
  it("backup.sh rejects an unknown mode and an unknown option", async () => {
    await expect(exec("sh", [backup, "--mode", "warm", "--once"])).rejects.toThrow(/snapshot or cold/);
    await expect(exec("sh", [backup, "--nonsense"])).rejects.toThrow(/unknown option/);
  });

  it("restore.sh refuses to do anything without --yes, and says what to type instead", async () => {
    let failed = false;
    try {
      await exec("sh", [restore, "--input", backup]);
    } catch (err) {
      failed = true;
      const e = err as { code?: number; stderr?: string };
      expect(e.code).toBe(2);
      expect(e.stderr).toContain("refusing to run without --yes");
      expect(e.stderr).toContain("--scratch");
      expect(e.stderr).toContain("DESTRUCTIVE");
    }
    expect(failed).toBe(true);
  });

  it("restore.sh will not accept a dump file that is not there", async () => {
    await expect(exec("sh", [restore, "--input", "/tmp/does-not-exist.heliodump", "--yes"])).rejects.toThrow(
      /no such file/,
    );
  });

  it("documents why the dump is taken from a copy, in the file itself", () => {
    const header = readFileSync(backup, "utf8").slice(0, 2500);
    // The three findings that decide the whole design; if someone "simplifies" the
    // script back to a live dump, this is the note they have to delete first.
    expect(header).toContain("Server mode dump not yet implemented");
    expect(header).toContain("Resource temporarily unavailable");
    expect(header).toContain("dump-schedule is not");
  });
});
