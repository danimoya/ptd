/**
 * Plan limits.
 *
 * The hosted free tier is 3 seats — humans and agents counted together, because
 * an agent is a member with a token, not a cheaper kind of account. Self-hosted
 * and paid hosted organizations have no seat ceiling at all.
 *
 * Call this from the paths that add a seat (invitation accept, agent signup);
 * it is a no-op on every self-hosted deployment.
 */
import { ActionError } from "../actions/registry";
import { FREE_MEMBER_LIMIT, PRICE_USD, getOrgBilling, isHosted, orgSeatUsage } from "./service";

export const FREE_LIMIT_MESSAGE = `Free hosted organizations are limited to ${FREE_MEMBER_LIMIT} members — upgrade for $${PRICE_USD}/month`;

export interface PlanLimitState {
  enforced: boolean;
  plan: string | null;
  limit: number | null;
  used: number;
}

/** What the UI shows, without the throw. */
export async function planLimitState(orgId: number, env: NodeJS.ProcessEnv = process.env): Promise<PlanLimitState> {
  if (!isHosted(env)) return { enforced: false, plan: null, limit: null, used: 0 };
  const org = await getOrgBilling(orgId);
  if (!org || org.plan !== "free") return { enforced: false, plan: org?.plan ?? null, limit: null, used: 0 };
  const usage = await orgSeatUsage(orgId);
  return { enforced: true, plan: org.plan, limit: FREE_MEMBER_LIMIT, used: usage.members };
}

/**
 * Throws `ActionError("forbidden", …)` when adding this seat would exceed the
 * free tier. `what` only shapes nothing today — both humans and agents occupy a
 * seat — but callers pass it so the copy can diverge later without a signature change.
 */
export async function assertWithinPlan(orgId: number, what: "member" | "agent", env: NodeJS.ProcessEnv = process.env): Promise<void> {
  void what;
  const state = await planLimitState(orgId, env);
  if (!state.enforced || state.limit === null) return;
  if (state.used >= state.limit) throw new ActionError("forbidden", FREE_LIMIT_MESSAGE);
}
