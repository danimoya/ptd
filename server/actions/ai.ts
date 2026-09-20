import { z } from "zod";
import { ActionError, defineAction } from "./registry";
import { AI_NOT_CONFIGURED, aiConfigFromEnv, aiStatus, AiProviderError } from "../ai/provider";
import { USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS, usageForOrg, usageTotals, withUsageScope } from "../ai/usage";
import {
  BATCH_LIMIT_MAX,
  defaultDeps,
  suggestPriority,
  suggestPriorityBatch,
} from "../ai/suggest";

/**
 * AI-assisted priority — four actions, every one of them optional.
 *
 * PTD's priority is arithmetic (urgency × impact ÷ effort) and stays that way.
 * What a model is good for is the part a human guesses at: what urgency, impact
 * and effort *are* for this card, calibrated against the rest of this backlog.
 * So these actions propose the three inputs and let the existing formula derive
 * the score — never the score itself.
 *
 * Two rules the whole surface is built around:
 *
 *  - **Off unless configured.** No key, no provider, no feature: `ai.status`
 *    answers `{configured: false}` and everything else refuses with the same
 *    message. The Overview UI hides its buttons on that answer, so a self-hoster
 *    without a key never sees a control that cannot work.
 *  - **A human's score is not overwritten.** `prioritySource: "manual"` means a
 *    person typed that number; a suggestion against it is always allowed, but
 *    writing over it takes an explicit `overrideManual: true`.
 */

const taskIdArg = z.number().int().positive().describe("Task id");

/** One place decides "is AI on", so the four actions cannot disagree. */
function requireConfigured(): void {
  if (!aiConfigFromEnv()) throw new ActionError("invalid", AI_NOT_CONFIGURED);
}

/**
 * Provider failures are the caller's business, not a 500: a rate limit, a
 * timeout or a model that will not produce JSON all come back as `invalid` with
 * the provider's own words, which is what the drawer shows in its error line.
 */
async function withProviderErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AiProviderError) throw new ActionError("invalid", error.message);
    throw error;
  }
}

/**
 * Every provider call made inside `run` lands on this organization's `ai_usage`
 * ledger. The provider layer is handed a prompt, not a context, so the scope is how
 * the row learns who is paying — see server/ai/usage.ts.
 */
function billed<T>(ctx: { orgId: number; userId: number }, run: () => Promise<T>): Promise<T> {
  return withUsageScope({ orgId: ctx.orgId, userId: ctx.userId }, run);
}

defineAction({
  name: "ai.status",
  title: "AI status",
  description:
    "Whether this deployment has an AI provider configured, and which model it would use. The only AI action that works unconfigured — everything else refuses until PTD_AI_PROVIDER and PTD_AI_API_KEY are set. Never returns the key.",
  input: z.object({}),
  requiredRole: "member",
  surface: "overview",
  handler: async () => aiStatus(),
});

defineAction({
  name: "task.suggest_priority",
  title: "Suggest a priority",
  description:
    "Ask the configured model for urgency, impact and effort on one card, with a short rationale and a confidence. " +
    "The model sees the card (title, description, stream, app, dates, dependencies, assignee kind, status, tags, current score) and this organization's score distribution, so its numbers mean the same thing as the rest of the backlog. " +
    "Read-only by default: it returns the proposal, the score PTD's formula derives from it, the delta against the current score and what the call cost. " +
    "Pass apply:true to write it (prioritySource becomes 'ai', the rationale becomes the card's priorityNote, and one priority_changed event is recorded). " +
    "A card whose score a human set by hand (prioritySource 'manual') is never written over unless you also pass overrideManual:true.",
  input: z.object({
    taskId: taskIdArg,
    apply: z.boolean().optional().describe("Write the suggestion onto the card (default false — just propose)."),
    overrideManual: z
      .boolean()
      .optional()
      .describe("Allow apply to overwrite a score a human set by hand. Ignored without apply."),
  }),
  requiredRole: "manager",
  surface: "overview",
  handler: async (args, ctx) => {
    requireConfigured();
    return billed(ctx, () => withProviderErrors(() => suggestPriority(args, ctx, defaultDeps())));
  },
});

defineAction({
  name: "task.suggest_priority_batch",
  title: "Suggest priorities in bulk",
  description:
    `Re-score up to ${BATCH_LIMIT_MAX} open cards in one go, optionally narrowed to one stream or app, highest-scored first. ` +
    "Runs a few calls at a time rather than all at once, so a big batch does not trip the provider's rate limit. " +
    "Cards a human scored by hand are skipped without spending a call unless overrideManual is set. " +
    "Returns one row per card — proposal, derived score, delta, whether it was written — plus the total tokens and dollars the run cost. " +
    "One card failing is a row in the report, not the end of the batch.",
  input: z.object({
    streamId: z.number().int().positive().optional().describe("Only cards in this stream."),
    appId: z.number().int().positive().optional().describe("Only cards filed against this app."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(BATCH_LIMIT_MAX)
      .optional()
      .describe(`How many cards to score, 1–${BATCH_LIMIT_MAX} (default 10).`),
    apply: z.boolean().optional().describe("Write every suggestion (default false — dry run)."),
    overrideManual: z
      .boolean()
      .optional()
      .describe("Include cards scored by hand, and allow apply to overwrite them."),
  }),
  requiredRole: "manager",
  surface: "overview",
  handler: async (args, ctx) => {
    requireConfigured();
    return billed(ctx, () => withProviderErrors(() => suggestPriorityBatch(args, ctx, defaultDeps())));
  },
});

defineAction({
  name: "ai.usage",
  title: "AI usage",
  description:
    "Tokens and estimated dollars this organization has spent on AI suggestions, from the ai_usage ledger: one row per provider call, so the numbers survive a restart and are the same on every app replica. " +
    "Totals for the window (30 days by default, up to 365) with breakdowns by day, by member, by model and by action. " +
    "Costs are estimates from a static price table. `thisProcess` is the last 500 calls this server process happened to make — the same ledger seen through a keyhole, useful right after a batch run.",
  input: z.object({
    days: z
      .number()
      .int()
      .min(1)
      .max(USAGE_MAX_DAYS)
      .optional()
      .describe(`How many days back to count, 1–${USAGE_MAX_DAYS} (default ${USAGE_DEFAULT_DAYS}).`),
  }),
  requiredRole: "admin",
  surface: "overview",
  handler: async (args, ctx) => {
    requireConfigured();
    const ledger = await usageForOrg(ctx.orgId, { days: args.days });
    const status = aiStatus();
    return { provider: status.provider, model: status.model, ...ledger, thisProcess: usageTotals() };
  },
});
