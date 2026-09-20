// Hybrid-dashboard actions — registered by importing this module (see ./index.ts).
//
// One read for the whole Overview → Hybrid tab. It is a manager's figure: it puts
// every member's hours and every agent's dollars on one page, which is more than
// a member is entitled to see, so the gate is `manager` and it is written here
// once rather than in each adapter.
import { z } from "zod";
import { format, subDays } from "date-fns";
import { ActionError, defineAction } from "./registry";
import { endOfDay, parseWhen, startOfDay } from "../track/entries";
import { hybridSummary, type HybridGroupBy } from "../overview/hybrid";
import { sayMinutes, sayTokens, sayUsd } from "../track/insights";
import { digestLetter } from "../email/templates";
import { appBaseUrl } from "../email/transport";
import { orgNameOf } from "../orgs";

/** A window wider than a year is an export, not a dashboard. */
const MAX_WINDOW_DAYS = 366;

/** The default window: four weeks of context, which is what the 30-day preset opens on. */
const DEFAULT_DAYS = 30;

const whenIn = (what: string) =>
  z.string().min(8).max(40).describe(`${what} as an ISO-8601 datetime (or YYYY-MM-DD for midnight local).`);

export const hybridInput = z.object({
  from: whenIn("Start of the window").optional(),
  to: whenIn("End of the window").optional(),
  groupBy: z
    .enum(["day", "week"])
    .describe("Bucket size for `series`. Weeks start on Monday, in the caller's local time.")
    .optional(),
});

/** Resolve the window the same way for every caller, defaults included. */
export function hybridWindow(args: z.infer<typeof hybridInput>): { from: Date; to: Date; groupBy: HybridGroupBy } {
  const to = args.to ? endOfDay(parseWhen(args.to, "to")) : endOfDay();
  const from = args.from ? startOfDay(parseWhen(args.from, "from")) : startOfDay(subDays(to, DEFAULT_DAYS - 1));
  if (from > to) throw new ActionError("invalid", "`from` must not be after `to`");
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (days > MAX_WINDOW_DAYS) {
    throw new ActionError("invalid", `That window is ${days} days; ${MAX_WINDOW_DAYS} is the most one hybrid summary covers`);
  }
  return { from, to, groupBy: args.groupBy ?? "day" };
}

defineAction({
  name: "hybrid.summary",
  title: "Hybrid summary",
  description:
    "The human/agent split for the whole organization over one window: `series` (worked minutes per day or week, split human vs agent, with the agent's tokens and dollars), " +
    "`byStream` (the same split per stream, plus each stream's agent budget, burn percentage and whether it is over), `byApp` (split by the app the worked task belongs to), " +
    "`topAgents` (minutes, tokens, dollars and tasks closed per agent seat), `perCompletedTask` (median and mean agent minutes/tokens/dollars for the tasks completed in the window, " +
    "counted over each task's whole life so work done before the window still counts), `totals`, and `narrative` — one computed paragraph stating the split, where the money went and whether the budget held. " +
    "Defaults to the last 30 days bucketed by day. Breaks and still-running sessions are excluded: a break is not work and an open session has no duration to report.",
  input: hybridInput,
  requiredRole: "manager",
  surface: "overview",
  handler: async (args, ctx) => hybridSummary(ctx.orgId, hybridWindow(args)),
});

/**
 * The weekly digest, as a letter, without sending it.
 *
 * There is no scheduler in PTD: what exists is the rendering, so an operator's
 * cron (or an agent on a timer) can fetch it and post it wherever the team reads
 * things. Returning the HTML and the text rather than mailing it also means the
 * digest can be reviewed before anyone wires it to a mailing list.
 */
defineAction({
  name: "digest.preview",
  title: "Preview the weekly digest",
  description:
    "Render the last seven days of the hybrid summary as an email — subject, HTML and plain text — without sending it. " +
    "The body is the same computed narrative, the same figures and the same per-stream agent spend the Overview → Hybrid tab shows. No scheduler: fetch it on your own cadence.",
  input: z.object({
    days: z.number().int().min(1).max(90).optional().describe("Window length in days, counting back from today (default 7)."),
  }),
  requiredRole: "manager",
  surface: "overview",
  handler: async (args, ctx) => {
    const days = args.days ?? 7;
    const to = endOfDay();
    const from = startOfDay(subDays(to, days - 1));
    const summary = await hybridSummary(ctx.orgId, { from, to, groupBy: days > 31 ? "week" : "day" });
    const orgName = await orgNameOf(ctx.orgId);
    const window = `${format(from, "d MMM")} – ${format(to, "d MMM yyyy")}`;

    const letter = digestLetter({
      orgName,
      window,
      narrative: summary.narrative,
      figures: [
        ["hours logged", sayMinutes(summary.totals.minutes)],
        ["human", sayMinutes(summary.totals.human.minutes)],
        ["agent", `${sayMinutes(summary.totals.agent.minutes)} · ${summary.totals.agentSharePct}%`],
        ["agent spend", sayUsd(summary.totals.agent.costUsd)],
        ["tokens", sayTokens(summary.totals.agent.tokens)],
        ["tasks completed", String(summary.totals.tasksCompleted)],
        ["median per completed task", sayUsd(summary.perCompletedTask.median.costUsd)],
      ],
      streams: summary.byStream
        .filter((s) => s.agent.costUsd > 0 || s.agentBudgetUsd !== null)
        .slice(0, 8)
        .map((s) => ({
          name: s.name,
          agentCost: sayUsd(s.agent.costUsd),
          burn: s.burnPct === null ? "no budget" : `${s.burnPct}% of ${sayUsd(s.agentBudgetUsd ?? 0)}`,
          over: s.overBudget,
        })),
      dashboardUrl: `${appBaseUrl()}/overview/hybrid`,
    });

    return { orgName, window, range: summary.range, narrative: summary.narrative, ...letter };
  },
});
