/**
 * Seat limits — the one place that decides whether a new member may join.
 *
 * Three ceilings, and which of them applies depends on the plan:
 *
 *   free      3 members, **humans and agents counted together**. On the free tier
 *             an agent is not cheaper than a person: it is a seat with a token.
 *   team      10 **human** seats. Agent seats are free and unlimited, because an
 *             agent pays its own API bill — charging for its chair too would be
 *             charging twice. Everybody still counts against the member cap.
 *   business  no human ceiling: humans past 50 are billed at $2 each rather than
 *             refused (see `syncSeatQuantity`). Everybody counts against the cap.
 *
 * And above all of them, on every hosted plan, `PTD_HOSTED_MAX_MEMBERS` — the hard
 * cap. It is not a pricing lever; it is the line past which one tenant stops being
 * a tenant, and the answer is a conversation, not a bigger invoice.
 *
 * Call this from the paths that add a seat (invitation accept, agent signup); it is
 * a no-op on every self-hosted deployment and reads nothing at all there.
 */
import { ActionError } from "../actions/registry";
import {
  BUSINESS_INCLUDED_HUMAN_SEATS,
  FREE_MEMBER_LIMIT,
  PLAN_PRICES,
  SEAT_PRICES,
  TEAM_HUMAN_SEATS,
  memberCap,
  planLimits,
  seatOverage,
  type Plan,
} from "./plans";
import { getOrgBilling, isHosted, orgSeatUsage } from "./service";

export const FREE_LIMIT_MESSAGE =
  `Free hosted organizations are limited to ${FREE_MEMBER_LIMIT} members, humans and agents together — ` +
  `Team is $${PLAN_PRICES.team.month}/month for up to ${TEAM_HUMAN_SEATS} human seats, with agent seats free`;

export const TEAM_HUMAN_LIMIT_MESSAGE =
  `Team includes ${TEAM_HUMAN_SEATS} human seats (agent seats are free and unlimited) — ` +
  `Business is $${PLAN_PRICES.business.month}/month for ${BUSINESS_INCLUDED_HUMAN_SEATS}, then $${SEAT_PRICES.month} per human seat`;

export function capMessage(cap: number): string {
  return (
    `This organization has reached the hosted ceiling of ${cap} members, humans and agents together. ` +
    `That is not a pricing limit — past this size PTD is better run on your own hardware or on a dedicated deployment, so talk to us rather than buying more seats.`
  );
}

export interface PlanLimitState {
  /** Whether any ceiling applies at all. */
  enforced: boolean;
  plan: Plan | null;
  /** Human seats included, null when humans are billed instead of capped. */
  humanSeats: number | null;
  /** The hard member cap. */
  totalMembers: number | null;
  humans: number;
  agents: number;
  total: number;
  /** Billable human seats on Business. */
  seatOverage: number;
  /** The narrowest ceiling being applied, for the old two-field shape. */
  limit: number | null;
  used: number;
}

const OFF: PlanLimitState = {
  enforced: false,
  plan: null,
  humanSeats: null,
  totalMembers: null,
  humans: 0,
  agents: 0,
  total: 0,
  seatOverage: 0,
  limit: null,
  used: 0,
};

/** What the UI shows, without the throw. */
export async function planLimitState(orgId: number, env: NodeJS.ProcessEnv = process.env): Promise<PlanLimitState> {
  if (!isHosted(env)) return { ...OFF };
  const org = await getOrgBilling(orgId);
  if (!org || org.plan === "self_hosted") return { ...OFF, plan: org?.plan ?? null };

  const limits = planLimits(org.plan, env);
  const usage = await orgSeatUsage(orgId);
  // The narrowest ceiling in force, so the old `{limit, used}` pair still means
  // "how close is this organization to being refused a seat".
  const humanBound = limits.humanSeats !== null ? { limit: limits.humanSeats, used: usage.humans } : null;
  const totalBound = limits.totalMembers !== null ? { limit: limits.totalMembers, used: usage.members } : null;
  const narrowest =
    humanBound && totalBound
      ? totalBound.limit - totalBound.used <= humanBound.limit - humanBound.used
        ? totalBound
        : humanBound
      : humanBound ?? totalBound;

  return {
    enforced: limits.humanSeats !== null || limits.totalMembers !== null,
    plan: org.plan,
    humanSeats: limits.humanSeats,
    totalMembers: limits.totalMembers,
    humans: usage.humans,
    agents: usage.agents,
    total: usage.members,
    seatOverage: seatOverage(org.plan, usage.humans),
    limit: narrowest?.limit ?? null,
    used: narrowest?.used ?? 0,
  };
}

/**
 * Throws `ActionError("forbidden", …)` when adding this seat would break a ceiling.
 *
 * `what` matters now: a human takes a human seat *and* a member slot, an agent only
 * a member slot — except on `free`, where every member is the same seat.
 */
export async function assertWithinPlan(orgId: number, what: "member" | "agent", env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isHosted(env)) return;
  const org = await getOrgBilling(orgId);
  if (!org || org.plan === "self_hosted") return;

  const limits = planLimits(org.plan, env);
  const usage = await orgSeatUsage(orgId);

  // The hard cap first: it applies to every plan and to both kinds of seat.
  if (limits.totalMembers !== null && usage.members >= limits.totalMembers) {
    throw new ActionError("forbidden", org.plan === "free" ? FREE_LIMIT_MESSAGE : capMessage(limits.totalMembers));
  }
  // Then the human ceiling, which an agent never touches on a paid plan.
  if (what === "member" && limits.humanSeats !== null && usage.humans >= limits.humanSeats) {
    throw new ActionError("forbidden", org.plan === "free" ? FREE_LIMIT_MESSAGE : TEAM_HUMAN_LIMIT_MESSAGE);
  }
}

/** The cap in force on this deployment, for copy and for the status action. */
export function hostedMemberCap(env: NodeJS.ProcessEnv = process.env): number {
  return memberCap(env);
}
