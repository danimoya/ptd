import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundEvent } from "../../server/webhooks";

/**
 * PTD → GitHub, with the REST client and the store stubbed.
 *
 * The important assertions here are the ones about *not* acting: the loop guard, the
 * direction, and the absence of a mirrored field change. An adapter that echoes is worse
 * than one that misses an edit.
 */

vi.mock("../../db", () => ({ db: {} }));

const stubs = vi.hoisted(() => {
  const mapping = {
    streamId: 5,
    repo: "danimoya/ptd",
    direction: "both" as "both" | "in" | "out",
    mappedBy: 7,
    mappedAt: "2026-09-01T00:00:00.000Z",
  };
  const row = {
    id: 1,
    orgId: 3,
    enabled: true,
    createdBy: 7,
    createdAt: new Date(),
    config: { installationId: 555, account: { login: "danimoya", type: "User", id: 1 }, mappings: [mapping], installedBy: 7 },
  };
  return {
    mapping,
    row,
    getGithubForOrg: vi.fn(async () => row as typeof row | null),
    patchMapping: vi.fn(async () => row),
    installationToken: vi.fn(async () => ({ ok: true as const, token: "ghs-test", expiresAt: Date.now() + 3_600_000 })),
    createIssue: vi.fn(async () => ({ ok: true, status: 201, data: { number: 77, html_url: "x" } })),
    patchIssue: vi.fn(async () => ({ ok: true, status: 200, data: { number: 77, state: "closed" } })),
    serverContextFor: vi.fn(async () => ({
      userId: 7,
      email: "dani@example.com",
      displayName: "Dani",
      orgId: 3,
      role: "admin" as const,
      authType: "human" as const,
      via: "github" as const,
    })),
    runAction: vi.fn(async () => ({ changed: true })),
  };
});

vi.mock("../../server/integrations/github/store", () => ({
  getGithubForOrg: stubs.getGithubForOrg,
  patchMapping: stubs.patchMapping,
}));

vi.mock("../../server/integrations/github/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/github/api")>();
  return { ...actual, installationToken: stubs.installationToken, createIssue: stubs.createIssue, patchIssue: stubs.patchIssue };
});

vi.mock("../../server/integrations/shared/identity", () => ({ serverContextFor: stubs.serverContextFor }));

const { cameFromGithub, notifyGithub } = await import("../../server/integrations/github/notify");

const task = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  title: "Ship the GitHub adapter",
  description: "Two directions, one externalKey.",
  streamId: 5,
  externalKey: null,
  tags: ["adapter"],
  ...overrides,
});

const event = (kind: string, payload: Record<string, unknown>): OutboundEvent => ({
  kind,
  taskId: 42,
  actor: { userId: 7, label: "Dani", isAgent: false },
  payload: { via: "web", ...payload },
});

const notify = (e: OutboundEvent) => notifyGithub(3, e, { runAction: stubs.runAction as never });

beforeEach(() => {
  vi.clearAllMocks();
  stubs.mapping.direction = "both";
  stubs.getGithubForOrg.mockResolvedValue(stubs.row);
  stubs.installationToken.mockResolvedValue({ ok: true as const, token: "ghs-test", expiresAt: Date.now() + 3_600_000 });
  stubs.createIssue.mockResolvedValue({ ok: true, status: 201, data: { number: 77, html_url: "x" } });
  stubs.patchIssue.mockResolvedValue({ ok: true, status: 200, data: { number: 77, state: "closed" } });
});

describe("the loop guard", () => {
  it("recognises an event PTD wrote because of GitHub", () => {
    expect(cameFromGithub(event("task.created", { task: task() }))).toBe(false);
    expect(cameFromGithub({ kind: "task.created", payload: { via: "github" } })).toBe(true);
    expect(cameFromGithub({ kind: "task.created", actor: { userId: 1, label: "x", via: "github" } as never })).toBe(true);
  });

  it("does nothing at all for an event that came from GitHub", async () => {
    const outcome = await notifyGithub(3, { kind: "task.created", taskId: 42, payload: { via: "github", task: task() } });
    expect(outcome).toEqual({ acted: false, reason: "loop_guard" });
    expect(stubs.createIssue).not.toHaveBeenCalled();
    expect(stubs.getGithubForOrg).not.toHaveBeenCalled();
  });

  it("stamps the issue key back with via github, so the update it causes is ignored in turn", async () => {
    await notify(event("task.created", { task: task() }));
    expect(stubs.runAction).toHaveBeenCalledWith(
      "task.update",
      { taskId: 42, externalKey: "gh:danimoya/ptd#77" },
      expect.objectContaining({ via: "github" }),
    );
  });
});

