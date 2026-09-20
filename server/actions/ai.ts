import { z } from "zod";
import { ActionError, defineAction, type ActionContext } from "./registry";
import {
  AI_NOT_CONFIGURED,
  AiProviderError,
  aiStatus,
  connectOrgAiKey,
  disconnectOrgAiKey,
  resolveAiConfig,
  setAiMeterHook,
  type AiConfig,
  type AiMeterCall,
  type OrgAiKeyView,
} from "../ai/provider";
import { USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS, usageForOrg, usageTotals, withUsageScope } from "../ai/usage";
import {
  BATCH_LIMIT_MAX,
  defaultDeps,
  suggestPriority,
  suggestPriorityBatch,
} from "../ai/suggest";
import { assertAiAllowed, assertFeature } from "../billing/gate";
import { aiMeterCents } from "../billing/plans";
import { aiUsageIdentifier, meterAiUsage } from "../billing/metering";
import { getOrgBilling, isHosted } from "../billing/service";

/**
 * AI-assisted priority — five actions, every one of them optional.
 *
 * PTD's priority is arithmetic (urgency × impact ÷ effort) and stays that way.
 * What a model is good for is the part a human guesses at: what urgency, impact
 * and effort *are* for this card, calibrated against the rest of this backlog.
 * So these actions propose the three inputs and let the existing formula derive
 * the score — never the score itself.
 *
 * Three rules the whole surface is built around:
 *
 *  - **Off unless configured.** No key, no provider, no feature: `ai.status`
 *    answers `{configured: false}` and everything else refuses with the same
 *    message. The Overview UI hides its buttons on that answer, so a self-hoster
 *    without a key never sees a control that cannot work.
 *  - **Your key first.** On the hosted instance an organization can connect its own
 *    provider key (`ai.connect`) and pay its provider directly. Without one, PTD's
 *    key answers on Team and Business and the tokens are billed on at cost plus 20%
 *    through the `ptd_ai_usage_cents` meter — the only honest way to resell somebody
 *    else's meter. Free has no AI at all; self-hosting has all of it, metered nowhere.
 *  - **A human's score is not overwritten.** `prioritySource: "manual"` means a
 *    person typed that number; a suggestion against it is always allowed, but
 *    writing over it takes an explicit `overrideManual: true`.
 */

const taskIdArg = z.number().int().positive().describe("Task id");

/* ── metering ─────────────────────────────────────────────────────────────── */

/**
 * Bill one provider call on, when PTD's own key paid for it.
 *
 * Installed at import time, which is also when the action registry is built, so any
 * provider call made through these actions is metered — and calls made with the
 * organization's own key are not, because `source` says whose key it was.
 */
async function meterCall(call: AiMeterCall): Promise<void> {
  if (!isHosted() || call.source !== "env") return;
  if (aiMeterCents(call.costUsd) <= 0) return;
  const org = await getOrgBilling(call.orgId);
  if (!org || (org.plan !== "team" && org.plan !== "business")) return;
  if (!org.stripeCustomerId || !org.stripeSubscriptionId) {
    console.warn(`[ai] org ${call.orgId} used PTD's key with no Stripe subscription to bill — ${call.label} not metered`);
    return;
  }
  await meterAiUsage({
    orgId: call.orgId,
    customerId: org.stripeCustomerId,
    costUsd: call.costUsd,
    identifier: aiUsageIdentifier({
      orgId: call.orgId,
      at: call.at,
      label: call.label,
      provider: call.provider,
      model: call.model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      costUsd: call.costUsd,
    }),
    at: new Date(call.at),
  });
}

setAiMeterHook((call) => {
  // Fire and forget: a suggestion has already been produced, and a meter event is
  // never worth failing it for. `meterAiUsage` logs its own failures.
  void meterCall(call).catch((err) => console.warn("[ai] metering failed:", err instanceof Error ? err.message : err));
});

/* ── availability ─────────────────────────────────────────────────────────── */

interface Available {
  config: AiConfig;
  source: "org" | "env";
  orgKey: OrgAiKeyView;
  metered: boolean;
}

/**
 * One place decides "may this organization make a call, and with whose key", so the
 * five actions cannot disagree. The plan gate runs first on the hosted instance;
 * self-hosting skips it entirely.
 */
