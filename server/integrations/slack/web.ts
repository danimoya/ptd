/**
 * The slice of Slack's Web API this adapter needs, over plain `fetch` — no
 * @slack/bolt, no @slack/web-api, nothing added to package.json.
 *
 * Nothing in here throws: an outbound notification must never be able to fail the
 * task mutation that triggered it, so every call resolves with `{ok:false,error}`
 * instead.
 */

export const SLACK_API_BASE = "https://slack.com/api";
export const SLACK_TIMEOUT_MS = 5_000;

export interface SlackApiResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function request(url: string, init: RequestInit, timeoutMs: number, acceptPlainText = false): Promise<SlackApiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: SlackApiResult;
    try {
      body = JSON.parse(text) as SlackApiResult;
    } catch {
      // response_url answers with the literal string "ok", not JSON.
      if (acceptPlainText && res.ok) return { ok: text.trim().toLowerCase() === "ok", raw: text.trim() };
      return { ok: false, error: `non_json_response (HTTP ${res.status})` };
    }
    if (!res.ok && body.ok === undefined) return { ok: false, error: `http_${res.status}` };
    return body;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: controller.signal.aborted ? `timeout_after_${timeoutMs}ms` : message };
  } finally {
    clearTimeout(timer);
  }
}

/** A bot-token call: `Authorization: Bearer xoxb-…`, JSON body. */
export function slackApi(method: string, token: string, payload: Record<string, unknown>, timeoutMs = SLACK_TIMEOUT_MS): Promise<SlackApiResult> {
  if (!token) return Promise.resolve({ ok: false, error: "no_bot_token" });
  return request(
    `${SLACK_API_BASE}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}`, "User-Agent": "ptd-slack/1" },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );
}

export interface OutboundMessage {
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
  unfurlLinks?: boolean;
}

/** `chat.postMessage`. A user id as `channel` opens (or reuses) a DM with that user. */
export function postMessage(token: string, message: OutboundMessage): Promise<SlackApiResult> {
  return slackApi("chat.postMessage", token, {
    channel: message.channel,
    text: message.text,
    ...(message.blocks ? { blocks: message.blocks } : {}),
    ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
    unfurl_links: message.unfurlLinks ?? false,
  });
}

/** `oauth.v2.access` — form-encoded, no bearer token (the client secret authenticates it). */
export function oauthAccess(params: Record<string, string>, timeoutMs = SLACK_TIMEOUT_MS): Promise<SlackApiResult> {
  return request(
    `${SLACK_API_BASE}/oauth.v2.access`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "ptd-slack/1" },
      body: new URLSearchParams(params).toString(),
    },
    timeoutMs,
  );
}

/**
 * Late reply to a slash command. `response_url` is valid for 30 minutes and up to
 * five posts, and needs no token — the URL is the credential.
 */
export async function postToResponseUrl(responseUrl: string, body: unknown, timeoutMs = SLACK_TIMEOUT_MS): Promise<SlackApiResult> {
  if (!responseUrl) return { ok: false, error: "no_response_url" };
  return request(
    responseUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": "ptd-slack/1" },
      body: JSON.stringify(body),
    },
    timeoutMs,
    true,
  );
}
