import { describe, expect, it, vi } from "vitest";

// suggest.ts pulls in the write path, which imports the drizzle client at load
// time. Every collaborator here is injected, so an empty stub keeps the suite
// off a live database.
vi.mock("../../db", () => ({ db: {} }));

import type { ActionContext } from "../../server/actions/registry";
import { mapWithConcurrency } from "../../server/ai/concurrency";
import type { PrioritySuggestion, TaskDetail } from "../../server/ai/prompt";
import type { AiUsage, CompleteJSONResult } from "../../server/ai/provider";
import {
  BATCH_CONCURRENCY,
  BATCH_LIMIT_MAX,
  isOpen,
  manualBlocked,
  pickBatchCandidates,
  suggestPriority,
  suggestPriorityBatch,
  type ListedTask,
  type SuggestDeps,
} from "../../server/ai/suggest";
import { DEFAULT_SUGGESTION } from "./stub";

const ctx: ActionContext = {
  userId: 1,
  email: "elena@atelier14.demo",
  displayName: "Elena",
  orgId: 4,
  role: "manager",
  authType: "human",
  via: "web",
};

const usage: AiUsage = {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  inputTokens: 600,
  outputTokens: 80,
  costUsd: 0.001,
  priced: true,
  attempts: 1,
  durationMs: 12,
};

function listed(id: number, over: Partial<ListedTask> = {}): ListedTask {
  return { id, title: `Card ${id}`, priorityScore: 50, status: "backlog", completed: false, streamId: 1, appId: 1, prioritySource: "formula", ...over };
}

function detailFor(row: ListedTask): TaskDetail {
  return {
    task: {
      id: row.id,
      title: row.title,
      description: "something to do",
      status: row.status,
      startDate: null,
      dueDate: null,
      estimatedDuration: null,
      tags: [],
      urgency: 5,
      impact: 5,
      effort: 5,
      priorityScore: row.priorityScore,
      prioritySource: row.prioritySource,
      priorityNote: null,
      completed: row.completed,
    },
    stream: null,
    app: null,
    assignee: null,
    dependencies: [],
    dependents: [],
    blocked: false,
  };
}

/**
 * A fake of every collaborator: the two registry reads, the provider and the
 * write. `open` is the backlog; `suggestion` is what the model answers.
 */
function deps(
  open: ListedTask[],
  over: { suggestion?: PrioritySuggestion; complete?: SuggestDeps["complete"]; applyImpl?: SuggestDeps["apply"] } = {},
) {
  const applied: { taskId: number; suggestion: PrioritySuggestion }[] = [];
  const prompts: { system: string; user: string; label: string }[] = [];
  const complete: SuggestDeps["complete"] = over.complete
    ? over.complete
    : async (args) => {
        prompts.push(args);
        return { data: over.suggestion ?? DEFAULT_SUGGESTION, usage } as CompleteJSONResult<PrioritySuggestion>;
      };

  const value: SuggestDeps = {
    getTask: async (taskId) => {
      const row = open.find((t) => t.id === taskId);
      if (!row) throw new Error(`Task ${taskId} not found in this organization`);
      return detailFor(row);
    },
    listOpenTasks: async () => open,
    complete,
    apply:
      over.applyImpl ??
      (async (taskId, suggestion) => {
        applied.push({ taskId, suggestion });
        return { task: { id: taskId, prioritySource: "ai" } as never, changed: true };
      }),
  };
  return { deps: value, applied, prompts };
}

describe("one suggestion", () => {
  it("derives the score with PTD's formula and reports the delta, band and cost", async () => {
    const { deps: d, prompts } = deps([listed(7, { priorityScore: 5 })]);
    const res = await suggestPriority({ taskId: 7 }, ctx, d);

    // 8 × 7 / 3 = 18.67 → 19
    expect(res.suggestion).toMatchObject({ urgency: 8, impact: 7, effort: 3, priorityScore: 19, band: "low" });
    expect(res.current).toMatchObject({ urgency: 5, impact: 5, effort: 5, priorityScore: 5, prioritySource: "formula", band: "low" });
    expect(res.delta).toEqual({ urgency: 3, impact: 2, effort: -2, priorityScore: 14 });
    expect(res.usage.costUsd).toBe(0.001);
    expect(res.calibration.openTasks).toBe(1);
    expect(prompts[0].label).toBe("task.suggest_priority");
  });

  it("writes nothing without apply", async () => {
    const { deps: d, applied } = deps([listed(7)]);
    const res = await suggestPriority({ taskId: 7 }, ctx, d);
    expect(applied).toEqual([]);
    expect(res.applied).toBe(false);
    expect(res.task).toBeNull();
    expect(res.skipped).toBeNull();
  });

  it("writes the three numbers on apply and hands back the updated card", async () => {
    const { deps: d, applied } = deps([listed(7)]);
    const res = await suggestPriority({ taskId: 7, apply: true }, ctx, d);
    expect(applied).toEqual([{ taskId: 7, suggestion: DEFAULT_SUGGESTION }]);
    expect(res.applied).toBe(true);
    expect(res.task).toMatchObject({ id: 7, prioritySource: "ai" });
  });

  it("only counts the open cards it was given as calibration", async () => {
    const { deps: d } = deps([listed(1), listed(2, { priorityScore: 90 }), listed(3, { priorityScore: 10 })]);
    const res = await suggestPriority({ taskId: 1 }, ctx, d);
    expect(res.calibration.openTasks).toBe(3);
    expect(res.calibration.top[0].priorityScore).toBe(90);
  });
});

