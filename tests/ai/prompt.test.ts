import { describe, expect, it } from "vitest";

import {
  buildOrgContext,
  buildSuggestionPrompt,
  buildTaskContext,
  DESCRIPTION_LIMIT,
  percentile,
  RATIONALE_LIMIT,
  scoreBand,
  stripHtml,
  SUGGESTION_JSON_SCHEMA,
  SUGGESTION_SPEC,
  SUGGESTION_SYSTEM,
  truncate,
  type OpenTaskRow,
  type TaskDetail,
} from "../../server/ai/prompt";

function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task: {
      id: 41,
      title: "Rotate the signing key",
      description: "<p>The JWT secret has not moved since launch.</p><ul><li>rotate</li><li>re-issue</li></ul>",
      status: "triaged",
      startDate: "2026-09-21T00:00:00.000Z",
      dueDate: "2026-09-25T00:00:00.000Z",
      estimatedDuration: 180,
      tags: ["security", "ops"],
      urgency: 5,
      impact: 5,
      effort: 5,
      priorityScore: 5,
      prioritySource: "formula",
      priorityNote: null,
      completed: false,
    },
    stream: { id: 2, name: "Platform hardening" },
    app: { id: 3, key: "ptd", name: "Plan Track Done" },
    assignee: { displayName: "Ada", isAgent: true },
    dependencies: [{ id: 12, title: "Add a key-id header" }],
    dependents: [{ id: 50 }, { id: 51 }],
    blocked: true,
    ...over,
  };
}

const open = (rows: [number, number][]): OpenTaskRow[] =>
  rows.map(([id, priorityScore]) => ({ id, title: `Card ${id}`, priorityScore }));

describe("stripHtml", () => {
  it("flattens TipTap HTML to text, keeping list and paragraph breaks", () => {
    expect(stripHtml("<p>One</p><p>Two</p>")).toBe("One\nTwo");
    expect(stripHtml("<ul><li>a</li><li>b</li></ul>")).toBe("• a\n• b");
    expect(stripHtml("first<br>second")).toBe("first\nsecond");
  });

  it("decodes the entities the editor emits", () => {
    expect(stripHtml("<p>Rate &amp; limit &lt;100&gt; &quot;hard&quot;&nbsp;stop</p>")).toBe('Rate & limit <100> "hard" stop');
    expect(stripHtml("caf&#233;")).toBe("café");
  });

  it("drops script and style content instead of unwrapping it", () => {
    expect(stripHtml("<p>ok</p><script>alert('x')</script>")).toBe("ok");
    expect(stripHtml("<style>.a{color:red}</style><p>ok</p>")).toBe("ok");
  });

  it("is empty-safe and collapses whitespace", () => {
    expect(stripHtml(null)).toBe("");
    expect(stripHtml(undefined)).toBe("");
    expect(stripHtml("<p>   </p>")).toBe("");
    expect(stripHtml("<p>a\n\n\n\n\nb</p>")).toBe("a\nb");
  });

  it("truncates with an ellipsis at the limit", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
  });
});

