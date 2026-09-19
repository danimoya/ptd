import { callAction, getAuthHeader } from "@/lib/api";

export interface WebhookRow {
  id: number;
  url: string;
  events: string[];
  enabled: boolean;
  createdBy: number | null;
  createdAt: string;
  secretSet: boolean;
  signatureHeader: string;
}

export interface CreatedWebhook extends WebhookRow {
  secret: string;
  secretShownOnce: true;
  signature: string;
  note: string;
}

export interface WebhookTestResult {
  id: number;
  url: string;
  delivered: boolean;
  status: number | null;
  error: string | null;
  signature: string;
  body: Record<string, unknown>;
}

export const listWebhooks = () => callAction<WebhookRow[]>("webhook.list", {});
export const createWebhook = (input: { url: string; secret?: string; events?: string[] }) => callAction<CreatedWebhook>("webhook.create", input);
export const deleteWebhook = (id: number) => callAction<{ deleted: number }>("webhook.delete", { id });
export const testWebhook = (id: number) => callAction<WebhookTestResult>("webhook.test", { id });

export interface McpProbeResult {
  ok: boolean;
  status: number;
  toolCount?: number;
  tools?: string[];
  error?: string;
}

export interface RawResponse { status: number; body: string }
export type Transport = (url: string, headers: Record<string, string>, body: string) => Promise<RawResponse>;

/**
 * XMLHttpRequest, not fetch, and deliberately so: `installAuthInterceptor` in
 * lib/auth.ts wraps `window.fetch` and signs the user out on ANY 401. Testing a
 * token is exactly the operation that is *supposed* to be able to come back 401,
 * so a fetch-based probe would log the admin out of the app for typing a wrong
 * token. XHR is not wrapped, so the probe can fail without collateral damage.
 */
export const xhrPost: Transport = (url, headers, body) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.timeout = 15_000;
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText ?? "" });
    xhr.onerror = () => reject(new Error("Network request failed"));
    xhr.ontimeout = () => reject(new Error("Request timed out"));
    xhr.send(body);
  });

export const MCP_PROBE_BODY = { jsonrpc: "2.0", id: 1, method: "tools/list" } as const;

/**
 * POST a JSON-RPC `tools/list` straight at /mcp with a token the user pasted.
 * The point is to exercise the bearer token an agent will use — not the browser
 * session — and to accept the SSE framing the MCP transport may answer with.
 */
export async function probeMcp(token: string, transport: Transport = xhrPost): Promise<McpProbeResult> {
  try {
    const { status, body } = await transport(
      "/mcp",
      {
        Authorization: `Bearer ${token.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      JSON.stringify(MCP_PROBE_BODY),
    );
    const parsed = parseJsonRpc(body);
    if (status >= 400) return { ok: false, status, error: parsed?.error?.message || body.trim().slice(0, 200) || `HTTP ${status}` };
    const tools = parsed?.result?.tools;
    if (!Array.isArray(tools)) return { ok: false, status, error: parsed?.error?.message || "No tool list in the response" };
    return { ok: true, status, toolCount: tools.length, tools: tools.map((t: { name: string }) => t.name).sort() };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

interface JsonRpcish { result?: { tools?: { name: string }[] }; error?: { message?: string } }

/** The MCP endpoint may reply as JSON or as a single SSE `data:` frame. Accept both. */
export function parseJsonRpc(raw: string): JsonRpcish | null {
  const body = raw.trim();
  if (!body) return null;
  const direct = tryParse(body);
  if (direct) return direct;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const frame = tryParse(trimmed.slice(5).trim());
      if (frame) return frame;
    }
  }
  return null;
}

function tryParse(s: string): JsonRpcish | null {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as JsonRpcish) : null;
  } catch {
    return null;
  }
}

/** Re-exported so the Tokens tab can show the exact header an integration needs. */
export const authHeaderPreview = () => getAuthHeader()["Authorization"] ?? "";
