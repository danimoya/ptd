import { callAction } from "@/lib/api";

/** Client face of the Telegram adapter: all registry actions, no redirects. */

export interface TelegramStatus {
  /** TELEGRAM_BOT_TOKEN is set on the server. */
  appConfigured: boolean;
  connected: boolean;
  canManage: boolean;
  botUsername: string | null;
  botLink: string | null;
  webhookSetAt: string | null;
  registeredBy: number | null;
  lastError: string | null;
  webhookPath: string | null;
  /** Whether the caller's own Telegram account is bound to their PTD user. */
  linked: boolean;
  telegramUserId: string | null;
  selectedOrgId: number | null;
}

export interface TelegramLinkCode {
  code: string;
  command: string;
  expiresAt: string;
  ttlMinutes: number;
  botUsername: string | null;
  botLink: string | null;
}

export interface TelegramRegistration {
  registered: boolean;
  botUsername: string | null;
  botLink: string | null;
  webhookUrl: string;
  warning: string | null;
}

export interface TelegramWebhookInfo {
  url: string | null;
  pendingUpdateCount: number | null;
  lastErrorMessage: string | null;
  lastErrorDate: number | null;
  expected: string;
  matches: boolean;
}

export const TELEGRAM_STATUS_KEY = ["/api/actions/telegram.status"] as const;

export const getTelegramStatus = () => callAction<TelegramStatus>("telegram.status", {});
export const registerTelegramWebhook = () => callAction<TelegramRegistration>("telegram.register_webhook", {});
export const getTelegramWebhookInfo = () => callAction<TelegramWebhookInfo>("telegram.webhook_info", {});
export const mintTelegramLinkCode = () => callAction<TelegramLinkCode>("telegram.link_code", {});
export const unlinkTelegram = () => callAction<{ removed: number }>("telegram.unlink", {});
export const disconnectTelegram = () => callAction<{ disconnected: boolean; webhookRemoved: boolean }>("telegram.disconnect", {});

export const TELEGRAM_COMMANDS: { usage: string; note: string; role?: string }[] = [
  { usage: "/next", note: "the highest-priority task worth starting" },
  { usage: "/start PTD-12 [notes]", note: "start your timer on a task" },
  { usage: "/stop [tokens=N cost=0.12]", note: "stop your timer" },
  { usage: "/log 45m PTD-12 [notes]", note: "log a session that ended just now" },
  { usage: "/today", note: "your day so far" },
  { usage: "/tasks [status]", note: "the organization's open tasks" },
  { usage: "/plan PTD-12 2026-10-01 [days]", note: "schedule a task, cascade its dependents", role: "manager" },
  { usage: "/done PTD-12", note: "mark a task complete" },
  { usage: "/who", note: "which PTD user this Telegram account is" },
  { usage: "/stats", note: "organization KPI roll-up", role: "manager" },
  { usage: "/org <id>", note: "act on another organization you belong to" },
  { usage: "/help", note: "only the commands your role allows" },
];
