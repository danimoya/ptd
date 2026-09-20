/**
 * The stored session: `~/.config/ptd/config.json`, mode 0600, three fields.
 *
 * It holds a bearer credential, so the file is created inside a 0700 directory
 * and written 0600 — and `ptd whoami` warns when the mode on disk is looser than
 * that. `PTD_URL`, `PTD_TOKEN` and `PTD_ORG_ID` override the file without
 * touching it, which is how CI and one-off scripts should authenticate.
 */
import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  baseUrl?: string;
  token?: string;
  orgId?: number;
}

export const DEFAULT_BASE_URL = "https://ptd.danimoya.com";

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PTD_CONFIG) return env.PTD_CONFIG;
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.startsWith("/") ? xdg : join(env.HOME || homedir(), ".config");
  return join(base, "ptd", "config.json");
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Never throws: a missing or corrupt file reads as "not logged in". */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath(env), "utf8"));
  } catch {
    parsed = null;
  }
  const out: Config = {};
  if (parsed && typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    if (typeof raw.baseUrl === "string" && raw.baseUrl !== "") out.baseUrl = stripTrailingSlash(raw.baseUrl);
    if (typeof raw.token === "string" && raw.token !== "") out.token = raw.token;
    if (typeof raw.orgId === "number" && Number.isInteger(raw.orgId)) out.orgId = raw.orgId;
  }
  if (env.PTD_URL) out.baseUrl = stripTrailingSlash(env.PTD_URL);
  if (env.PTD_TOKEN) out.token = env.PTD_TOKEN;
  if (env.PTD_ORG_ID && /^\d+$/.test(env.PTD_ORG_ID)) out.orgId = Number(env.PTD_ORG_ID);
  return out;
}

export function writeConfig(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body: Config = {};
  if (config.baseUrl) body.baseUrl = stripTrailingSlash(config.baseUrl);
  if (config.token) body.token = config.token;
  if (config.orgId !== undefined) body.orgId = config.orgId;
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file; an existing one
  // keeps whatever bits it had, so set them every time.
  chmodSync(path, 0o600);
  return path;
}

/** Forget the credential but keep the URL, so `ptd login` needs no `--url` again. */
export function clearCredentials(env: NodeJS.ProcessEnv = process.env): { path: string; hadToken: boolean } {
  const path = configPath(env);
  const current = readFileConfigOnly(env);
  const hadToken = Boolean(current.token);
  if (current.baseUrl) writeConfig({ baseUrl: current.baseUrl }, env);
  else
    try {
      unlinkSync(path);
    } catch {
      /* nothing to remove */
    }
  return { path, hadToken };
}

/** The file's own contents, ignoring PTD_* overrides. */
export function readFileConfigOnly(env: NodeJS.ProcessEnv = process.env): Config {
  const { PTD_URL: _u, PTD_TOKEN: _t, PTD_ORG_ID: _o, ...rest } = env;
  return readConfig(rest as NodeJS.ProcessEnv);
}

/** Permission bits of the config file, or null when it does not exist. */
export function configMode(env: NodeJS.ProcessEnv = process.env): number | null {
  try {
    return statSync(configPath(env)).mode & 0o777;
  } catch {
    return null;
  }
}
