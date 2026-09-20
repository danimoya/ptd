/** Config read/write against a temporary HOME — nothing touches the real one. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCredentials, configMode, configPath, readConfig, readFileConfigOnly, stripTrailingSlash, writeConfig } from "../src/config.ts";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ptd-cli-test-"));
  env = { HOME: home } as NodeJS.ProcessEnv;
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("configPath", () => {
  it("lands in ~/.config/ptd/config.json", () => {
    expect(configPath(env)).toBe(join(home, ".config", "ptd", "config.json"));
  });

  it("honors XDG_CONFIG_HOME and an explicit PTD_CONFIG", () => {
    expect(configPath({ ...env, XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/ptd/config.json");
    expect(configPath({ ...env, PTD_CONFIG: "/tmp/elsewhere.json" })).toBe("/tmp/elsewhere.json");
    // A relative XDG_CONFIG_HOME is per spec to be ignored.
    expect(configPath({ ...env, XDG_CONFIG_HOME: "relative" })).toBe(join(home, ".config", "ptd", "config.json"));
  });
});

describe("writeConfig", () => {
  it("creates the file 0600 and reads back the three fields", () => {
    const path = writeConfig({ baseUrl: "https://ptd.example/", token: "ptd_abc", orgId: 7 }, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(configMode(env)).toBe(0o600);
    expect(readConfig(env)).toEqual({ baseUrl: "https://ptd.example", token: "ptd_abc", orgId: 7 });
    expect(JSON.parse(readFileSync(path, "utf8")).baseUrl).toBe("https://ptd.example");
  });

  it("tightens the mode of a file that already existed with looser bits", () => {
    const path = writeConfig({ token: "a" }, env);
    writeFileSync(path, "{}", { mode: 0o644 });
    writeConfig({ token: "b" }, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("leaves out what it was not given", () => {
    writeConfig({ baseUrl: "https://ptd.example" }, env);
    expect(readConfig(env)).toEqual({ baseUrl: "https://ptd.example" });
  });
});

describe("readConfig", () => {
  it("reads as empty when there is no file", () => {
    expect(readConfig(env)).toEqual({});
    expect(configMode(env)).toBeNull();
  });

  it("reads as empty when the file is corrupt, rather than throwing", () => {
    const path = writeConfig({ token: "x" }, env);
    writeFileSync(path, "{not json");
    expect(readConfig(env)).toEqual({});
  });

  it("ignores fields of the wrong type", () => {
    const path = writeConfig({ token: "x" }, env);
    writeFileSync(path, JSON.stringify({ baseUrl: 5, token: "ptd_ok", orgId: "seven" }));
    expect(readConfig(env)).toEqual({ token: "ptd_ok" });
  });

  it("lets PTD_URL, PTD_TOKEN and PTD_ORG_ID win without writing anything", () => {
    writeConfig({ baseUrl: "https://stored", token: "stored", orgId: 1 }, env);
    const overridden = { ...env, PTD_URL: "https://env/", PTD_TOKEN: "ptd_env", PTD_ORG_ID: "9" };
    expect(readConfig(overridden)).toEqual({ baseUrl: "https://env", token: "ptd_env", orgId: 9 });
    // The file is untouched, which is what `readFileConfigOnly` is for.
    expect(readFileConfigOnly(overridden)).toEqual({ baseUrl: "https://stored", token: "stored", orgId: 1 });
  });
});

describe("clearCredentials", () => {
  it("drops the token but keeps the URL", () => {
    writeConfig({ baseUrl: "https://ptd.example", token: "ptd_abc", orgId: 3 }, env);
    const { hadToken } = clearCredentials(env);
    expect(hadToken).toBe(true);
    expect(readConfig(env)).toEqual({ baseUrl: "https://ptd.example" });
  });

  it("is a no-op when nothing was stored", () => {
    expect(clearCredentials(env).hadToken).toBe(false);
  });
});

describe("stripTrailingSlash", () => {
  it("normalizes a base URL", () => {
    expect(stripTrailingSlash("https://x//")).toBe("https://x");
    expect(stripTrailingSlash("https://x")).toBe("https://x");
  });
});
