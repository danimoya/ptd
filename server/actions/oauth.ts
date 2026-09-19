// OAuth connector administration — registered by importing this module (see ./index.ts).
//
// Two audiences: an admin wants to see which MCP clients have registered against
// this deployment and cut one off; a member wants to see what they personally
// approved and withdraw it. Neither can widen anyone's permissions — an OAuth
// grant only ever carries the membership role the approver already had.
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { oauthClients } from "../../db/schema";
import { ActionError, defineAction } from "./registry";
import { grantsForClient, grantsForOrg, grantsForUser, revokeGrantById } from "../oauth/store";
import type { GrantRow } from "../oauth/store";

function live(row: GrantRow, now = Date.now()): boolean {
  return !row.revokedAt && new Date(row.expiresAt).getTime() > now;
}

function grantView(row: GrantRow) {
  return {
    grantId: row.grantId,
    clientId: row.clientId,
    clientName: row.clientName ?? "(registration deleted)",
    scope: row.scope,
    approvedAt: row.createdAt,
    refreshExpiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    accessTokenRevokedAt: row.accessTokenRevokedAt,
    lastUsedAt: row.lastUsedAt,
    active: live(row),
  };
}

/* ───────────────────────────────── admin+ ───────────────────────────────── */

defineAction({
  name: "oauth.clients",
  title: "List OAuth clients",
  description:
    "Every MCP client that has registered against this deployment's OAuth server (Claude.ai and ChatGPT connectors register themselves), " +
    "with how many grants your organization has approved for each. Registration alone grants nothing — only a member's consent does.",
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  handler: async (_args, ctx) => {
    const [clients, grants] = await Promise.all([
      db.select().from(oauthClients).orderBy(oauthClients.createdAt),
      grantsForOrg(ctx.orgId),
    ]);
    const now = Date.now();
    return clients.map((c) => {
      const mine = grants.filter((g) => g.clientId === c.clientId);
      return {
        clientId: c.clientId,
        clientName: c.clientName,
        redirectUris: c.redirectUris,
        grantTypes: c.grantTypes,
        tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
        confidential: c.clientSecretHash !== null,
        registeredAt: c.createdAt,
        grantsInOrg: {
          active: mine.filter((g) => live(g, now)).length,
          total: mine.length,
          members: Array.from(new Set(mine.filter((g) => live(g, now)).map((g) => g.userId))).length,
        },
      };
    });
  },
});

defineAction({
  name: "oauth.revoke_client",
  title: "Revoke an OAuth client",
  description:
    "Cuts an MCP client off from your organization: every grant this organization approved for it is revoked, access tokens included. " +
    "The registration itself is deleted too when no other organization still has a live grant on it.",
  input: z.object({ clientId: z.string().min(1).max(64).describe("client_id, from oauth.clients.") }),
  requiredRole: "admin",
  surface: "org",
  handler: async (args, ctx) => {
    const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, args.clientId)).limit(1);
    if (!client) throw new ActionError("not_found", `No OAuth client with client_id ${args.clientId}`);

    const all = await grantsForClient(args.clientId);
    const mine = all.filter((g) => g.orgId === ctx.orgId && live(g));
    for (const g of mine) await revokeGrantById(g.grantId, { orgId: ctx.orgId });

    const elsewhere = all.filter((g) => g.orgId !== ctx.orgId && live(g)).length;
    const deleted = elsewhere === 0;
    if (deleted) await db.delete(oauthClients).where(eq(oauthClients.clientId, args.clientId));

    return {
      clientId: args.clientId,
      clientName: client.clientName,
      grantsRevoked: mine.length,
      registrationDeleted: deleted,
      ...(deleted ? {} : { retained: `${elsewhere} live grant(s) in other organizations — the registration was kept so those keep working` }),
    };
  },
});

/* ──────────────────────────────── member+ ───────────────────────────────── */

defineAction({
  name: "oauth.my_grants",
  title: "My connector grants",
  description:
    "The MCP connectors you personally authorized for this organization, newest first, with the scope recorded at consent time, " +
    "when each was last used and whether it is still live. Revoke one with oauth.revoke_grant.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => {
    const rows = await grantsForUser(ctx.userId, ctx.orgId);
    return {
      role: ctx.role,
      note: "A connector always acts with your membership role — a grant never widens it.",
      grants: rows.map(grantView),
    };
  },
});

defineAction({
  name: "oauth.revoke_grant",
  title: "Revoke a connector grant",
  description: "Withdraws one of your own connector authorizations: its refresh token and its live access token both stop working immediately.",
  input: z.object({ grantId: z.number().int().positive().describe("grantId, from oauth.my_grants.") }),
  requiredRole: "member",
  surface: "org",
  handler: async (args, ctx) => {
    const ok = await revokeGrantById(args.grantId, { userId: ctx.userId, orgId: ctx.orgId });
    if (!ok) throw new ActionError("not_found", `No grant ${args.grantId} of yours in this organization`);
    return { grantId: args.grantId, revoked: true };
  },
});
