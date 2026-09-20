import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Role } from "../../db/schema";

const callAction = vi.fn();
const getMe = vi.fn();
const getCurrentOrg = vi.fn();

vi.mock("@/lib/api", () => ({
  callAction: (...args: unknown[]) => callAction(...args),
  getMe: () => getMe(),
  getCurrentOrg: () => getCurrentOrg(),
  api: vi.fn(),
}));

const TaskDrawer = (await import("../../client/src/features/overview/TaskDrawer")).default;
const { prioritySourceLabel, prioritySourceTitle, formatAiCost, formatConfidence, formatDelta, AI_MANUAL_PROMISE } =
  await import("../../client/src/features/overview/format");
import type { TaskRow } from "../../client/src/features/overview/types";

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 7,
  title: "Rotate the signing key",
  description: "The JWT secret has not moved since launch.",
  status: "backlog",
  streamId: 2,
  streamName: "Platform hardening",
  streamColor: null,
  appId: null,
  appKey: null,
  appName: null,
  assignedTo: null,
  assigneeName: null,
  assigneeIsAgent: null,
  startDate: null,
  dueDate: null,
  estimatedDuration: null,
  dependencies: [],
  externalKey: null,
  urgency: 5,
  impact: 5,
  effort: 5,
  priorityScore: 5,
  prioritySource: "formula",
  priorityNote: null,
  tags: [],
  completed: false,
  createdBy: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const SUGGESTION = {
  taskId: 7,
  title: "Rotate the signing key",
  current: { urgency: 5, impact: 5, effort: 5, priorityScore: 5, prioritySource: "formula", band: "low" },
  suggestion: { urgency: 9, impact: 8, effort: 2, priorityScore: 36, band: "medium", rationale: "Key has never been rotated; two cards wait on it.", confidence: 0.82 },
  delta: { urgency: 4, impact: 3, effort: -3, priorityScore: 31 },
  applied: false,
  skipped: null,
  usage: { provider: "anthropic", model: "claude-haiku-4-5", inputTokens: 640, outputTokens: 96, costUsd: 0.00112, priced: true, attempts: 1, durationMs: 830 },
  task: null,
  calibration: { openTasks: 12, p25: 8, p50: 20, p75: 45, top: [] },
};

