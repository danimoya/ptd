/**
 * Priority suggestion, end to end: gather context → ask → compare → maybe write.
 *
 * Every collaborator is injected through `SuggestDeps`, which is what lets the
 * tests exercise the whole path — prompt, retry, manual-score protection, batch
 * concurrency, cost arithmetic — with no database and no network. The default
 * implementations read through the action registry (`task.get`, `task.list`), so
 * the AI feature inherits the Plan surface's org scoping instead of writing a
 * second set of tenancy-filtered queries.
 */
import { CLOSED_STATUSES } from "../overview/schema";
import type { ActionContext } from "../actions/registry";
import { runAction } from "../actions/registry";
import { applyAiPriority, type AppliedPriority } from "./apply";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency";
import {
  buildOrgContext,
  buildSuggestionPrompt,
  buildTaskContext,
  scoreBand,
  SUGGESTION_SPEC,
  type OpenTaskRow,
  type OrgPriorityContext,
  type PrioritySuggestion,
  type TaskDetail,
} from "./prompt";
import { completeJSON, type AiConfig, type AiUsage, type CompleteJSONResult, type FetchLike } from "./provider";
import { priorityScore } from "../../db/schema";

export const BATCH_LIMIT_MAX = 25;
export const BATCH_CONCURRENCY = DEFAULT_CONCURRENCY;

const CLOSED = new Set<string>(CLOSED_STATUSES);

/** A card is "open" if it is neither completed nor filed as won't-fix. */
export function isOpen(task: { status: string; completed: boolean }): boolean {
  return !task.completed && !CLOSED.has(task.status);
}

export interface SuggestDeps {
  getTask: (taskId: number, ctx: ActionContext) => Promise<TaskDetail>;
  listOpenTasks: (ctx: ActionContext) => Promise<ListedTask[]>;
  complete: (
    args: { system: string; user: string; label: string },
  ) => Promise<CompleteJSONResult<PrioritySuggestion>>;
  apply: (taskId: number, suggestion: PrioritySuggestion, ctx: ActionContext) => Promise<AppliedPriority>;
}

/** The subset of a serialised task the batch filter and the org context need. */
export interface ListedTask extends OpenTaskRow {
  status: string;
  completed: boolean;
  streamId: number | null;
  appId: number | null;
  prioritySource: string;
}

export interface ProviderOptions {
  config?: AiConfig;
  fetchImpl?: FetchLike;
}

/**
 * Registry-backed defaults. `task.get` and `task.list` are member-level reads,
 * so a manager calling a suggestion always clears their own gate.
 */
export function defaultDeps(provider: ProviderOptions = {}): SuggestDeps {
  return {
    getTask: async (taskId, ctx) => (await runAction("task.get", { taskId }, ctx)) as TaskDetail,
    listOpenTasks: async (ctx) => {
      const res = (await runAction("task.list", {}, ctx)) as { tasks: ListedTask[] };
      return (res.tasks ?? []).filter(isOpen);
    },
    complete: (args) =>
      completeJSON<PrioritySuggestion>({ ...args, schema: SUGGESTION_SPEC }, provider),
    apply: applyAiPriority,
  };
}

/* ─────────────────────── manual-score protection ─────────────────────── */

/**
 * A number a human typed is a decision, not a data point. The model may always
 * *propose* against it — that is free and reversible — but writing over it needs
 * `overrideManual: true` on the same call that asked to apply.
 */
export function manualBlocked(prioritySource: string, apply: boolean, overrideManual: boolean): boolean {
  return apply && prioritySource === "manual" && !overrideManual;
}

/* ─────────────────────────────── one card ─────────────────────────────── */

export interface SuggestionOutcome {
  taskId: number;
  title: string;
  current: { urgency: number; impact: number; effort: number; priorityScore: number; prioritySource: string; band: string };
  suggestion: {
    urgency: number;
    impact: number;
    effort: number;
    priorityScore: number;
    band: string;
    rationale: string;
    confidence: number;
  };
  delta: { urgency: number; impact: number; effort: number; priorityScore: number };
  applied: boolean;
  /** Why nothing was written: "manual" = a human's score, protected. */
  skipped: "manual" | null;
  usage: AiUsage;
  /** The updated card, only when `applied`. */
  task: AppliedPriority["task"] | null;
  /** The org distribution the model was calibrated against, for the UI's "why". */
  calibration: OrgPriorityContext;
}

export interface SuggestArgs {
  taskId: number;
  apply?: boolean;
  overrideManual?: boolean;
}