describe("manual-score protection", () => {
  it("is the rule: apply + manual + no override = blocked, everything else allowed", () => {
    expect(manualBlocked("manual", true, false)).toBe(true);
    expect(manualBlocked("manual", true, true)).toBe(false);
    // A proposal against a manual score is always fine — nothing is written.
    expect(manualBlocked("manual", false, false)).toBe(false);
    expect(manualBlocked("formula", true, false)).toBe(false);
    expect(manualBlocked("ai", true, false)).toBe(false);
  });

  it("still proposes against a hand-set score, but refuses to write it", async () => {
    const { deps: d, applied } = deps([listed(7, { prioritySource: "manual", priorityScore: 80 })]);
    const res = await suggestPriority({ taskId: 7, apply: true }, ctx, d);
    expect(applied).toEqual([]);
    expect(res.applied).toBe(false);
    expect(res.skipped).toBe("manual");
    // The proposal itself is intact, so the UI can show what it would have done.
    expect(res.suggestion.priorityScore).toBe(19);
    expect(res.delta.priorityScore).toBe(-61);
  });

  it("writes it once overrideManual is passed with apply", async () => {
    const { deps: d, applied } = deps([listed(7, { prioritySource: "manual" })]);
    const res = await suggestPriority({ taskId: 7, apply: true, overrideManual: true }, ctx, d);
    expect(applied).toHaveLength(1);
    expect(res.applied).toBe(true);
    expect(res.skipped).toBeNull();
  });

  it("ignores overrideManual on a read-only call", async () => {
    const { deps: d, applied } = deps([listed(7, { prioritySource: "manual" })]);
    const res = await suggestPriority({ taskId: 7, overrideManual: true }, ctx, d);
    expect(applied).toEqual([]);
    expect(res.applied).toBe(false);
  });

  it("overwrites an earlier AI score without ceremony", async () => {
    const { deps: d, applied } = deps([listed(7, { prioritySource: "ai" })]);
    const res = await suggestPriority({ taskId: 7, apply: true }, ctx, d);
    expect(applied).toHaveLength(1);
    expect(res.skipped).toBeNull();
  });
});

describe("candidate selection", () => {
  const backlog: ListedTask[] = [
    listed(1, { priorityScore: 90, streamId: 1, appId: 1 }),
    listed(2, { priorityScore: 70, streamId: 2, appId: 1 }),
    listed(3, { priorityScore: 50, streamId: 1, appId: 2 }),
    listed(4, { priorityScore: 30, streamId: 1, appId: 1, prioritySource: "manual" }),
    listed(5, { priorityScore: 10, streamId: 1, appId: 1 }),
  ];

  it("takes the highest-scored open cards and honours the limit", () => {
    const { candidates } = pickBatchCandidates(backlog, { limit: 2 });
    expect(candidates.map((c) => c.id)).toEqual([1, 2]);
  });

  it("filters by stream and by app", () => {
    expect(pickBatchCandidates(backlog, { streamId: 1 }).candidates.map((c) => c.id)).toEqual([1, 3, 5]);
    expect(pickBatchCandidates(backlog, { appId: 2 }).candidates.map((c) => c.id)).toEqual([3]);
    expect(pickBatchCandidates(backlog, { streamId: 1, appId: 1 }).candidates.map((c) => c.id)).toEqual([1, 5]);
  });

  it("drops hand-scored cards before spending a call, and reports them", () => {
    const { candidates, skipped } = pickBatchCandidates(backlog, {});
    expect(candidates.map((c) => c.id)).not.toContain(4);
    expect(skipped).toEqual([{ taskId: 4, title: "Card 4", reason: "manual" }]);
  });

  it("includes them when overrideManual is set", () => {
    const { candidates, skipped } = pickBatchCandidates(backlog, { overrideManual: true });
    expect(candidates.map((c) => c.id)).toContain(4);
    expect(skipped).toEqual([]);
  });

  it("never exceeds the hard cap, whatever the caller asks for", () => {
    const many = Array.from({ length: 60 }, (_, i) => listed(i + 1, { priorityScore: 60 - i }));
    expect(pickBatchCandidates(many, { limit: 999 }).candidates).toHaveLength(BATCH_LIMIT_MAX);
    expect(pickBatchCandidates(many, {}).candidates).toHaveLength(10);
  });

  it("leaves closed cards out of the backlog entirely", () => {
    expect(isOpen({ status: "backlog", completed: false })).toBe(true);
    expect(isOpen({ status: "completed", completed: true })).toBe(false);
    expect(isOpen({ status: "wontfix", completed: false })).toBe(false);
    const closed = [...backlog, listed(6, { status: "wontfix", priorityScore: 99 })];
    expect(pickBatchCandidates(closed, {}).candidates.map((c) => c.id)).not.toContain(6);
  });
});