function mount(row: TaskRow, onTaskUpdated = vi.fn(), role: Role = "manager") {
  getMe.mockResolvedValue({ user: { id: 1, email: "elena@atelier14.demo", displayName: "Elena", isAgent: false, createdAt: "" }, authType: "human", orgs: [] });
  getCurrentOrg.mockResolvedValue({ id: 4, name: "Atelier 14", slug: "atelier-14", plan: "free", role, createdAt: "" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TaskDrawer task={row} open onOpenChange={vi.fn()} onTaskUpdated={onTaskUpdated} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onTaskUpdated };
}

/** ai.status first, then whatever the test scripts for the suggestion call. */
function wire(status: { configured: boolean; provider?: string; model?: string }, ...suggestions: unknown[]) {
  let next = 0;
  callAction.mockImplementation((name: string) => {
    if (name === "ai.status") return Promise.resolve({ configured: status.configured, provider: status.provider ?? null, model: status.model ?? null });
    if (name === "task.suggest_priority") {
      const reply = suggestions[Math.min(next++, suggestions.length - 1)];
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    }
    return Promise.resolve({});
  });
}

beforeEach(() => callAction.mockReset());
afterEach(() => vi.clearAllMocks());

describe("format helpers", () => {
  it("labels only the sources worth a glyph", () => {
    expect(prioritySourceLabel("ai")).toBe("AI");
    expect(prioritySourceLabel("manual")).toBe("manual");
    expect(prioritySourceLabel("formula")).toBeNull();
    expect(prioritySourceLabel(undefined)).toBeNull();
  });

  it("explains each source, and repeats the manual promise where it matters", () => {
    expect(prioritySourceTitle("ai")).toContain(AI_MANUAL_PROMISE);
    expect(prioritySourceTitle("manual")).toContain(AI_MANUAL_PROMISE);
    expect(prioritySourceTitle("formula")).toContain("urgency × impact ÷ effort");
  });

  it("shows sub-cent costs honestly and signs deltas", () => {
    expect(formatAiCost(0.00112)).toBe("$0.0011");
    expect(formatAiCost(0)).toBe("$0");
    expect(formatAiCost(1.5)).toBe("$1.50");
    expect(formatConfidence(0.824)).toBe("82%");
    expect(formatDelta(31)).toBe("+31");
    expect(formatDelta(-4)).toBe("−4");
    expect(formatDelta(0)).toBe("0");
  });
});

describe("the drawer with AI switched off", () => {
  it("shows no button at all", async () => {
    wire({ configured: false });
    mount(task());
    await waitFor(() => expect(callAction).toHaveBeenCalledWith("ai.status", {}));
    expect(screen.queryByTestId("suggest-priority-button")).toBeNull();
    expect(screen.getByTestId("task-drawer")).toBeInTheDocument();
  });

  it("shows no button to a member even when it is configured", async () => {
    wire({ configured: true, provider: "anthropic", model: "claude-haiku-4-5" });
    mount(task(), vi.fn(), "member");
    await waitFor(() => expect(callAction).toHaveBeenCalledWith("ai.status", {}));
    expect(screen.queryByTestId("suggest-priority-button")).toBeNull();
  });
});

describe("the suggest → apply flow", () => {
  it("proposes, shows the numbers, the rationale, the confidence and the cost", async () => {
    wire({ configured: true, provider: "anthropic", model: "claude-haiku-4-5" }, SUGGESTION);
    mount(task());

    const button = await screen.findByTestId("suggest-priority-button");
    expect(button.getAttribute("title")).toContain(AI_MANUAL_PROMISE);
    await userEvent.click(button);

    const panel = await screen.findByTestId("ai-suggestion-panel");
    expect(panel).toBeInTheDocument();
    expect(callAction).toHaveBeenCalledWith("task.suggest_priority", { taskId: 7 });
    expect(screen.getByTestId("ai-suggestion-score")).toHaveTextContent("P 36");
    expect(screen.getByTestId("ai-suggestion-delta")).toHaveTextContent("was 5 · +31");
    expect(screen.getByTestId("ai-rationale")).toHaveTextContent("Key has never been rotated");
    expect(screen.getByTestId("ai-confidence")).toHaveTextContent("82%");
    expect(screen.getByTestId("ai-cost")).toHaveTextContent("$0.0011");
    expect(screen.getByTestId("ai-slider-urgency")).toHaveValue("9");
    expect(screen.getByTestId("ai-slider-effort")).toHaveValue("2");
    expect(panel).toHaveTextContent("Calibrated against 12 open cards");
  });

  it("writes only when Apply is pressed, and tells the caller what changed", async () => {
    wire(
      { configured: true, provider: "anthropic", model: "claude-haiku-4-5" },
      SUGGESTION,
      { ...SUGGESTION, applied: true, task: { id: 7, priorityScore: 36, prioritySource: "ai" } },
    );
    const { onTaskUpdated } = mount(task());

    await userEvent.click(await screen.findByTestId("suggest-priority-button"));
    await screen.findByTestId("ai-suggestion-panel");
    expect(onTaskUpdated).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("ai-apply"));
    await waitFor(() => expect(callAction).toHaveBeenCalledWith("task.suggest_priority", { taskId: 7, apply: true }));
    await waitFor(() =>
      expect(onTaskUpdated).toHaveBeenCalledWith({
        urgency: 9,
        impact: 8,
        effort: 2,
        priorityScore: 36,
        prioritySource: "ai",
        priorityNote: SUGGESTION.suggestion.rationale,
      }),
    );
    expect(await screen.findByTestId("ai-applied")).toBeInTheDocument();
  });

  it("dismisses back to the button, having written nothing", async () => {
    wire({ configured: true, provider: "anthropic", model: "claude-haiku-4-5" }, SUGGESTION);
    const { onTaskUpdated } = mount(task());

    await userEvent.click(await screen.findByTestId("suggest-priority-button"));
    await userEvent.click(await screen.findByTestId("ai-dismiss"));
    expect(screen.queryByTestId("ai-suggestion-panel")).toBeNull();
    expect(await screen.findByTestId("suggest-priority-button")).toBeInTheDocument();
    expect(onTaskUpdated).not.toHaveBeenCalled();
  });

  it("surfaces the provider's error in the panel instead of failing silently", async () => {
    wire({ configured: true, provider: "anthropic", model: "claude-haiku-4-5" }, new Error("rate limited, retry in 3s"));
    mount(task());
    await userEvent.click(await screen.findByTestId("suggest-priority-button"));
    expect(await screen.findByTestId("ai-error")).toHaveTextContent("rate limited, retry in 3s");
  });
});

describe("a score someone set by hand", () => {
  const manual = task({ prioritySource: "manual", priorityScore: 80, priorityNote: "CEO asked" });

  it("blocks Apply until the override is ticked", async () => {
    wire(
      { configured: true, provider: "anthropic", model: "claude-haiku-4-5" },
      { ...SUGGESTION, current: { ...SUGGESTION.current, prioritySource: "manual", priorityScore: 80 }, delta: { ...SUGGESTION.delta, priorityScore: -44 } },
      { ...SUGGESTION, applied: true, task: { id: 7 } },
    );
    mount(manual);

    await userEvent.click(await screen.findByTestId("suggest-priority-button"));
    const apply = await screen.findByTestId("ai-apply");
    expect(apply).toBeDisabled();
    expect(apply.getAttribute("title")).toContain("never replaced without confirmation");

    const override = screen.getByTestId("ai-override-manual");
    await userEvent.click(override);
    expect(apply).toBeEnabled();

    await userEvent.click(apply);
    await waitFor(() =>
      expect(callAction).toHaveBeenCalledWith("task.suggest_priority", { taskId: 7, apply: true, overrideManual: true }),
    );
  });

  it("says so on the card itself, with the promise in the tooltip", async () => {
    wire({ configured: false });
    mount(manual);
    const note = await screen.findByTestId("priority-source-note");
    expect(note).toHaveTextContent("manual");
    expect(note).toHaveTextContent("CEO asked");
    expect(note.getAttribute("title")).toContain(AI_MANUAL_PROMISE);
  });

  it("marks a card the AI scored as such", async () => {
    wire({ configured: false });
    mount(task({ prioritySource: "ai", priorityNote: "Overdue and blocking two cards." }));
    const note = await screen.findByTestId("priority-source-note");
    expect(note).toHaveTextContent("AI");
    expect(note).toHaveTextContent("Suggested by the model, accepted by a manager");
  });
});
