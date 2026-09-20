import { telegramBotToken } from "./config";

/**
 * The slice of Telegram's Bot API this adapter needs, over plain `fetch` — no
 * node-telegram-bot-api, nothing added to package.json.
 *
 * Nothing in here throws: an outbound DM must never be able to fail the task mutation
 * that triggered it, so every call resolves with `{ok:false,error}` instead.
 *
 * Note that command *replies* do not come through here at all. Telegram lets a webhook
 * answer by returning a method call as its HTTP response, so a reply is one JSON body
 * on the connection that is already open (see `./routes.ts`) rather than a second
 * round trip — which also means a command works on a deployment whose outbound access
 * to api.telegram.org is blocked.
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const TELEGRAM_TIMEOUT_MS = 5_000;

export interface TelegramResult {
  ok: boolean;
  error?: string;
  result?: unknown;
  description?: string;
}

export async function telegramApi(
  method: string,
  payload: Record<string, unknown>,
  token = telegramBotToken(),
  timeoutMs = TELEGRAM_TIMEOUT_MS,
): Promise<TelegramResult> {
  if (!token) return { ok: false, error: "no_bot_token" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "ptd-telegram/1" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: TelegramResult;
    try {
      body = JSON.parse(text) as TelegramResult;
    } catch {
      return { ok: false, error: `non_json_response (HTTP ${res.status})` };
    }
    if (!body.ok) return { ok: false, error: body.description ?? `http_${res.status}` };
    return body;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: controller.signal.aborted ? `timeout_after_${timeoutMs}ms` : message };
  } finally {
    clearTimeout(timer);
  }
}

export interface SendMessage {
  chatId: string | number;
  /** Telegram HTML (see ../shared/markup). */
  html: string;
  silent?: boolean;
}

export function sendMessage(message: SendMessage, token = telegramBotToken()): Promise<TelegramResult> {
  return telegramApi(
    "sendMessage",
    {
      chat_id: message.chatId,
      text: message.html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(message.silent ? { disable_notification: true } : {}),
    },
    token,
  );
}

export interface BotIdentity {
  id: number | null;
  username: string | null;
  firstName: string | null;
}

/** `getMe` — used to store the bot's @username so the UI can tell people who to talk to. */
export async function getMe(token = telegramBotToken()): Promise<{ ok: true; bot: BotIdentity } | { ok: false; error: string }> {
  const res = await telegramApi("getMe", {}, token);
  if (!res.ok) return { ok: false, error: res.error ?? "getMe_failed" };
  const result = (res.result ?? {}) as { id?: number; username?: string; first_name?: string };
  return { ok: true, bot: { id: result.id ?? null, username: result.username ?? null, firstName: result.first_name ?? null } };
}

/** `setWebhook`. `secretToken` arrives back on every delivery as a header. */
export function setWebhook(
  input: { url: string; secretToken?: string; allowedUpdates?: string[] },
  token = telegramBotToken(),
): Promise<TelegramResult> {
  return telegramApi(
    "setWebhook",
    {
      url: input.url,
      ...(input.secretToken ? { secret_token: input.secretToken } : {}),
      allowed_updates: input.allowedUpdates ?? ["message", "edited_message"],
      drop_pending_updates: false,
    },
    token,
  );
}

export function deleteWebhook(token = telegramBotToken()): Promise<TelegramResult> {
  return telegramApi("deleteWebhook", { drop_pending_updates: false }, token);
}

export interface WebhookInfo {
  url: string | null;
  pendingUpdateCount: number | null;
  lastErrorMessage: string | null;
  lastErrorDate: number | null;
}

export async function getWebhookInfo(token = telegramBotToken()): Promise<{ ok: true; info: WebhookInfo } | { ok: false; error: string }> {
  const res = await telegramApi("getWebhookInfo", {}, token);
  if (!res.ok) return { ok: false, error: res.error ?? "getWebhookInfo_failed" };
  const result = (res.result ?? {}) as {
    url?: string;
    pending_update_count?: number;
    last_error_message?: string;
    last_error_date?: number;
  };
  return {
    ok: true,
    info: {
      url: result.url ?? null,
      pendingUpdateCount: result.pending_update_count ?? null,
      lastErrorMessage: result.last_error_message ?? null,
      lastErrorDate: result.last_error_date ?? null,
    },
  };
}
