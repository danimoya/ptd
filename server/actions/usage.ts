// Verified-usage actions — registered by importing this module (see ./index.ts).
//
// The objection this file answers is "why would an agent report its own cost
// honestly?". Three mechanisms, in increasing order of how little they trust the
// agent:
//
//  1. `time_entry.attest` — a second party (the Claude Code Stop hook, a CI job)
//     writes what the session really consumed into separate columns. The agent's
//     own claim is kept, so the two can be compared forever.
//  2. `usage.summary` — reported against verified, per agent and per stream, with
//     a coverage percentage and every session outside tolerance named.
//  3. `usage.reconcile` — the provider's own billing for the period against the
//     ledger. The admin key lives with the humans; an agent never holds it.
//
// And one consequence: `stream.set_budget` + `budget.check` make a budget a wall
// rather than a chart. In `enforce` mode `next_task` stops handing an agent work
// in a lane whose month is spent (see ./overview.ts).

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { streams } from "../../db/schema";
import { ActionError, defineAction, type ActionContext } from "./registry";
import { hasRole } from "../types";
import { endOfDay, parseWhen, startOfDay } from "../track/entries";
import { dispatchWebhooks } from "../webhooks";
import { ATTEST_SOURCES, attest } from "../usage/attest";
import { costForSplit, splitFromEvidence } from "../usage/cost";
import { announceExhausted, BUDGET_MODES, streamBudget, streamBudgets } from "../usage/budget";
import { USAGE_PROVIDERS, type UsageProvider } from "../usage/providers";
import { connectProvider, disconnectProvider, listProviders, listReconciliations } from "../usage/store";
import { ProviderNotConnected, reconcile } from "../usage/reconcile";
import { usageSummary } from "../usage/summary";

const whenIn = (what: string) => z.string().min(8).max(40).describe(`${what} as an ISO-8601 datetime (or YYYY-MM-DD for midnight local).`);

/** The default window for every read here: four weeks of context. */
const DEFAULT_DAYS = 30;
const MAX_WINDOW_DAYS = 366;

const manager = (ctx: ActionContext) => hasRole(ctx.role, "manager");

function window(args: { from?: string; to?: string }, defaultDays = DEFAULT_DAYS): { from: Date; to: Date } {
  const to = args.to ? endOfDay(parseWhen(args.to, "to")) : endOfDay();
  const from = args.from ? startOfDay(parseWhen(args.from, "from")) : startOfDay(new Date(to.getTime() - (defaultDays - 1) * 86_400_000));
  if (from > to) throw new ActionError("invalid", "`from` must not be after `to`");
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (days > MAX_WINDOW_DAYS) throw new ActionError("invalid", `That window is ${days} days; ${MAX_WINDOW_DAYS} is the most one usage read covers`);
  return { from, to };
}

/* ══════════════════════════════════════════════════════════════════════
   Attestation
   ══════════════════════════════════════════════════════════════════════ */

