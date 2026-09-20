/**
 * The HTTP client. Zero dependencies: Node 20's global `fetch` is all this needs.
 *
 * Everything PTD does is `POST /api/actions/<name>`, so `callAction` is the only
 * function most commands use; `request` covers the handful of plain REST routes
 * (`/api/auth/login`, `/api/auth/me`, `/api/orgs`, `/api/actions`).
 */
import { ApiError } from "./errors.ts";

export interface Client {
  baseUrl: string;
  token?: string;
  orgId?: number;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Send no Authorization header (login). */
  anonymous?: boolean;
  /** Send no X-Org-Id header (routes that resolve the org themselves). */
  noOrg?: boolean;
}

const TIMEOUT_MS = 30_000;

export async function request(client: Client, path: string, options: RequestOptions = {}): Promise<unknown> {
  const url = `${client.baseUrl}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!options.anonymous) {
    if (!client.token) throw new ApiError(401, "unauthenticated", "Not logged in — run `ptd login` first.");
    headers.Authorization = `Bearer ${client.token}`;
  }
  if (!options.noOrg && client.orgId !== undefined) headers["X-Org-Id"] = String(client.orgId);
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const doFetch = client.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = controller.signal.aborted ? `no answer within ${TIMEOUT_MS / 1000}s` : describe(err);
    throw new ApiError(0, "network", `Cannot reach ${client.baseUrl} — ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  const payload = text === "" ? null : parseJson(text);

  if (!response.ok) throw new ApiError(response.status, codeOf(payload, response.status), messageOf(payload, response, text));
  return payload;
}

export function callAction(client: Client, name: string, args: unknown = {}): Promise<unknown> {
  return request(client, `/api/actions/${encodeURIComponent(name)}`, { method: "POST", body: args ?? {} });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

/**
 * PTD answers an action failure with `{error, message}`; the older plain routes
 * answer with `{error}` alone and the express error handler with `{message}`.
 */
function codeOf(payload: unknown, status: number): string {
  const body = payload as { error?: unknown } | null;
  if (body && typeof body.error === "string") return body.error;
  return status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 401 ? "unauthenticated" : "http_error";
}

function messageOf(payload: unknown, response: Response, text: string): string {
  const body = payload as { message?: unknown; error?: unknown } | null;
  if (body && typeof body.message === "string" && body.message !== "") return body.message;
  if (body && typeof body.error === "string" && body.error !== "") return body.error;
  return text === "" ? `HTTP ${response.status} ${response.statusText}` : text.slice(0, 500);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${cause.code}` : err.message;
  }
  return String(err);
}