export async function suggestPriority(
  args: SuggestArgs,
  ctx: ActionContext,
  deps: SuggestDeps,
  label = "task.suggest_priority",
): Promise<SuggestionOutcome> {
  const [detail, open] = await Promise.all([deps.getTask(args.taskId, ctx), deps.listOpenTasks(ctx)]);
  const task = buildTaskContext(detail);
  const org = buildOrgContext(open);
  const { system, user } = buildSuggestionPrompt(task, org);

  const { data, usage } = await deps.complete({ system, user, label });
  const score = priorityScore(data.urgency, data.impact, data.effort);

  const apply = args.apply === true;
  const blocked = manualBlocked(task.current.prioritySource, apply, args.overrideManual === true);
  let applied: AppliedPriority | null = null;
  if (apply && !blocked) applied = await deps.apply(args.taskId, data, ctx);

  return {
    taskId: args.taskId,
    title: task.title,
    current: {
      urgency: task.current.urgency,
      impact: task.current.impact,
      effort: task.current.effort,
      priorityScore: task.current.priorityScore,
      prioritySource: task.current.prioritySource,
      band: scoreBand(task.current.priorityScore),
    },
    suggestion: {
      urgency: data.urgency,
      impact: data.impact,
      effort: data.effort,
      priorityScore: score,
      band: scoreBand(score),
      rationale: data.rationale,
      confidence: data.confidence,
    },
    delta: {
      urgency: data.urgency - task.current.urgency,
      impact: data.impact - task.current.impact,
      effort: data.effort - task.current.effort,
      priorityScore: score - task.current.priorityScore,
    },
    applied: !!applied,
    skipped: blocked ? "manual" : null,
    usage,
    task: applied?.task ?? null,
    calibration: org,
  };
}

/* ──────────────────────────────── the batch ──────────────────────────────── */

export interface BatchArgs {
  streamId?: number;
  appId?: number;
  limit?: number;
  apply?: boolean;
  overrideManual?: boolean;
}

export interface BatchFailure {
  taskId: number;
  title: string;
  error: string;
}

export interface BatchSkip {
  taskId: number;
  title: string;
  reason: "manual";
}

export interface BatchOutcome {
  considered: number;
  scored: number;
  applied: number;
  failed: number;
  skipped: BatchSkip[];
  results: SuggestionOutcome[];
  failures: BatchFailure[];
  totals: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  apply: boolean;
  concurrency: number;
}

/**
 * Candidates for a batch run: open cards under the chosen stream/app, highest
 * score first — the same order the backlog table shows — capped at `limit`.
 *
 * Cards pinned by hand are dropped here rather than scored and discarded: the
 * call that would produce a suggestion nobody may write is a call nobody should
 * pay for. `overrideManual` puts them back in.
 */
export function pickBatchCandidates(
  open: ListedTask[],
  args: BatchArgs,
): { candidates: ListedTask[]; skipped: BatchSkip[] } {
  let rows = open.filter(isOpen);
  if (args.streamId !== undefined) rows = rows.filter((t) => t.streamId === args.streamId);
  if (args.appId !== undefined) rows = rows.filter((t) => t.appId === args.appId);
  rows.sort((a, b) => b.priorityScore - a.priorityScore || a.id - b.id);

  const skipped: BatchSkip[] = [];
  if (args.overrideManual !== true) {
    const kept: ListedTask[] = [];
    for (const row of rows) {
      if (row.prioritySource === "manual") skipped.push({ taskId: row.id, title: row.title, reason: "manual" });
      else kept.push(row);
    }
    rows = kept;
  }

  const limit = Math.max(1, Math.min(args.limit ?? 10, BATCH_LIMIT_MAX));
  return { candidates: rows.slice(0, limit), skipped };
}

export async function suggestPriorityBatch(
  args: BatchArgs,
  ctx: ActionContext,
  deps: SuggestDeps,
  concurrency = BATCH_CONCURRENCY,
): Promise<BatchOutcome> {
  const open = await deps.listOpenTasks(ctx);
  const { candidates, skipped } = pickBatchCandidates(open, args);

  const settled = await mapWithConcurrency(candidates, concurrency, async (row) => {
    try {
      const outcome = await suggestPriority(
        { taskId: row.id, apply: args.apply, overrideManual: args.overrideManual },
        ctx,
        deps,
        "task.suggest_priority_batch",
      );
      return { ok: true as const, outcome };
    } catch (error) {
      // One card's failure is a row in the report, not the end of the batch.
      return {
        ok: false as const,
        failure: { taskId: row.id, title: row.title, error: error instanceof Error ? error.message : String(error) },
      };
    }
  });

  const results = settled
    .filter((r): r is { ok: true; outcome: SuggestionOutcome } => r.ok)
    .map((r) => r.outcome);
  const failures = settled
    .filter((r): r is { ok: false; failure: BatchFailure } => !r.ok)
    .map((r) => r.failure);
  const totals = results.reduce(
    (acc, r) => ({
      calls: acc.calls + 1,
      inputTokens: acc.inputTokens + r.usage.inputTokens,
      outputTokens: acc.outputTokens + r.usage.outputTokens,
      costUsd: acc.costUsd + r.usage.costUsd,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );

  return {
    considered: candidates.length,
    scored: results.length,
    applied: results.filter((r) => r.applied).length,
    failed: failures.length,
    skipped,
    results,
    failures,
    // Sub-cent sums otherwise arrive as 0.00030000000000000003.
    totals: { ...totals, costUsd: Math.round(totals.costUsd * 1_000_000) / 1_000_000 },
    apply: args.apply === true,
    concurrency: Math.max(1, Math.min(concurrency, Math.max(candidates.length, 1))),
  };
}
