/**
 * The three owner-grade operations: the security policy, taking the data out, and
 * ending the organization.
 *
 * Export and delete are the two halves of "your data is yours": one lets you
 * leave with everything, the other lets you leave nothing behind. Both are
 * deliberately blunt — no partial exports, no soft delete — because a data-rights
 * feature that quietly keeps a copy is worse than none.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { organizations } from "../../db/schema";
import { ActionError, defineAction } from "./registry";
import { audit } from "../audit/log";
import { getOrgSecurity, setOrgSecurity } from "../auth/security";
import { reloadUser } from "../auth/mfa";
import { currentBaseUrl } from "../billing/base";
import { getOrgBilling, isHosted } from "../billing/service";
import { deleteOrganization, exportFilename, mintExportToken, EXPORT_TOKEN_TTL_MS } from "../export/orgExport";

defineAction({
  name: "org.security",
  title: "Organization security policy",
  description: "What this organization requires of its members: today, whether two-factor authentication is mandatory, and who last changed that.",
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  handler: async (_args, ctx) => {
    const policy = await getOrgSecurity(ctx.orgId);
    return { requireTotp: policy.requireTotp, updatedAt: policy.updatedAt, updatedBy: policy.updatedBy };
  },
});

defineAction({
  name: "org.set_security",
  title: "Set the organization security policy",
  description:
    "Turn the two-factor requirement on or off. With it on, every human member without 2FA is refused on org-scoped calls with `403 totp_required` and pointed at the setup page — " +
    "their own account surface (/api/auth/**) keeps working, so they can enrol and carry on. Agent seats are exempt: their credential is a revocable token, not a phone. " +
    "You cannot switch it on unless your own account already has 2FA, which is what stops an admin locking themselves out.",
  input: z.object({ requireTotp: z.boolean().describe("true = members must have TOTP enabled.") }),
  requiredRole: "admin",
  surface: "org",
  audited: true,
  handler: async (args, ctx) => {
    const current = await getOrgSecurity(ctx.orgId);
    if (args.requireTotp && !current.requireTotp) {
      const me = await reloadUser(ctx.userId);
      if (!me?.totpEnabled) {
        throw new ActionError(
          "conflict",
          "Turn on two-factor authentication for your own account first (Org → Security, or POST /api/auth/totp/setup) — otherwise this policy would lock you out immediately.",
        );
      }
    }
    const next = await setOrgSecurity(ctx.orgId, { requireTotp: args.requireTotp }, ctx.userId);
    return { requireTotp: next.requireTotp, updatedAt: next.updatedAt, changed: current.requireTotp !== next.requireTotp };
  },
});

defineAction({
  name: "org.export",
  title: "Export everything this organization has",
  description:
    "Mints a single-use download link for a ZIP of the whole organization: organization.json, members.csv, streams.csv, apps.csv, tasks.csv, task_events.csv, time_entries.csv, " +
    "invoices.json and audit_events.csv, with a README naming each file. The link is good for five minutes, works exactly once, and needs no Authorization header — so it can be " +
    "handed to a browser, `curl -O`, or anything else that follows a URL. The archive itself is built when the link is fetched, so it is never stale.",
  input: z.object({}),
  requiredRole: "owner",
  surface: "org",
  audited: true,
  handler: async (_args, ctx) => {
    const [org] = await db.select({ slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.orgId)).limit(1);
    if (!org) throw new ActionError("not_found", "Organization not found");
    const filename = exportFilename(org.slug);
    const { token, expiresAt } = mintExportToken(ctx.orgId, ctx.userId, filename);
    return {
      downloadUrl: `${currentBaseUrl()}/api/org/export?token=${token}`,
      path: `/api/org/export?token=${token}`,
      filename,
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: EXPORT_TOKEN_TTL_MS / 1000,
      singleUse: true,
    };
  },
});

defineAction({
  name: "org.delete",
  title: "Delete this organization",
  description:
    "Deletes the organization and everything that hangs off it — streams, apps, tasks, task history, time entries, invoices, tokens, integrations, invitations, the audit log. " +
    "Irreversible, and there is no copy: take `org.export` first. The exact organization name must be repeated in `confirmName`. " +
    "A hosted organization with a live subscription is refused until the subscription is cancelled, so nobody deletes their way into being billed for nothing. " +
    "Human members keep their accounts and their other organizations; an agent seat that existed only here is removed with it.",
  input: z.object({
    confirmName: z.string().min(1).max(255).describe("The organization's name, exactly as it is spelled."),
  }),
  requiredRole: "owner",
  surface: "org",
  handler: async (args, ctx) => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId)).limit(1);
    if (!org) throw new ActionError("not_found", "Organization not found");
    if (args.confirmName.trim() !== org.name) {
      throw new ActionError("invalid", `That is not the name of this organization. Type “${org.name}” exactly to confirm.`);
    }

    if (isHosted()) {
      const billing = await getOrgBilling(ctx.orgId);
      if (billing && (billing.plan === "hosted" || billing.stripeSubscriptionId)) {
        throw new ActionError(
          "conflict",
          "This organization has a live hosted subscription. Cancel it first (Org → Billing → Manage billing), then delete — otherwise Stripe would keep billing a customer with nothing to use.",
        );
      }
    }

    const result = await deleteOrganization(ctx.orgId);
    // Audited by hand, and after the fact: the org_id column is a foreign key, so
    // a row naming the deleted organization could not survive it. This one has a
    // null org and says which organization it was in its target and meta.
    await audit(
      { orgId: null, userId: ctx.userId, label: `${ctx.displayName} <${ctx.email}>` },
      "org.deleted",
      `${org.name} (${org.slug})`,
      { orgId: org.id, slug: org.slug, plan: org.plan, deletedAgentSeats: result.deletedAgents },
    );
    return { deleted: true, orgId: org.id, name: org.name, deletedAgentSeats: result.deletedAgents };
  },
});
