// teams actions — registered by importing this module (see ./index.ts).
//
// The Teams adapter's own control surface: storing the Outgoing Webhook's secret,
// minting a link code, and disconnecting. They are registry actions rather than bespoke
// endpoints so the Org UI, MCP and REST all reach them the same way, under the same role
// gate.

import { z } from "zod";
import { ActionError, defineAction } from "./registry";
import { hasRole } from "../types";
import { TEAMS_BASE_PATH } from "../integrations/teams/config";
import {
  getTeamsForOrg,
  removeTeamsForOrg,
  saveTeamsConnection,
  allTeamsRows,
  secretOf,
} from "../integrations/teams/store";
import { looksLikeTeamsSecret } from "../integrations/teams/verify";
import { removeTeamsIdentitiesForUser, teamsIdentitiesForUser } from "../integrations/teams/identity";
import { mintLinkCode } from "../integrations/shared/linkCodes";
import { TEAMS_PROVIDER } from "../integrations/shared/providers";
import { publicBaseUrl } from "../integrations/shared/publicUrl";

async function requireConnection(orgId: number) {
  const row = await getTeamsForOrg(orgId);
  if (!row || !row.enabled) {
    throw new ActionError(
      "not_found",
      "Microsoft Teams is not connected to this organization yet — an admin has to create an Outgoing Webhook in Teams and store its secret here first.",
    );
  }
  return row;
}

defineAction({
  name: "teams.status",
  title: "Microsoft Teams status",
  description:
    "Whether this organization has connected a Teams Outgoing Webhook, which team it is, and whether the caller's own Teams account is linked. Never returns the webhook secret — it is sealed with AES-256-GCM at rest.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => {
    const row = await getTeamsForOrg(ctx.orgId);
    const identities = await teamsIdentitiesForUser(ctx.userId);
    return {
      // Teams needs no server-side app: an Outgoing Webhook is created inside Teams.
      appConfigured: true,
      connected: !!row && row.enabled,
      canManage: hasRole(ctx.role, "admin"),
      teamName: row?.config.teamName ?? null,
      connectedAt: row?.config.connectedAt ?? null,
      connectedBy: row?.config.connectedBy ?? null,
      lastEventAt: row?.config.lastEventAt ?? null,
      lastError: row?.config.lastError ?? null,
      callbackUrl: `${publicBaseUrl()}${TEAMS_BASE_PATH}/webhook`,
      linked: identities.length > 0,
      aadObjectId: identities[0] ?? null,
    };
  },
});

defineAction({
  name: "teams.connect",
  title: "Connect Microsoft Teams",
  description:
    "Store the secret Teams showed when the Outgoing Webhook was created. That secret is the whole credential: it verifies every `Authorization: HMAC …` header AND identifies this organization, since an Outgoing Webhook delivery carries nothing else worth trusting. It is sealed at rest and never shown again.",
  input: z.object({
    secret: z.string().min(16).max(200).describe("The base64 secret Teams displayed once, when the Outgoing Webhook was created"),
    teamName: z.string().max(200).optional().describe("Which Teams team this is, for the Org UI"),
  }),
  requiredRole: "admin",
  surface: "org",
  handler: async (args, ctx) => {
    const secret = args.secret.trim();
    if (!looksLikeTeamsSecret(secret)) {
      throw new ActionError(
        "invalid",
        "That does not look like a Teams webhook secret — it is a long base64 string, copied from the Outgoing Webhook dialog at creation time (it is only shown once).",
      );
    }
    // Two organizations sharing one secret would make a delivery ambiguous, and the
    // first match would silently win.
    for (const row of await allTeamsRows()) {
      if (row.orgId !== ctx.orgId && secretOf(row.config) === secret) {
        throw new ActionError("conflict", "That secret is already connected to another organization on this server — create a separate Outgoing Webhook for this one.");
      }
    }
    const row = await saveTeamsConnection(ctx.orgId, ctx.userId, { secret, teamName: args.teamName ?? null });
    return {
      connected: true,
      teamName: row.config.teamName,
      callbackUrl: `${publicBaseUrl()}${TEAMS_BASE_PATH}/webhook`,
      next: "In Teams, @mention the webhook and send `@PTD link <code>` with a code from this page.",
    };
  },
});

defineAction({
  name: "teams.link_code",
  title: "Mint a Teams link code",
  description:
    "A six-character one-time code, valid for ten minutes, that binds a Teams account to the calling PTD user. Send `@PTD link <code>` in the team to spend it. Minting a new code invalidates the caller's previous one.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => {
    const row = await requireConnection(ctx.orgId);
    const minted = await mintLinkCode(TEAMS_PROVIDER, { userId: ctx.userId, orgId: ctx.orgId, displayName: ctx.displayName });
    return {
      code: minted.code,
      command: `@PTD link ${minted.code}`,
      expiresAt: minted.expiresAt.toISOString(),
      ttlMinutes: minted.ttlMinutes,
      teamName: row.config.teamName,
    };
  },
});

defineAction({
  name: "teams.unlink",
  title: "Unlink my Teams account",
  description: "Forget every Teams identity bound to the calling PTD user. Their commands stop working until they link again.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => ({ removed: await removeTeamsIdentitiesForUser(ctx.userId) }),
});

defineAction({
  name: "teams.disconnect",
  title: "Disconnect Microsoft Teams",
  description:
    "Destroy the stored secret: `@PTD …` commands from that team stop being recognised. Members keep their link records, so re-connecting a new Outgoing Webhook picks up where it left off. Delete the webhook in Teams too, or it will keep posting to a URL that now refuses it.",
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  handler: async (_args, ctx) => {
    const removed = await removeTeamsForOrg(ctx.orgId);
    if (removed === 0) throw new ActionError("not_found", "Microsoft Teams was not connected to this organization.");
    return { disconnected: true, removed };
  },
});