describe("task.created", () => {
  it("opens an issue in the mapped repository with the card's title, body and tags", async () => {
    const outcome = await notify(event("task.created", { task: task() }));
    expect(outcome).toMatchObject({ acted: true, repo: "danimoya/ptd", issue: 77, taskId: 42 });
    expect(stubs.createIssue).toHaveBeenCalledWith("danimoya/ptd", "ghs-test", {
      title: "Ship the GitHub adapter",
      body: "Two directions, one externalKey.",
      labels: ["adapter"],
    });
  });

  it("says where a card with no description came from, rather than opening an empty issue", async () => {
    await notify(event("task.created", { task: task({ description: null, tags: [] }) }));
    expect(stubs.createIssue.mock.calls[0][2]).toEqual({ title: "Ship the GitHub adapter", body: "Opened from PTD · task #42" });
  });

  it("leaves an unmapped stream alone", async () => {
    const outcome = await notify(event("task.created", { task: task({ streamId: 99 }) }));
    expect(outcome).toMatchObject({ acted: false, reason: "stream_not_mapped_outbound" });
    expect(stubs.createIssue).not.toHaveBeenCalled();
  });

  it("does not write to a stream mapped as in-only", async () => {
    stubs.mapping.direction = "in";
    const outcome = await notify(event("task.created", { task: task() }));
    expect(outcome).toMatchObject({ acted: false, reason: "stream_not_mapped_outbound" });
    expect(stubs.createIssue).not.toHaveBeenCalled();
  });

  it("does nothing for a card that already has an issue", async () => {
    const outcome = await notify(event("task.created", { task: task({ externalKey: "gh:danimoya/ptd#12" }) }));
    expect(stubs.createIssue).not.toHaveBeenCalled();
    expect(outcome.acted).toBe(false);
  });

  it("records the failure on the mapping when GitHub refuses, and never throws", async () => {
    stubs.createIssue.mockResolvedValue({ ok: false, status: 403, data: null, error: "403: Resource not accessible" });
    const outcome = await notify(event("task.created", { task: task() }));
    expect(outcome.acted).toBe(false);
    expect(stubs.patchMapping).toHaveBeenCalledWith(3, 5, expect.objectContaining({ lastError: expect.stringContaining("403") }));
    expect(stubs.runAction).not.toHaveBeenCalled();
  });
});

describe("task.completed", () => {
  it("closes the issue the card is keyed to", async () => {
    const outcome = await notify(event("task.completed", { task: task({ externalKey: "gh:danimoya/ptd#12" }) }));
    expect(outcome).toMatchObject({ acted: true, issue: 12 });
    expect(stubs.patchIssue).toHaveBeenCalledWith("danimoya/ptd", 12, "ghs-test", { state: "closed", state_reason: "completed" });
  });

  it("ignores a card whose key belongs to another source", async () => {
    const outcome = await notify(event("task.completed", { task: task({ externalKey: "JIRA-1234" }) }));
    expect(outcome).toMatchObject({ acted: false, reason: "external_key_not_github" });
    expect(stubs.patchIssue).not.toHaveBeenCalled();
  });

  it("ignores a card whose repository is no longer mapped", async () => {
    const outcome = await notify(event("task.completed", { task: task({ externalKey: "gh:someone/else#1" }) }));
    expect(outcome).toMatchObject({ acted: false, reason: "repo_not_mapped_outbound" });
    expect(stubs.patchIssue).not.toHaveBeenCalled();
  });
});

describe("task.updated", () => {
  it("edits the issue when the title or the description changed", async () => {
    await notify(
      event("task.updated", {
        task: task({ externalKey: "gh:danimoya/ptd#12", title: "Ship it" }),
        changes: { title: { old: "Ship the GitHub adapter", new: "Ship it" } },
      }),
    );
    expect(stubs.patchIssue).toHaveBeenCalledWith("danimoya/ptd", 12, "ghs-test", { title: "Ship it" });

    stubs.patchIssue.mockClear();
    await notify(
      event("task.updated", {
        task: task({ externalKey: "gh:danimoya/ptd#12", description: "New body" }),
        changes: { description: { old: "old", new: "New body" } },
      }),
    );
    expect(stubs.patchIssue).toHaveBeenCalledWith("danimoya/ptd", 12, "ghs-test", { body: "New body" });
  });

  it("leaves the issue alone when only PTD-side fields moved", async () => {
    const outcome = await notify(
      event("task.updated", {
        task: task({ externalKey: "gh:danimoya/ptd#12" }),
        changes: { priorityScore: { old: 10, new: 63 }, startDate: { old: null, new: "2026-10-01" } },
      }),
    );
    expect(outcome).toMatchObject({ acted: false, reason: "no_mirrored_field_changed" });
    expect(stubs.patchIssue).not.toHaveBeenCalled();
  });
});

describe("safety", () => {
  it("ignores every other event kind", async () => {
    for (const kind of ["task.assigned", "task.cascade_shifted", "task.deleted", "stream.created"]) {
      expect((await notify(event(kind, { task: task() }))).reason, kind).toBe("irrelevant_kind");
    }
  });

  it("does nothing for an organization with no installation", async () => {
    stubs.getGithubForOrg.mockResolvedValue(null);
    expect(await notify(event("task.created", { task: task() }))).toMatchObject({ acted: false, reason: "not_connected" });
  });

  it("swallows a thrown store error rather than failing the mutation that triggered it", async () => {
    stubs.getGithubForOrg.mockRejectedValue(new Error("db gone"));
    await expect(notify(event("task.created", { task: task() }))).resolves.toEqual({ acted: false, reason: "error" });
  });
});
