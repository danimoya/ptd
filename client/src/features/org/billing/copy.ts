import { money, type Feature, type Interval, type PlanDescription } from "./api";

/* ─────────────────────────────────────────────────────────────────────────
 * The words on the price list.
 *
 * The *numbers* all arrive from `billing.status`; what lives here is the plain
 * sentence each feature flag deserves, in the same vocabulary the public pricing
 * page uses, so a person who read the site and then signed up meets one story
 * told twice rather than two stories.
 * ───────────────────────────────────────────────────────────────────────── */

/** One line of a plan's includes list. `absent` lines say what is *not* there. */
export interface IncludeLine {
  text: string;
  absent?: boolean;
}

const FEATURE_LINES: Partial<Record<Feature, string>> = {
  surfaces: "All four surfaces: Plan, Track, Overview, Org",
  integrations: "Slack, GitHub, Teams and Telegram",
  oauth_connectors: "OAuth connectors for Claude.ai and ChatGPT",
  webhooks: "Signed webhooks",
  importers: "Importers for Toggl, Harvest, Jira and the rest",
  security_policy: "SSO and 2FA policy",
  audit_export: "Audit log and data export",
  stripe_tax: "Stripe Tax on the invoices you issue",
  priority_support: "Priority support",
  ai: "AI features with your own provider key",
  ai_priority: "AI priority scoring with your own key",
};

/** The lines a plan needs that no feature flag carries. */
const PLAN_TAIL: Partial<Record<string, IncludeLine[]>> = {
  free: [
    { text: "MCP, REST and the action registry" },
    { text: "Community support" },
    { text: "Certified invoices need Team", absent: true },
  ],
};

/** What each plan is *for*, in one sentence. */
export const PLAN_GIST: Record<string, string> = {
  free: "Enough to run a real project and see whether the ledger tells you the truth.",
  team: "Agent seats cost nothing — they pay their own API bill.",
  business: "For organizations that have to hand the numbers to somebody else.",
};

/** Certified invoices read differently depending on who pays for them. */
function certLine(desc: PlanDescription): string {
  return desc.certInvoiceUsd
    ? `Certified invoices at ${money(desc.certInvoiceUsd)} each`
    : "Certified invoices and verifiable links, included";
}

/**
 * A plan's includes list, derived from the features the server sent.
 *
 * When a plan is a strict superset of a cheaper one the list says so instead of
 * reprinting it — except where the *terms* changed, which is why certified
 * invoices are restated on Business even though Team has them too.
 */
export function planIncludes(desc: PlanDescription, base?: PlanDescription): IncludeLine[] {
  const lines: IncludeLine[] = [];
  const covered = new Set<Feature>();
  const inherits = Boolean(base && base.plan !== desc.plan && base.features.length > 0 && base.features.every((f) => desc.features.includes(f)));

  if (inherits && base) {
    lines.push({ text: `Everything in ${base.label}` });
    base.features.forEach((f) => covered.add(f));
    if (desc.features.includes("certified_invoices")) {
      lines.push({ text: certLine(desc) });
      covered.add("certified_invoices");
    }
  }

  for (const feature of desc.features) {
    if (covered.has(feature)) continue;
    covered.add(feature);
    if (feature === "certified_invoices") {
      lines.push({ text: certLine(desc) });
      continue;
    }
    const line = FEATURE_LINES[feature];
    if (line) lines.push({ text: line });
  }

  return [...lines, ...(PLAN_TAIL[desc.plan] ?? [])];
}

/**
 * The seat allowance, in one line.
 *
 * Three different sentences because three different things are being counted:
 * Free counts everybody against one ceiling, Team counts humans and lets agents
 * in for nothing, Business counts humans and bills the ones past what it includes.
 */
export function seatLine(desc: PlanDescription, interval: Interval): string {
  const { humanSeats, totalMembers, includedHumanSeats, billableSeats } = desc.limits;

  if (billableSeats && includedHumanSeats !== null) {
    const seat = desc.seatPrices ? money(desc.seatPrices[interval]) : null;
    return seat
      ? `${includedHumanSeats} human seats, then ${seat} each · agent seats free`
      : `${includedHumanSeats} human seats included · agent seats free`;
  }
  if (humanSeats !== null && totalMembers !== null && humanSeats === totalMembers) {
    return `${totalMembers} seats, humans and agents`;
  }
  if (humanSeats !== null) return `up to ${humanSeats} human seats · agent seats free`;
  return "no seat ceiling";
}

/** The hard ceiling, for the plans that have one worth naming separately. */
export function capLine(desc: PlanDescription): string | null {
  const { totalMembers, humanSeats } = desc.limits;
  if (totalMembers === null || totalMembers === humanSeats) return null;
  return `Hard cap ${totalMembers} members, humans and agents together`;
}
