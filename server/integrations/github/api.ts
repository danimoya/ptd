import { githubAppEnv } from "./config";
import { signAppJwt } from "./jwt";

/**
 * The slice of GitHub's REST API this adapter needs, over plain `fetch` — no Octokit,
 * nothing added to package.json.
 *
 * Nothing in here throws: an outbound call must never be able to fail the task
 * mutation that triggered it, so every call resolves with `{ok:false,error}` instead.
 * Two credentials are in play — the App JWT for `/app/…`, and a per-installation
 * access token (cached until just before it expires) for everything on a repository.
 */

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_TIMEOUT_MS = 8_000;
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";
/** Renew an installation token this long before GitHub's own expiry. */
const TOKEN_SAFETY_MS = 60_000;

export interface GithubResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Bearer credential: an App JWT or an installation access token. */
  token: string;
  body?: unknown;
  timeoutMs?: number;
  /** Absolute URL override (pagination `Link` headers hand back full URLs). */
  url?: string;
}

export async function githubRequest<T = unknown>(path: string, options: RequestOptions): Promise<GithubResult<T>> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(options.url ?? `${GITHUB_API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: ACCEPT,
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "ptd-github/1",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: T | null = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const message = (data as { message?: string } | null)?.message;
      return { ok: false, status: res.status, data, error: message ? `${res.status}: ${message}` : `http_${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, data: null, error: controller.signal.aborted ? `timeout_after_${timeoutMs}ms` : message };
  } finally {
    clearTimeout(timer);
  }
}

/* ── installation tokens ──────────────────────────────────────────────── */

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, CachedToken>();

/** Test helper: forget every cached installation token. */
export function resetGithubTokenCache(): void {
  tokenCache.clear();
}

export type TokenResult = { ok: true; token: string; expiresAt: number } | { ok: false; error: string };

/**
 * An installation access token, minted with the App JWT and cached until a minute
 * before it expires (GitHub issues them for an hour). Every repository call goes
 * through here, so one org's token is never reused for another's installation.
 */
export async function installationToken(installationId: number, now = Date.now()): Promise<TokenResult> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - TOKEN_SAFETY_MS > now) return { ok: true, token: cached.token, expiresAt: cached.expiresAt };

  const app = githubAppEnv();
  let jwt: string;
  try {
    jwt = signAppJwt({ appId: app.appId, privateKey: app.privateKey }, now);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "cannot_sign_app_jwt" };
  }

  const res = await githubRequest<{ token?: string; expires_at?: string }>(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    token: jwt,
  });
  const token = res.data?.token;
  if (!res.ok || !token) return { ok: false, error: res.error ?? "no_installation_token" };
  const expiresAt = res.data?.expires_at ? Date.parse(res.data.expires_at) : now + 3_600_000;
  tokenCache.set(installationId, { token, expiresAt });
  return { ok: true, token, expiresAt };
}

/* ── app-level reads ──────────────────────────────────────────────────── */

export interface InstallationAccount {
  login: string;
  type: string | null;
  id: number | null;
}

export interface InstallationInfo {
  installationId: number;
  account: InstallationAccount | null;
  repositorySelection: string | null;
}

/** Who the App was installed on, so the UI can say "installed on acme-inc". */
export async function readInstallation(installationId: number, now = Date.now()): Promise<{ ok: true; info: InstallationInfo } | { ok: false; error: string }> {
  const app = githubAppEnv();
  let jwt: string;
  try {
    jwt = signAppJwt({ appId: app.appId, privateKey: app.privateKey }, now);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "cannot_sign_app_jwt" };
  }
  const res = await githubRequest<{
    id?: number;
    account?: { login?: string; type?: string; id?: number };
    repository_selection?: string;
  }>(`/app/installations/${installationId}`, { token: jwt });
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "installation_not_found" };
  const account = res.data.account?.login
    ? { login: res.data.account.login, type: res.data.account.type ?? null, id: res.data.account.id ?? null }
    : null;
  return {
    ok: true,
    info: { installationId: res.data.id ?? installationId, account, repositorySelection: res.data.repository_selection ?? null },
  };
}

/* ── issues ──────────────────────────────────────────────────────────── */

export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  htmlUrl: string | null;
  labels: string[];
  assigneeLogin: string | null;
  milestoneDueOn: string | null;
  authorLogin: string | null;
}

interface RawIssue {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  html_url?: string;
  pull_request?: unknown;
  labels?: (string | { name?: string })[];
  assignee?: { login?: string } | null;
  assignees?: { login?: string }[] | null;
  milestone?: { due_on?: string | null } | null;
  user?: { login?: string } | null;
}

/** Normalise an issue from either the REST list or a webhook body. Pull requests → null. */
export function readIssue(raw: unknown): GithubIssue | null {
  const issue = (raw ?? {}) as RawIssue;
  if (typeof issue.number !== "number" || typeof issue.title !== "string") return null;
  // GitHub models a PR as an issue with a `pull_request` key; PTD tracks issues only.
  if (issue.pull_request) return null;
  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name ?? ""))
    .filter((name): name is string => name.length > 0);
  return {
    number: issue.number,
    title: issue.title,
    body: typeof issue.body === "string" ? issue.body : null,
    state: issue.state === "closed" ? "closed" : "open",
    htmlUrl: typeof issue.html_url === "string" ? issue.html_url : null,
    labels,
    assigneeLogin: issue.assignee?.login ?? issue.assignees?.[0]?.login ?? null,
    milestoneDueOn: issue.milestone?.due_on ?? null,
    authorLogin: issue.user?.login ?? null,
  };
}

export const ISSUES_PER_PAGE = 100;

/** Every open issue of a repo (pull requests excluded), up to `maxPages` pages. */
export async function listOpenIssues(repo: string, token: string, maxPages = 5): Promise<{ ok: true; issues: GithubIssue[] } | { ok: false; error: string }> {
  const issues: GithubIssue[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await githubRequest<unknown[]>(`/repos/${repo}/issues?state=open&per_page=${ISSUES_PER_PAGE}&page=${page}`, { token });
    if (!res.ok || !Array.isArray(res.data)) return { ok: false, error: res.error ?? "cannot_list_issues" };
    for (const raw of res.data) {
      const issue = readIssue(raw);
      if (issue) issues.push(issue);
    }
    if (res.data.length < ISSUES_PER_PAGE) break;
  }
  return { ok: true, issues };
}

export function createIssue(repo: string, token: string, input: { title: string; body?: string; labels?: string[] }) {
  return githubRequest<{ number?: number; html_url?: string }>(`/repos/${repo}/issues`, { method: "POST", token, body: input });
}

export function patchIssue(
  repo: string,
  number: number,
  token: string,
  input: { title?: string; body?: string | null; state?: "open" | "closed"; state_reason?: string },
) {
  return githubRequest<{ number?: number; state?: string }>(`/repos/${repo}/issues/${number}`, { method: "PATCH", token, body: input });
}

/** A user's public email, which is how an issue assignee is matched onto a PTD seat. */
export async function userEmail(login: string, token: string): Promise<string | null> {
  const res = await githubRequest<{ email?: string | null }>(`/users/${encodeURIComponent(login)}`, { token });
  const email = res.data?.email;
  return typeof email === "string" && email.includes("@") ? email : null;
}
