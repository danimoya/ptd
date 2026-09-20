// slack actions — registered by importing this module (see ./index.ts).
//
// The Slack adapter's own control surface: minting a link code, choosing the
// notification channel, proving the connection works, and disconnecting. They are
// registry actions rather than bespoke endpoints so the Org UI, MCP and REST all
// reach them the same way, under the same role gate.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { organizations } from "../../db/schema";
import { ActionError, defineAction } from "./registry";
import { hasRole } from "../types";
import { SLACK_SCOPES, isSlackAppConfigured } from "../integrations/slack/config";
import { getSlackForOrg, patchSlackConfig, removeSlackForOrg } from "../integrations/slack/store";
import { mintLinkCode } from "../integrations/slack/linkCodes";
import { removeSlackIdentitiesForUser, slackIdentitiesForUser, teamOf } from "../integrations/slack/identity";
import { checkStreamBudgets, testSlackConnection } from "../integrations/slack/notify";

/**
 * Slack conversation ids: C… channel, G… legacy group, D… DM, then at least eight
 * more characters of which one is a digit. The digit matters — without it a channel
 * *name* like "general" upper-cases into something that looks like a G… id.
 */
const CHANNEL_ID = /^[CDG](?=[A-Z0-9]*\d)[A-Z0-9]{8,}$/;

/** Accepts a raw id or a pasted `<#C0123456789|general>` mention. */
export function normaliseChannelId(raw: string): string | null {
  const mention = /^<#([CDG][A-Z0-9]{8,})(?:\|[^>]*)?>$/i.exec(raw.trim());
  const candidate = (mention ? mention[1] : raw.trim()).toUpperCase();
  return CHANNEL_ID.test(candidate) ? candidate : null;
}

async function requireInstall(orgId: number) {
  const row = await getSlackForOrg(orgId);
  if (!row) throw new ActionError("not_found", "Slack is not connected to this organization yet — an admin has to add the PTD app first.");
  return row;
}

defineAction({
  name: "slack.status",
  title: "Slack status",
  description:
    "Whether this server has a Slack app configured, whether this organization has connected a workspace, which channel notifications go to, and whether the caller's own Slack account is linked. Never returns the bot token.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => {
    const appConfigured = isSlackAppConfigured();
    const row = await getSlackForOrg(ctx.orgId);
    const identities = await slackIdentitiesForUser(ctx.userId);
    const mine = row ? identities.filter((id) => teamOf(id) === row.config.teamId) : [];
    return {
      appConfigured,
      connected: !!row && row.enabled,
      canManage: hasRole(ctx.role, "admin"),
      scopes: [...SLACK_SCOPES],
      teamId: row?.config.teamId ?? null,
      teamName: row?.config.teamName ?? null,
      botUserId: row?.config.botUserId ?? null,
      channelId: row?.config.channelId ?? null,
      installedAt: row?.config.installedAt ?? null,
      installedBy: row?.config.installedBy ?? null,
      linked: mine.length > 0,
      slackUserId: mine[0]?.slice((row?.config.teamId.length ?? 0) + 1) ?? null,
      linkedWorkspaces: identities.map(teamOf),
    };
  },
});

defineAction({
  name: "slack.link_code",
  title: "Mint a Slack link code",
  description:
    "A six-character one-time code, valid for ten minutes, that binds a Slack account to the calling PTD user. Run `/ptd link <code>` in Slack to spend it. Minting a new code invalidates the caller's previous one.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => {
    const row = await requireInstall(ctx.orgId);
    const minted = await mintLinkCode({ userId: ctx.userId, orgId: ctx.orgId, displayName: ctx.displayName });
    return {
      code: minted.code,
      command: `/ptd link ${minted.code}`,
      expiresAt: minted.expiresAt.toISOString(),
      ttlMinutes: minted.ttlMinutes,
      teamName: row.config.teamName,
    };
  },
});

defineAction({
  name: "slack.unlink",
  title: "Unlink my Slack account",
  description: "Forget every Slack identity bound to the calling PTD user. Their slash commands stop working until they link again.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => ({ removed: await removeSlackIdentitiesForUser(ctx.userId) }),
});

defineAction({
  name: "slack.set_channel",
  title: "Set the Slack channel",
  description:
    "Choose the channel completions, cascade shifts and agent-budget alerts are posted to. Invite the PTD bot to the channel first — Slack refuses to post into a channel the app is not in. Assignment notifications are DMs and do not use it.",
  input: z.object({
    channelId: z.string().min(1).max(64).describe("Slack conversation id, e.g. C0123456789 (Slack → channel → About → copy channel ID)."),
  }),
  requiredRole: "admin",
  surface: "org",
  handler: async (args, ctx) => {
    await requireInstall(ctx.orgId);
    const channelId = normaliseChannelId(args.channelId);
    if (!channelId) throw new ActionError("invalid", "That is not a Slack channel id — they look like C0123456789 (Slack → channel → About → copy channel ID).");
    const row = await patchSlackConfig(ctx.orgId, { channelId });
    return { channelId: row?.config.channelId ?? channelId };
  },
});

defineAction({
  name: "slack.test",
  title: "Test the Slack connection",
  description: 'Post "PTD connected" into the configured channel with the stored bot token, so the install, the token and the channel are all proven at once.',
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  handler: async (_args, ctx) => {
    await requireInstall(ctx.orgId);
    const result = await testSlackConnection(ctx.orgId, ctx.displayName);
    if (!result.posted && result.error === "no_channel_configured") {
      throw new ActionError("invalid", "Pick a channel first with slack.set_channel.");
    }
    return result;
  },
});

defineAction({
  name: "slack.check_budgets",
  title: "Check agent budgets now",
  description:
    "Run the agent-budget sweep immediately and post an alert for every stream whose agent spend has passed its budget. The same sweep runs on its own, throttled, as task events arrive; this bypasses the per-stream cooldown.",
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  handler: async (_args, ctx) => {
    await requireInstall(ctx.orgId);
    return checkStreamBudgets(ctx.orgId, { force: true });
  },
});

defineAction({
  name: "slack.disconnect",
  title: "Disconnect Slack",
  description:
    "Remove the workspace install: the sealed bot token is destroyed, notifications stop and slash commands from that workspace stop resolving. Members' link records are left alone, so a re-install picks up where it left off.",
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  handler: async (_args, ctx) => {
    const removed = await removeSlackForOrg(ctx.orgId);
    if (removed === 0) throw new ActionError("not_found", "Slack was not connected to this organization.");
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.orgId)).limit(1);
    return { disconnected: true, removed, org: org?.name ?? null };
  },
});