async function requireAvailable(ctx: ActionContext): Promise<Available> {
  const resolved = await resolveAiConfig(ctx.orgId);
  const gate = await assertAiAllowed(ctx.orgId, {
    hasOrgKey: resolved.source === "org",
    serverKeyConfigured: resolved.serverConfigured,
  });
  if (!resolved.config) throw new ActionError("invalid", AI_NOT_CONFIGURED);
  return { config: resolved.config, source: resolved.source ?? "env", orgKey: resolved.orgKey, metered: gate.metered };
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
 * ledger — and, when PTD's key paid, on the usage meter. The provider layer is handed
 * a prompt, not a context, so the scope is how the row learns who is paying — see
 * server/ai/usage.ts.
 */
function billed<T>(ctx: { orgId: number; userId: number }, run: () => Promise<T>): Promise<T> {
  return withUsageScope({ orgId: ctx.orgId, userId: ctx.userId }, run);
}

defineAction({
  name: "ai.status",
  title: "AI status",
  description:
    "Whether AI is available to this organization and whose key would answer: its own (connected with ai.connect, billed by the provider) or this deployment's " +
    "(billed on at cost plus 20% on Team and Business). Never returns a key — only the provider, the model and the last four characters. " +
    "The only AI action that works unconfigured.",
  input: z.object({}),
  requiredRole: "member",
  surface: "overview",
  handler: async (_args, ctx) => {
    const resolved = await resolveAiConfig(ctx.orgId);
    const deployment = aiStatus();
    return {
      configured: Boolean(resolved.config),
      provider: resolved.config?.provider ?? null,
      model: resolved.config?.model ?? null,
      source: resolved.source,
      orgKey: resolved.orgKey,
      deployment: { configured: deployment.configured, provider: deployment.provider, model: deployment.model },
      // Team and Business may use PTD's key; those calls are metered.
      metered: isHosted() && resolved.source === "env",
    };
  },
});

defineAction({
  name: "ai.connect",
  title: "Connect an AI provider key",
  description:
    "Store this organization's own Anthropic or OpenAI key, sealed with AES-256-GCM, and use it for every AI call instead of the deployment's. " +
    "The provider bills you directly and PTD meters nothing. The key is never returned by any action — `ai.status` shows the provider, the model and the last four characters. " +
    "Connecting again replaces the stored key. Admin only, and recorded in the audit log.",
  input: z.object({
    provider: z.enum(["anthropic", "openai"]).describe("Which provider the key belongs to."),
    apiKey: z.string().min(12).max(300).describe("The provider API key. Stored sealed; never echoed back."),
    model: z.string().min(1).max(80).optional().describe("Override the provider's default model for this organization."),
    baseUrl: z.string().url().max(300).optional().describe("Point at a gateway or proxy instead of the provider's own host."),
  }),
  requiredRole: "admin",
  surface: "org",
  audited: true,
  handler: async (args, ctx) => {
    await assertFeature(ctx.orgId, "ai", "AI priority suggestions");
    return connectOrgAiKey(ctx.orgId, args, ctx.userId);
  },
});

defineAction({
  name: "ai.disconnect",
  title: "Disconnect the AI provider key",
  description:
    "Forget this organization's stored provider key. AI then falls back to the deployment's own key where one is configured — on the hosted instance that means Team and Business calls " +
    "start being metered at cost plus 20% again. Admin only, and recorded in the audit log.",
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  audited: true,
  handler: async (_args, ctx) => {
    const result = await disconnectOrgAiKey(ctx.orgId);
    const resolved = await resolveAiConfig(ctx.orgId);
    return { ...result, fallsBackTo: resolved.source, configured: Boolean(resolved.config) };
  },
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
    const available = await requireAvailable(ctx);
    return billed(ctx, () => withProviderErrors(() => suggestPriority(args, ctx, defaultDeps({ config: available.config }))));
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
    const available = await requireAvailable(ctx);
    return billed(ctx, () => withProviderErrors(() => suggestPriorityBatch(args, ctx, defaultDeps({ config: available.config }))));
  },
});

defineAction({
  name: "ai.usage",
  title: "AI usage",
  description:
    "Tokens and estimated dollars this organization has spent on AI suggestions, from the ai_usage ledger: one row per provider call, so the numbers survive a restart and are the same on every app replica. " +
    "Totals for the window (30 days by default, up to 365) with breakdowns by day, by member, by model and by action. " +
    "Costs are estimates from a static price table; `meterCents` is what those calls would be billed on for at cost plus 20% when PTD's key answered them. " +
    "`thisProcess` is the last 500 calls this server process happened to make — the same ledger seen through a keyhole, useful right after a batch run.",
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
    const resolved = await resolveAiConfig(ctx.orgId);
    if (!resolved.config) throw new ActionError("invalid", AI_NOT_CONFIGURED);
    const ledger = await usageForOrg(ctx.orgId, { days: args.days });
    return {
      provider: resolved.config.provider,
      model: resolved.config.model,
      source: resolved.source,
      metered: isHosted() && resolved.source === "env",
      meterCents: aiMeterCents(ledger.costUsd),
      ...ledger,
      thisProcess: usageTotals(),
    };
  },
});
