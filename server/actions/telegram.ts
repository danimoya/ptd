// telegram actions — registered by importing this module (see ./index.ts).
//
// The Telegram adapter's own control surface: pointing the bot's webhook at this
// deployment, minting a link code, and turning the bot off for an organization. They
// are registry actions rather than bespoke endpoints so the Org UI, MCP and REST all
// reach them the same way, under the same role gate.

import { z } from "zod";
import { ActionError, defineAction } from "./registry";
import { hasRole } from "../types";
import { getMe, getWebhookInfo, setWebhook, deleteWebhook } from "../integrations/telegram/api";
import {
  TELEGRAM_BASE_PATH,
  isTelegramConfigured,
  telegramWebhookUrl,
  webhookSecretPath,
} from "../integrations/telegram/config";
import {
  getTelegramForOrg,
  patchTelegramConfig,
  removeTelegramForOrg,
  saveTelegramRegistration,
} from "../integrations/telegram/store";
import {
  removeTelegramIdentitiesForUser,
  telegramIdentitiesForUser,
  orgChoiceOf,
} from "../integrations/telegram/identity";
import { mintLinkCode } from "../integrations/shared/linkCodes";
import { TELEGRAM_PROVIDER } from "../integrations/shared/providers";

async function requireRegistration(orgId: number) {
  const row = await getTelegramForOrg(orgId);
  if (!row || !row.enabled) {
    throw new ActionError(
      "not_found",
      "Telegram is not switched on for this organization yet — an admin has to register the bot's webhook first.",
    );
  }
  return row;
}

defineAction({
  name: "telegram.status",
  title: "Telegram status",
  description:
    "Whether this server has a bot token, whether this organization has switched the bot on, the bot's @username, and whether the caller's own Telegram account is linked. Never returns the bot token or the webhook secret.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => {
    const configured = isTelegramConfigured();
    const row = await getTelegramForOrg(ctx.orgId);
    const identities = await telegramIdentitiesForUser(ctx.userId);
    return {
      appConfigured: configured,
      connected: !!row && row.enabled,
      canManage: hasRole(ctx.role, "admin"),
      botUsername: row?.config.botUsername ?? null,
      botLink: row?.config.botUsername ? `https://t.me/${row.config.botUsername}` : null,
      webhookSetAt: row?.config.webhookSetAt ?? null,
      registeredBy: row?.config.registeredBy ?? null,
      lastError: row?.config.lastError ?? null,
      /** The shape of the path only — the secret in it is never handed to a browser. */
      webhookPath: configured ? `${TELEGRAM_BASE_PATH}/webhook/<secret>` : null,
      linked: identities.length > 0,
      telegramUserId: identities[0] ?? null,
      /** Which organization this caller's Telegram `/org` choice currently points at. */
      selectedOrgId: identities[0] ? await orgChoiceOf(identities[0]) : null,
    };
  },
});

defineAction({
  name: "telegram.register_webhook",
  title: "Register the Telegram webhook",
  description:
    "Point the bot at this deployment with `setWebhook`, and switch Telegram on for this organization. The URL carries a secret derived from PTD_SECRET_KEY and the bot token, so it is unguessable and rotates with either of them. One bot serves every organization on this server: registering it again from another organization is harmless and simply re-points the same bot here.",
  input: z.object({}),
  requiredRole: "admin",
  audited: true,
  surface: "org",
  handler: async (_args, ctx) => {
    if (!isTelegramConfigured()) {
      throw new ActionError("invalid", "Telegram bot not configured on this server (TELEGRAM_BOT_TOKEN).");
    }
    const url = telegramWebhookUrl();
    if (!url.startsWith("https://")) {
      throw new ActionError(
        "invalid",
        `Telegram only delivers to HTTPS, and this deployment's PTD_BASE_URL is "${url || "unset"}". Set PTD_BASE_URL to the public https:// origin first.`,
      );
    }

    const me = await getMe();
    const result = await setWebhook({ url, secretToken: webhookSecretPath() });
    if (!result.ok) {
      await patchTelegramConfig(ctx.orgId, { lastError: result.error ?? "setWebhook_failed" }).catch(() => null);
      throw new ActionError("conflict", `Telegram refused setWebhook: ${result.error ?? "unknown error"}`);
    }

    const row = await saveTelegramRegistration(ctx.orgId, ctx.userId, {
      botUsername: me.ok ? me.bot.username : null,
      botId: me.ok ? me.bot.id : null,
      webhookUrl: url,
      webhookSetAt: new Date().toISOString(),
      lastError: null,
    });
    return {
      registered: true,
      botUsername: row.config.botUsername,
      botLink: row.config.botUsername ? `https://t.me/${row.config.botUsername}` : null,
      webhookUrl: url,
      warning: me.ok ? null : `getMe failed (${me.error}) — the webhook is set, but the bot's @username is unknown`,
    };
  },
});

