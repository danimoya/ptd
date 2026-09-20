// Organization actions — registered by importing this module (see ./index.ts).
//
// The REST routes in `server/orgs.ts` remain the browser's path for creating and
// accepting invitations; what an agent or a script needs on top of that is the
// ability to *send the letter again* when the first one bounced, was filtered, or
// expired before anyone opened it. That is this file.
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { invitations } from "../../db/schema";
import { ActionError, defineAction } from "./registry";
import { INVITATION_TTL_MS, mailInvitation, orgNameOf } from "../orgs";
import { invitationUrl } from "../email/send";

defineAction({
  name: "invitation.resend",
  title: "Resend an invitation",
  description:
    "Mail an outstanding invitation again and push its expiry out another seven days. The token is unchanged, so a link from the first letter still works. " +
    "Returns `acceptUrl` and a `delivery` verdict: `{sent:true}`, or `{sent:false, reason:\"smtp_not_configured\"}` on a deployment with no SMTP — in which case paste `acceptUrl` to the invitee yourself. " +
    "An invitation that has already been accepted cannot be resent.",
  input: z.object({
    invitationId: z.number().int().positive().describe("Invitation id, from GET /api/orgs/current/invitations."),
  }),
  requiredRole: "admin",
  surface: "org",
  handler: async (args, ctx) => {
    const [invite] = await db
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, args.invitationId), eq(invitations.orgId, ctx.orgId)))
      .limit(1);
    if (!invite) throw new ActionError("not_found", `No invitation ${args.invitationId} in this organization`);
    if (invite.acceptedAt) throw new ActionError("conflict", `${invite.email} has already accepted this invitation`);

    // A resend usually happens *because* the first letter went stale, so the
    // expiry is renewed rather than left in the past.
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await db.update(invitations).set({ expiresAt }).where(eq(invitations.id, invite.id));

    const orgName = await orgNameOf(ctx.orgId);
    const delivery = await mailInvitation({ ...invite, expiresAt }, orgName, ctx.displayName);
    return {
      invitationId: invite.id,
      email: invite.email,
      role: invite.role,
      orgName,
      expiresAt: expiresAt.toISOString(),
      acceptUrl: invitationUrl(invite.token),
      delivery,
    };
  },
});