defineAction({
  name: "time_entry.attest",
  title: "Attest an entry's usage",
  description:
    "Record what a finished agent session *actually* consumed, as measured by something other than the agent's own arithmetic. " +
    "Writes verifiedTokens / verifiedCostUsd / verifiedSource / verifiedAt; the agent's self-reported tokensUsed and apiCostUsd are left untouched, " +
    "so `usage.summary` can put the claim and the evidence side by side. " +
    "`source` says who measured it: `claude_code_hook` (the Stop hook summed the session transcript), `ci` (a build reported the runner's usage), `provider` (reconciled against the provider's billing). " +
    "`costUsd` is optional — omit it and, when `evidence` names a `model`, PTD prices the tokens itself from its own table (cache reads at 0.1× and cache writes at 1.25× the input rate); with neither, the tokens are verified and the cost is left unset rather than stored as zero. " +
    "Members may attest their own entries, manager and above anyone's. Only agent-sourced, already-closed entries can be attested, and re-attesting replaces the previous figure (so a hook that fires twice is harmless) while the task history keeps both.",
  input: z.object({
    entryId: z.number().int().positive().describe("The finished agent entry to attest — the `entry.id` time_entry.stop returned."),
    tokens: z.number().int().min(0).max(1_000_000_000).describe("Total tokens the session consumed, counting input, output and cache traffic."),
    costUsd: z.number().min(0).max(1_000_000).optional().describe("USD cost, if the attester knows it. Omitted, PTD derives it from evidence.model."),
    source: z.enum(ATTEST_SOURCES).describe("Who measured this: claude_code_hook, ci or provider."),
    evidence: z
      .record(z.unknown())
      .optional()
      .describe(
        "Free-form proof. Keys PTD reads: `model` (to price the tokens), `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheCreationTokens` (or their snake_case spellings) for an accurate price, and `cacheTtl` (\"5m\"|\"1h\"). Everything else — transcriptSha256, turns, runId, commit — is stored on the task-history event verbatim.",
      ),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args, ctx) =>
    attest(ctx, { entryId: args.entryId, tokens: args.tokens, costUsd: args.costUsd, source: args.source, evidence: args.evidence }, manager(ctx)),
});

defineAction({
  name: "usage.price",
  title: "Price a token split",
  description:
    "What PTD thinks a set of token counts costs, using the same table `time_entry.attest` prices an attestation with. " +
    "Exists so a hook or a CI job can report a dollar figure on `time_entry.stop` that matches the one the server will derive on attestation, instead of shipping a second price table inside a shell script. " +
    "Read-only, no database. An unknown model comes back `priced: false` with a zero cost — never a guess.",
  input: z.object({
    model: z.string().min(1).max(120).describe("Model id, e.g. claude-opus-5 or gpt-4o-mini."),
    inputTokens: z.number().int().min(0).max(1_000_000_000).optional(),
    outputTokens: z.number().int().min(0).max(1_000_000_000).optional(),
    cacheReadTokens: z.number().int().min(0).max(1_000_000_000).optional(),
    cacheCreationTokens: z.number().int().min(0).max(1_000_000_000).optional(),
    cacheTtl: z.enum(["5m", "1h"]).optional().describe("TTL of the cache writes: 5m costs 1.25× input, 1h costs 2×. Default 5m."),
  }),
  requiredRole: "member",
  surface: "track",
  handler: async (args) => {
    const split = splitFromEvidence(0, args as Record<string, unknown>);
    const cost = costForSplit(args.model, split);
    const tokens = split.inputTokens + split.outputTokens + split.cacheReadTokens + split.cacheCreationTokens;
    return { model: args.model, provider: cost.provider, tokens, split, costUsd: cost.costUsd, priced: cost.priced };
  },
});

defineAction({
  name: "usage.summary",
  title: "Reported versus verified usage",
  description:
    "Whether this organization's agent-cost figures can be trusted, as arithmetic. For a window (default the last 30 days) it returns: " +
    "`totals` and `byAgent` / `byStream` rows each carrying `reported` (what the agents said), `verified` (what a hook, a build or the provider proved), " +
    "`delta` (verified − reported, so a positive number means under-reporting), `unverified` (self-reported spend nobody has attested) and `coveragePct` (attested sessions as a share of agent sessions); " +
    "`discrepancies`, one line per session whose gap exceeds tolerance (5% of the verified figure, or 1000 tokens, whichever is larger), each with a direction; and `narrative`, one computed sentence. " +
    "Breaks and still-running sessions are excluded — neither has a final usage figure. Manager and above, because it puts every seat's spend on one page.",
  input: z.object({ from: whenIn("Start of the window").optional(), to: whenIn("End of the window").optional() }),
  requiredRole: "manager",
  surface: "overview",
  handler: async (args, ctx) => {
    const { from, to } = window(args);
    return usageSummary(ctx.orgId, from, to);
  },
});

/* ══════════════════════════════════════════════════════════════════════
   Hard budgets
   ══════════════════════════════════════════════════════════════════════ */

defineAction({
  name: "stream.set_budget",
  title: "Set a stream's agent budget",
  description:
    "The monthly ceiling on agent spend in one stream, and what happens when it is reached. " +
    "`alert` (the default) is the behaviour PTD has always had: the Overview bar turns red and the digest says so, but nothing stops. " +
    "`enforce` makes it a wall — once month-to-date agent spend in that lane reaches the budget, `next_task` stops offering the lane's cards to agent credentials, " +
    "a `budget.exhausted` webhook fires (once per stream per day), and `budget.check` answers `blocked: true`. Humans are never blocked. " +
    "Spend counts the verified cost of a session where one exists and the agent's self-reported cost otherwise, so under-reporting cannot buy extra runway. " +
    "Pass agentBudgetUsd: null to remove the ceiling; enforce mode with no ceiling enforces nothing.",
  input: z.object({
    streamId: z.number().int().positive().describe("Stream id, from stream.list."),
    agentBudgetUsd: z.number().min(0).max(10_000_000).nullable().optional().describe("Monthly ceiling in USD, or null to remove it."),
    budgetMode: z.enum(["alert", "enforce"]).optional().describe("alert = warn only (default). enforce = refuse agent work once spent."),
  }),
  requiredRole: "manager",
  surface: "overview",
  handler: async (args, ctx) => {
    if (args.agentBudgetUsd === undefined && args.budgetMode === undefined) {
      throw new ActionError("invalid", "Nothing to set — pass agentBudgetUsd, budgetMode or both");
    }
    const [before] = await db
      .select({ id: streams.id, name: streams.name, agentBudgetUsd: streams.agentBudgetUsd, budgetMode: streams.budgetMode })
      .from(streams)
      .where(and(eq(streams.orgId, ctx.orgId), eq(streams.id, args.streamId)))
      .limit(1);
    if (!before) throw new ActionError("not_found", `No stream ${args.streamId} in this organization`);

    const patch: { agentBudgetUsd?: number | null; budgetMode?: string } = {};
    if (args.agentBudgetUsd !== undefined) patch.agentBudgetUsd = args.agentBudgetUsd;
    if (args.budgetMode !== undefined) patch.budgetMode = args.budgetMode;
    await db.update(streams).set(patch).where(eq(streams.id, before.id));

    const budget = await streamBudget(ctx.orgId, before.id);
    void dispatchWebhooks(ctx.orgId, {
      kind: "stream.budget_set",
      actor: { userId: ctx.userId, label: ctx.displayName, isAgent: ctx.authType === "agent" },
      payload: {
        streamId: before.id,
        streamName: before.name,
        before: { agentBudgetUsd: before.agentBudgetUsd, budgetMode: before.budgetMode },
        after: { agentBudgetUsd: patch.agentBudgetUsd ?? before.agentBudgetUsd, budgetMode: patch.budgetMode ?? before.budgetMode },
        via: ctx.via,
      },
    });
    if (budget) void announceExhausted(ctx.orgId, [budget]);
    return { stream: budget, modes: BUDGET_MODES };
  },
});

defineAction({
  name: "budget.check",
  title: "Check an agent budget",
  description:
    "Where a stream stands against its monthly agent budget: `{ streamId, name, mode, budgetUsd, spentUsd, remainingUsd, burnPct, overBudget, enforced, blocked, periodStart }`. " +
    "Omit streamId and you get `{ streams: [...], blocked: [...], totals }` for every live lane instead. " +
    "`blocked: true` means an agent credential will be refused this lane's work by `next_task` — the check an autonomous worker should make before it starts, so it can pick a different lane rather than discover the refusal as an empty queue. " +
    "Spend is month-to-date and prefers the verified cost of each session over the self-reported one.",
  input: z.object({ streamId: z.number().int().positive().optional().describe("One stream, or omit for every live stream.") }),
  requiredRole: "member",
  surface: "overview",
  handler: async (args, ctx) => {
    if (args.streamId !== undefined) {
      const budget = await streamBudget(ctx.orgId, args.streamId);
      if (!budget) throw new ActionError("not_found", `No live stream ${args.streamId} in this organization`);
      void announceExhausted(ctx.orgId, [budget]);
      return budget;
    }
    const budgets = await streamBudgets(ctx.orgId);
    void announceExhausted(ctx.orgId, budgets);
    const spentUsd = Math.round(budgets.reduce((sum, b) => sum + b.spentUsd, 0) * 10_000) / 10_000;
    const budgeted = budgets.filter((b) => b.budgetUsd !== null);
    return {
      streams: budgets,
      blocked: budgets.filter((b) => b.blocked).map((b) => b.streamId),
      totals: {
        streams: budgets.length,
        budgeted: budgeted.length,
        enforced: budgets.filter((b) => b.enforced).length,
        spentUsd,
        budgetUsd: Math.round(budgeted.reduce((sum, b) => sum + (b.budgetUsd ?? 0), 0) * 10_000) / 10_000,
      },
    };
  },
});

/* ══════════════════════════════════════════════════════════════════════
   Provider reconciliation
   ══════════════════════════════════════════════════════════════════════ */

const providerIn = z.enum(USAGE_PROVIDERS).describe("Which provider's billing to read: anthropic or openai.");

defineAction({
  name: "usage.connect_provider",
  title: "Connect a provider admin key",
  description:
    "Store an organization-level admin key so PTD can read the provider's own usage and cost reports and compare them with the ledger. " +
    "Anthropic wants an Admin API key (`sk-ant-admin…`, Console → Settings → Admin keys); OpenAI wants an admin key with the usage scope. " +
    "The key is sealed with AES-256-GCM (PTD_SECRET_KEY) and is never returned by any action — `keyHint` is its last four characters. " +
    "Admin only, and deliberately so: reconciliation is only evidence because the agents being measured cannot reach the credential doing the measuring. " +
    "`baseUrl` exists for a proxy or a local stub; leave it unset for the real provider.",
  input: z.object({
    provider: providerIn,
    adminApiKey: z.string().min(8).max(400).describe("The admin key. Stored sealed; never echoed back."),
    baseUrl: z.string().max(300).optional().describe("Override the provider host (proxy or test stub). Default api.anthropic.com / api.openai.com."),
  }),
  requiredRole: "admin",
  surface: "org",
  audited: true,
  handler: async (args, ctx) => connectProvider(ctx.orgId, args.provider, args.adminApiKey, ctx.userId, args.baseUrl),
});

defineAction({
  name: "usage.disconnect_provider",
  title: "Disconnect a provider key",
  description: "Forget the stored admin key for one provider. Past reconciliations are kept — they are evidence — but no new one can be run until a key is connected again.",
  input: z.object({ provider: providerIn }),
  requiredRole: "admin",
  surface: "org",
  audited: true,
  handler: async (args, ctx) => disconnectProvider(ctx.orgId, args.provider),
});

defineAction({
  name: "usage.providers",
  title: "Connected providers",
  description: "Both providers with whether a key is connected, its last four characters, who connected it and when. Never the key itself.",
  input: z.object({}),
  requiredRole: "admin",
  surface: "org",
  handler: async (_args, ctx) => listProviders(ctx.orgId),
});

defineAction({
  name: "usage.reconcile",
  title: "Reconcile against the provider",
  description:
    "Fetch the provider's own usage and cost report for a period and compare it with what the agents booked into the ledger. " +
    "Stores and returns one `usage_reconciliations` row: `status` is `match` (inside tolerance — 5% of the provider's figure or 10,000 tokens, whichever is larger), " +
    "`under_reported` (the provider billed for more than the ledger accounts for), `over_reported` (the ledger claims more than the provider billed) or `unavailable` (the provider could not be read). " +
    "`detail` carries the gap, the tolerance applied, the attestation coverage, the per-model provider breakdown, the per-agent split and a note on how to read the status — " +
    "the two totals are not commensurable to the token (a provider bill includes keys PTD never sees), so the verdict is a signal to look, not an accusation. Admin only.",
  input: z.object({
    provider: providerIn,
    from: whenIn("Start of the period"),
    to: whenIn("End of the period"),
  }),
  requiredRole: "admin",
  surface: "org",
  handler: async (args, ctx) => {
    const { from, to } = window(args);
    try {
      return await reconcile(ctx.orgId, args.provider as UsageProvider, { from, to });
    } catch (err) {
      if (err instanceof ProviderNotConnected) throw new ActionError("invalid", err.message);
      throw err;
    }
  },
});

defineAction({
  name: "usage.reconciliations",
  title: "Reconciliation history",
  description: "Past reconciliations, newest first: period, provider, both token totals, both cost totals, the verdict and its detail. Manager and above — it is a read of evidence, not a credential.",
  input: z.object({
    provider: providerIn.optional(),
    limit: z.number().int().min(1).max(100).optional().describe("Rows to return (default 20)."),
  }),
  requiredRole: "manager",
  surface: "org",
  handler: async (args, ctx) => listReconciliations(ctx.orgId, args.provider as UsageProvider | undefined, args.limit ?? 20),
});