describe("the batch", () => {
  const backlog = Array.from({ length: 9 }, (_, i) => listed(i + 1, { priorityScore: 90 - i * 10 }));

  it("runs three at a time, never more", async () => {
    let inFlight = 0;
    let peak = 0;
    const { deps: d } = deps(backlog, {
      complete: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { data: DEFAULT_SUGGESTION, usage } as CompleteJSONResult<PrioritySuggestion>;
      },
    });

    const res = await suggestPriorityBatch({ limit: 9 }, ctx, d);
    expect(res.scored).toBe(9);
    expect(peak).toBe(BATCH_CONCURRENCY);
    expect(peak).toBe(3);
  });

  it("sums tokens and dollars across the run without float noise", async () => {
    const { deps: d } = deps(backlog);
    const res = await suggestPriorityBatch({ limit: 3 }, ctx, d);
    expect(res.totals).toEqual({ calls: 3, inputTokens: 1800, outputTokens: 240, costUsd: 0.003 });
  });

  it("is a dry run unless apply is passed", async () => {
    const { deps: d, applied } = deps(backlog);
    const dry = await suggestPriorityBatch({ limit: 3 }, ctx, d);
    expect(dry.apply).toBe(false);
    expect(dry.applied).toBe(0);
    expect(applied).toEqual([]);

    const wet = await suggestPriorityBatch({ limit: 3, apply: true }, ctx, d);
    expect(wet.apply).toBe(true);
    expect(wet.applied).toBe(3);
    expect(applied).toHaveLength(3);
  });

  it("keeps going when one card fails, and reports it as a row", async () => {
    let n = 0;
    const { deps: d } = deps(backlog, {
      complete: async () => {
        n += 1;
        if (n === 2) throw new Error("rate limited, retry in 3s");
        return { data: DEFAULT_SUGGESTION, usage } as CompleteJSONResult<PrioritySuggestion>;
      },
    });
    const res = await suggestPriorityBatch({ limit: 4 }, ctx, d);
    expect(res.scored).toBe(3);
    expect(res.failed).toBe(1);
    expect(res.failures[0].error).toBe("rate limited, retry in 3s");
    // The failed card is not billed into the totals, the other three are.
    expect(res.totals.calls).toBe(3);
  });

  it("reports a stream with nothing open as an empty run rather than an error", async () => {
    const { deps: d } = deps(backlog);
    const res = await suggestPriorityBatch({ streamId: 99 }, ctx, d);
    expect(res).toMatchObject({ considered: 0, scored: 0, applied: 0, failed: 0 });
    expect(res.totals.calls).toBe(0);
  });

  it("labels every call as the batch, so the usage ledger can tell them apart", async () => {
    const { deps: d, prompts } = deps(backlog);
    await suggestPriorityBatch({ limit: 2 }, ctx, d);
    expect(prompts.map((p) => p.label)).toEqual(["task.suggest_priority_batch", "task.suggest_priority_batch"]);
  });
});

describe("mapWithConcurrency", () => {
  it("keeps input order whatever the completion order", async () => {
    const out = await mapWithConcurrency([30, 5, 20, 1], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:1"]);
  });

  it("never opens more workers than items, and copes with an empty list", async () => {
    const seen = vi.fn(async (n: number) => n);
    expect(await mapWithConcurrency([], 5, seen)).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
    expect(await mapWithConcurrency([1, 2], 10, seen)).toEqual([1, 2]);
  });

  it("treats a nonsense limit as one worker", async () => {
    let peak = 0;
    let live = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      live -= 1;
    });
    expect(peak).toBe(1);
  });
});
