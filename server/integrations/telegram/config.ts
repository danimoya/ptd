import { createHmac, timingSafeEqual } from "crypto";
import type { Request } from "express";
import { publicBaseUrl } from "../shared/publicUrl";

/**
 * App-level Telegram configuration.
 *
 * One bot serves the whole deployment — a Telegram bot belongs to a token, not to an
 * organization — so `TELEGRAM_BOT_TOKEN` is the only env var. Which organization a
 * command acts on comes from the person typing it (see `./identity.ts`).
 *
 * Telegram has no request signature: whoever knows the webhook URL can post to it. So
 * the URL *is* the credential, and the path carries a secret derived from
 * `HMAC(PTD_SECRET_KEY, bot token)` — deterministic (so `register_webhook` and the
 * route always agree without storing anything), unguessable, and rotated for free by
 * rotating either input. `setWebhook` is also given the same value as its
 * `secret_token`, so genuine deliveries additionally carry
 * `X-Telegram-Bot-Api-Secret-Token` and an attacker needs the URL *and* the header.
 */

export const TELEGRAM_BASE_PATH = "/api/integrations/telegram";
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
/** 128 bits of the HMAC is plenty for a path segment, and keeps the URL readable. */
export const SECRET_PATH_LENGTH = 32;

const env = (name: string): string => (process.env[name] ?? "").trim();

export function telegramBotToken(): string {
  return env("TELEGRAM_BOT_TOKEN");
}

export function isTelegramConfigured(token = telegramBotToken()): boolean {
  return token.length > 0;
}

function secretKey(): string {
  const raw = process.env.PTD_SECRET_KEY;
  if (raw) return raw;
  if (process.env.NODE_ENV === "production") throw new Error("PTD_SECRET_KEY must be set in production");
  return "ptd-dev-secret-key";
}

/** The path segment (and `secret_token`) for the current bot token. */
export function webhookSecretPath(token = telegramBotToken()): string {
  if (!token) return "";
  return createHmac("sha256", secretKey()).update(`telegram-webhook:${token}`, "utf8").digest("hex").slice(0, SECRET_PATH_LENGTH);
}

export function telegramWebhookPath(token = telegramBotToken()): string {
  return `${TELEGRAM_BASE_PATH}/webhook/${webhookSecretPath(token)}`;
}

/** Constant-time comparison — the path secret is a credential like any other. */
export function secretPathMatches(candidate: string, token = telegramBotToken()): boolean {
  const expected = webhookSecretPath(token);
  if (!expected) return false;
  const a = Buffer.from(candidate ?? "", "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Public origin of this deployment — shared with the other adapters. */
export { publicBaseUrl } from "../shared/publicUrl";

/** The absolute URL handed to `setWebhook`. */
export function telegramWebhookUrl(req?: Request, token = telegramBotToken()): string {
  return `${publicBaseUrl(req)}${telegramWebhookPath(token)}`;
}

/** How a Telegram user types a command: `/next`. */
export const TELEGRAM_PREFIX = "/";