defineAction({
  name: "telegram.webhook_info",
  title: "Telegram webhook info",
  description:
    "What Telegram itself thinks the webhook is: the URL it delivers to, how many updates are queued, and the last delivery error it saw. The fastest way to tell a wrong PTD_BASE_URL from a firewall.",
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  handler: async () => {
    if (!isTelegramConfigured()) throw new ActionError("invalid", "Telegram bot not configured on this server (TELEGRAM_BOT_TOKEN).");
    const info = await getWebhookInfo();
    if (!info.ok) throw new ActionError("conflict", `Telegram refused getWebhookInfo: ${info.error}`);
    return { ...info.info, expected: telegramWebhookUrl(), matches: info.info.url === telegramWebhookUrl() };
  },
});

defineAction({
  name: "telegram.link_code",
  title: "Mint a Telegram link code",
  description:
    "A six-character one-time code, valid for ten minutes, that binds a Telegram account to the calling PTD user. Send `/link <code>` to the bot to spend it. Minting a new code invalidates the caller's previous one.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => {
    const row = await requireRegistration(ctx.orgId);
    const minted = await mintLinkCode(TELEGRAM_PROVIDER, { userId: ctx.userId, orgId: ctx.orgId, displayName: ctx.displayName });
    return {
      code: minted.code,
      command: `/link ${minted.code}`,
      expiresAt: minted.expiresAt.toISOString(),
      ttlMinutes: minted.ttlMinutes,
      botUsername: row.config.botUsername,
      botLink: row.config.botUsername ? `https://t.me/${row.config.botUsername}` : null,
    };
  },
});

defineAction({
  name: "telegram.unlink",
  title: "Unlink my Telegram account",
  description: "Forget every Telegram identity bound to the calling PTD user. Their commands stop working until they link again.",
  input: z.object({}),
  requiredRole: "member",
  audited: true,
  surface: "org",
  handler: async (_args, ctx) => ({ removed: await removeTelegramIdentitiesForUser(ctx.userId) }),
});

defineAction({
  name: "telegram.disconnect",
  title: "Switch Telegram off",
  description:
    "Turn the bot off for this organization: link codes stop being minted and DMs stop. Members keep their link records, and the bot itself keeps serving any other organization on this server — so the webhook is left registered unless `deleteWebhook` is asked for explicitly.",
  input: z.object({
    deleteWebhook: z
      .boolean()
      .default(false)
      .describe("Also unregister the webhook with Telegram. This affects EVERY organization on this server."),
  }),
  requiredRole: "admin",
  audited: true,
  surface: "org",
  handler: async (args, ctx) => {
    const removed = await removeTelegramForOrg(ctx.orgId);
    if (removed === 0) throw new ActionError("not_found", "Telegram was not switched on for this organization.");
    let webhookRemoved = false;
    if (args.deleteWebhook) {
      const result = await deleteWebhook();
      webhookRemoved = result.ok;
    }
    return { disconnected: true, removed, webhookRemoved };
  },
});