describe("the org calibration block", () => {
  it("interpolates percentiles and lists the five highest-scored titles", () => {
    // sorted: 5 10 20 30 40 50 90 — p25 sits between 10 and 20, p75 between 40 and 50.
    const ctx = buildOrgContext(open([[1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 90], [7, 5]]));
    expect(ctx.openTasks).toBe(7);
    expect(ctx.p25).toBe(15);
    expect(ctx.p50).toBe(30);
    expect(ctx.p75).toBe(45);
    expect(ctx.top.map((t) => t.priorityScore)).toEqual([90, 50, 40, 30, 20]);
    expect(ctx.top).toHaveLength(5);
  });

  it("survives an empty and a one-card backlog", () => {
    expect(buildOrgContext([])).toEqual({ openTasks: 0, p25: null, p50: null, p75: null, top: [] });
    expect(buildOrgContext(open([[1, 42]])).p50).toBe(42);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("the card's brief", () => {
  it("keeps every fact the prompt promises and strips the HTML", () => {
    const ctx = buildTaskContext(detail());
    expect(ctx).toMatchObject({
      id: 41,
      title: "Rotate the signing key",
      status: "triaged",
      stream: "Platform hardening",
      app: "ptd (Plan Track Done)",
      startDate: "2026-09-21",
      dueDate: "2026-09-25",
      estimateMinutes: 180,
      dependencyCount: 1,
      dependencyTitles: ["Add a key-id header"],
      dependentCount: 2,
      assignee: "agent",
      tags: ["security", "ops"],
      blocked: true,
    });
    expect(ctx.description).toBe("The JWT secret has not moved since launch.\n• rotate\n• re-issue");
  });

  it("distinguishes a human, an agent and nobody", () => {
    expect(buildTaskContext(detail({ assignee: { displayName: "Elena", isAgent: false } })).assignee).toBe("human");
    expect(buildTaskContext(detail({ assignee: null })).assignee).toBe("nobody");
  });

  it("caps the description so one enormous card cannot dominate the prompt", () => {
    const ctx = buildTaskContext(detail({ task: { ...detail().task, description: "x".repeat(5000) } }));
    expect(ctx.description).toHaveLength(DESCRIPTION_LIMIT);
  });

  it("carries the current score and its source through", () => {
    const ctx = buildTaskContext(
      detail({ task: { ...detail().task, urgency: 9, impact: 8, effort: 2, priorityScore: 36, prioritySource: "manual", priorityNote: "CEO asked" } }),
    );
    expect(ctx.current).toEqual({ urgency: 9, impact: 8, effort: 2, priorityScore: 36, prioritySource: "manual", priorityNote: "CEO asked" });
  });
});

describe("the prompt", () => {
  const { system, user } = buildSuggestionPrompt(buildTaskContext(detail()), buildOrgContext(open([[1, 10], [2, 50], [3, 90]])));

  it("puts the formula and the three definitions in the fixed system half", () => {
    expect(system).toBe(SUGGESTION_SYSTEM);
    expect(system).toContain("urgency × impact / max(effort, 1)");
    expect(system).toContain("Effort DIVIDES the score");
    expect(system.toLowerCase()).toContain("json");
  });

  it("states every fact about the card exactly once", () => {
    expect(user).toContain("title: Rotate the signing key");
    expect(user).toContain("status: triaged");
    expect(user).toContain("stream: Platform hardening");
    expect(user).toContain("app: ptd (Plan Track Done)");
    expect(user).toContain("assignee: agent");
    expect(user).toContain("due: 2026-09-25");
    expect(user).toContain("estimate (minutes): 180");
    expect(user).toContain("tags: security, ops");
    expect(user).toContain("depends on: 1 card — Add a key-id header");
    expect(user).toContain("cards waiting on this one: 2");
    expect(user).toContain("blocked right now: yes");
    expect(user).toContain("current score: urgency 5 × impact 5 ÷ effort 5 = 5 (formula)");
    expect(user).toContain("The JWT secret has not moved since launch.");
  });

  it("carries the org distribution so the number means something locally", () => {
    expect(user).toContain("open cards: 3");
    expect(user).toContain("p25 30 · p50 50 · p75 70");
    expect(user).toContain("highest-scored open cards:");
    expect(user).toContain("90 — Card 3");
  });

  it("leaves empty fields out rather than printing 'null'", () => {
    const bare = buildSuggestionPrompt(
      buildTaskContext(
        detail({
          task: { ...detail().task, description: null, dueDate: null, startDate: null, estimatedDuration: null, tags: [] },
          stream: null,
          app: null,
          assignee: null,
          dependencies: [],
          dependents: [],
          blocked: false,
        }),
      ),
      buildOrgContext([]),
    ).user;
    expect(bare).not.toContain("null");
    expect(bare).not.toContain("undefined");
    expect(bare).toContain("stream: none");
    expect(bare).toContain("(empty)");
    expect(bare).not.toContain("blocked right now");
  });
});

describe("the JSON contract", () => {
  it("is a strict object schema, which is what a forced tool call needs", () => {
    expect(SUGGESTION_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(SUGGESTION_JSON_SCHEMA.required).toEqual(["urgency", "impact", "effort", "rationale", "confidence"]);
    expect(SUGGESTION_SPEC.name).toBe("score_priority");
  });

  it("accepts a good answer untouched", () => {
    expect(SUGGESTION_SPEC.parse({ urgency: 8, impact: 7, effort: 3, rationale: "Overdue.", confidence: 0.8 })).toEqual({
      urgency: 8,
      impact: 7,
      effort: 3,
      rationale: "Overdue.",
      confidence: 0.8,
    });
  });

  it("clamps, rounds and truncates a sloppy one", () => {
    const parsed = SUGGESTION_SPEC.parse({ urgency: 10.4, impact: 99, effort: -1, rationale: ` ${"y".repeat(400)} `, confidence: -2 });
    expect(parsed).toMatchObject({ urgency: 10, impact: 10, effort: 0, confidence: 0 });
    expect(parsed.rationale).toHaveLength(RATIONALE_LIMIT);
  });

  it("rejects a missing field, a wrong type and an empty rationale", () => {
    expect(() => SUGGESTION_SPEC.parse({ urgency: 5, impact: 5, effort: 5, confidence: 0.5 })).toThrow(/rationale/);
    expect(() => SUGGESTION_SPEC.parse({ urgency: "high", impact: 5, effort: 5, rationale: "x", confidence: 0.5 })).toThrow(/urgency/);
    expect(() => SUGGESTION_SPEC.parse({ urgency: 5, impact: 5, effort: 5, rationale: "", confidence: 0.5 })).toThrow(/rationale/);
    expect(() => SUGGESTION_SPEC.parse(null)).toThrow();
  });
});

describe("bands", () => {
  it("uses the same thresholds as the rest of the Overview", () => {
    expect(scoreBand(100)).toBe("critical");
    expect(scoreBand(75)).toBe("critical");
    expect(scoreBand(74)).toBe("high");
    expect(scoreBand(25)).toBe("medium");
    expect(scoreBand(24)).toBe("low");
  });
});
