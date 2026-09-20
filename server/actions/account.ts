/**
 * Account actions — what a person can see and change about their own sign-in,
 * from anywhere the action registry is reachable (web, CLI, MCP).
 *
 * Read-only plus one unlink. Enrolling in 2FA is *not* here: it needs a QR code
 * and a code typed back within thirty seconds, which is an HTTP conversation
 * (`/api/auth/totp/*`), and it must keep working for a member an organization's
 * 2FA policy is currently refusing — the action surface is org-scoped and would
 * refuse them too.
 */
import { z } from "zod";
import { ActionError, defineAction } from "./registry";
import { listIdentities, unlinkIdentity } from "../oidc/link";
import { configuredProviders } from "../oidc/providers";
import { getOrgSecurity } from "../auth/security";
import { remainingRecoveryCodes } from "../auth/mfa";
import { reloadUser } from "../auth/mfa";

defineAction({
  name: "identity.list",
  title: "List linked sign-in providers",
  description:
    "The Google, GitHub or Microsoft accounts linked to your PTD account, with the address each one reported. " +
    "Also reports which providers this deployment has configured at all, so a client can offer the ones that exist and no others.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => ({
    identities: await listIdentities(ctx.userId),
    available: configuredProviders().map((p) => p.provider),
  }),
});

defineAction({
  name: "identity.unlink",
  title: "Unlink a sign-in provider",
  description:
    "Detach one linked provider from your account. Unlinking the last one needs `confirm: true`: an account that was created *through* a provider has a random password nobody knows, " +
    "so dropping its only identity means going through “Forgot password” before you can sign in again.",
  input: z.object({
    identityId: z.number().int().positive().describe("Identity id, from identity.list."),
    confirm: z.boolean().optional().describe("Required when this is the only linked provider."),
  }),
  requiredRole: "member",
  surface: "org",
  audited: true,
  handler: async (args, ctx) => {
    const all = await listIdentities(ctx.userId);
    const target = all.find((i) => i.id === args.identityId);
    if (!target) throw new ActionError("not_found", `No linked provider with id ${args.identityId} on your account`);
    if (all.length === 1 && args.confirm !== true) {
      throw new ActionError(
        "conflict",
        `${target.provider} is the only provider linked to your account. Set a password first (or pass confirm: true to unlink anyway).`,
      );
    }
    const removed = await unlinkIdentity(ctx.userId, args.identityId);
    return { unlinked: args.identityId, provider: removed?.provider ?? target.provider, remaining: all.length - 1 };
  },
});

defineAction({
  name: "account.security",
  title: "My second-factor state",
  description:
    "Whether two-factor authentication is on for your account, how many recovery codes are left, which providers are linked, " +
    "and whether this organization requires 2FA. What the Org → Security tab reads.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => {
    const user = await reloadUser(ctx.userId);
    if (!user) throw new ActionError("not_found", "Account not found");
    const policy = await getOrgSecurity(ctx.orgId);
    return {
      totpEnabled: user.totpEnabled,
      setupStarted: Boolean(user.totpSecretSealed) && !user.totpEnabled,
      recoveryCodesLeft: remainingRecoveryCodes(user),
      identities: await listIdentities(ctx.userId),
      providers: configuredProviders().map((p) => p.provider),
      organization: { requireTotp: policy.requireTotp, updatedAt: policy.updatedAt },
      setupEndpoint: "/api/auth/totp/setup",
    };
  },
});
