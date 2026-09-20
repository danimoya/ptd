import type { Express, Request, Response } from "express";
import { replyToTelegramHtml } from "../shared/markup";
import { TELEGRAM_BASE_PATH, TELEGRAM_SECRET_HEADER, isTelegramConfigured, secretPathMatches, telegramBotToken } from "./config";
import { handleTelegramMessage, readUpdate } from "./commands";

/**
 * HTTP surface of the Telegram adapter. `registerTelegramRoutes(app)` is the only
 * export the rest of the server needs.
 *
 *   POST /api/integrations/telegram/webhook/<secret>   ← Telegram (unauthenticated)
 *
 * There is exactly one route, and no signature to check: Telegram authenticates a
 * webhook by the URL it was given, so the secret in the path (derived from
 * `HMAC(PTD_SECRET_KEY, bot token)` — see `./config.ts`) is the credential, and the
 * `secret_token` header `setWebhook` was given is checked too when it is present.
 *
 * The reply travels back on this same connection. Telegram accepts a Bot API method
 * call as the body of the webhook response, so a command costs one HTTP request in
 * total and works even where outbound access to api.telegram.org is closed. Everything
 * that is *not* a reply to a command — the assignment and cascade DMs — does go out
 * through the Bot API (`./notify.ts`).
 */

export function registerTelegramRoutes(app: Express): void {
  app.post(`${TELEGRAM_BASE_PATH}/webhook/:secret`, async (req: Request, res: Response) => {
    const token = telegramBotToken();
    if (!isTelegramConfigured(token)) {
      return res.status(503).json({ error: "telegram_not_configured", message: "TELEGRAM_BOT_TOKEN is not set on this server" });
    }
    if (!secretPathMatches(req.params.secret ?? "", token)) {
      // Deliberately indistinguishable from a route that does not exist.
      return res.status(404).json({ error: "not_found" });
    }
    const header = req.header(TELEGRAM_SECRET_HEADER);
    if (header && !secretPathMatches(header, token)) {
      return res.status(401).json({ error: "bad_secret_token" });
    }

    const message = readUpdate(req.body);
    // 200 with an empty body: an update that is not a message (a reaction, a bot, a
    // join) is not an error, and anything else makes Telegram retry it forever.
    if (!message || !message.text || message.chatId === null) return res.status(200).json({ ok: true });

    try {
      const handled = await handleTelegramMessage(message);
      return res.status(200).json({
        method: "sendMessage",
        chat_id: message.chatId,
        text: replyToTelegramHtml(handled.reply),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      console.error("[telegram] update failed:", err);
      return res.status(200).json({
        method: "sendMessage",
        chat_id: message.chatId,
        text: "Something went wrong on the PTD side — the server log has the details.",
      });
    }
  });
}
