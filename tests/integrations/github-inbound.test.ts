import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One webhook delivery → one registry write, with the store, the identity layer and the
 * history writer stubbed. What is asserted is the routing: which deliveries are acted
 * on, which are dropped and why — including the two loop guards and the role gate.
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
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    config: { installationId: 555, account: { login: "danimoya", type: "User", id: 1 }, mappings: [mapping], installedBy: 7 },
  };
  return {
    mapping,
    row,
    findMappingForRepo: vi.fn(async () => ({ row, mapping })),
    patchGithubConfig: vi.fn(async () => row),
    patchMapping: vi.fn(async () => row),
    githubRowsForInstallation: vi.fn(async () => [row]),
    serverContextFor: vi.fn(async () => ({
      userId: 7,
      email: "dani@example.com",
      displayName: "Dani",
      orgId: 3,
      role: "admin" as const,
      authType: "human" as const,
      via: "github" as const,
    })),
    taskByExternalKey: vi.fn(async () => ({ id: 42, title: "Ship the GitHub adapter", externalKey: "gh:danimoya/ptd#12" })),
    recordEvent: vi.fn(async () => undefined),
    installationToken: vi.fn(async () => ({ ok: true as const, token: "ghs-test", expiresAt: Date.now() + 3_600_000 })),
    runAction: vi.fn(async (name: string) => {
      if (name === "task.find_or_create") return { task: { id: 42, completed: false }, created: true };
      if (name === "task.update") return { changed: true };
      return { changed: true };
    }),
  };
});

vi.mock("../../server/integrations/github/store", () => ({
  findMappingForRepo: stubs.findMappingForRepo,
  patchGithubConfig: stubs.patchGithubConfig,
  patchMapping: stubs.patchMapping,
  githubRowsForInstallation: stubs.githubRowsForInstallation,
}));

vi.mock("../../server/integrations/shared/identity", () => ({
  serverContextFor: stubs.serverContextFor,
  taskByExternalKey: stubs.taskByExternalKey,
  memberByEmail: vi.fn(async () => null),
}));

vi.mock("../../server/plan/taskEvents", () => ({ recordEvent: stubs.recordEvent }));

vi.mock("../../server/integrations/github/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/github/api")>();
  return { ...actual, installationToken: stubs.installationToken };
});

const { handleGithubDelivery, isOwnBot } = await import("../../server/integrations/github/inbound");

const issueBody = (action: string, overrides: Record<string, unknown> = {}) => ({
  action,
  issue: {
    number: 12,
    title: "Ship the GitHub adapter",
    body: "Two directions, one externalKey.",
    state: action === "closed" ? "closed" : "open",
    html_url: "https://github.com/danimoya/ptd/issues/12",
    labels: [{ name: "adapter" }],
    user: { login: "danimoya" },
  },
  repository: { full_name: "danimoya/ptd" },
  installation: { id: 555 },
  sender: { login: "danimoya", type: "User" },
  ...overrides,
});

const deliver = (event: string, body: Record<string, unknown>) =>
  handleGithubDelivery({ event, deliveryId: "d-1", body }, { runAction: stubs.runAction as never, resolveAssignee: async () => null });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_APP_SLUG = "ptd-sync";
  stubs.mapping.direction = "both";
  stubs.findMappingForRepo.mockResolvedValue({ row: stubs.row, mapping: stubs.mapping });
  stubs.serverContextFor.mockResolvedValue({
    userId: 7,
    email: "dani@example.com",
    displayName: "Dani",
    orgId: 3,
    role: "admin",
    authType: "human",
    via: "github",
  });
  stubs.runAction.mockImplementation(async (name: string) => {
    if (name === "task.find_or_create") return { task: { id: 42, completed: false }, created: true };
    return { changed: true };
  });
});

describe("issues deliveries", () => {
  it("upserts the mapped card, as the member who mapped the repository, with via github", async () => {
    const outcome = await deliver("issues", issueBody("opened"));
    expect(outcome).toMatchObject({ handled: true, orgId: 3, repo: "danimoya/ptd", taskId: 42, created: true });
    expect(stubs.serverContextFor).toHaveBeenCalledWith(3, 7, "github", "manager");
    expect(stubs.runAction).toHaveBeenCalledWith(
      "task.find_or_create",
      expect.objectContaining({ externalKey: "gh:danimoya/ptd#12", streamId: 5 }),
      expect.objectContaining({ via: "github" }),
    );
  });

  it("handles every action the App subscribes to, and ignores the rest", async () => {
    for (const action of ["opened", "edited", "closed", "reopened", "labeled", "unlabeled", "assigned"]) {
      stubs.runAction.mockClear();
      const outcome = await deliver("issues", issueBody(action));
      expect(outcome.handled, action).toBe(true);
    }
    const ignored = await deliver("issues", issueBody("pinned"));
    expect(ignored).toMatchObject({ handled: false, reason: "issues_pinned_ignored" });
  });

  it("stamps the last event and clears the last error on success", async () => {
    await deliver("issues", issueBody("edited"));
    expect(stubs.patchGithubConfig).toHaveBeenCalledWith(3, expect.objectContaining({ lastError: null }));
    expect(stubs.patchMapping).toHaveBeenCalledWith(3, 5, expect.objectContaining({ lastError: null }));
  });

  it("records the failure on the mapping instead of throwing", async () => {
    stubs.runAction.mockRejectedValueOnce(new Error("stream vanished"));
    const outcome = await deliver("issues", issueBody("opened"));
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toContain("stream vanished");
    expect(stubs.patchMapping).toHaveBeenCalledWith(3, 5, expect.objectContaining({ lastError: "stream vanished" }));
  });
});

describe("loop guards and gates", () => {
  it("drops a delivery sent by the App's own bot", async () => {
    expect(isOwnBot("ptd-sync[bot]")).toBe(true);
    expect(isOwnBot("PTD-Sync[bot]")).toBe(true);
    expect(isOwnBot("danimoya")).toBe(false);
    expect(isOwnBot(null)).toBe(false);

    const outcome = await deliver("issues", issueBody("opened", { sender: { login: "ptd-sync[bot]", type: "Bot" } }));
    expect(outcome).toEqual({ handled: false, reason: "own_bot", action: "opened" });
    expect(stubs.runAction).not.toHaveBeenCalled();
  });

  it("refuses to import into a stream mapped as out-only", async () => {
    stubs.mapping.direction = "out";
    const outcome = await deliver("issues", issueBody("opened"));
    expect(outcome).toMatchObject({ handled: false, reason: "direction_out_only" });
    expect(stubs.runAction).not.toHaveBeenCalled();
  });

  it("ignores a repository nobody mapped", async () => {
    stubs.findMappingForRepo.mockResolvedValue(null as never);
    const outcome = await deliver("issues", issueBody("opened", { repository: { full_name: "someone/else" } }));
    expect(outcome).toMatchObject({ handled: false, reason: "repo_not_mapped" });
    expect(stubs.runAction).not.toHaveBeenCalled();
  });

  it("writes nothing when no member of the org can reach manager — the role gate holds for integrations too", async () => {
    stubs.serverContextFor.mockResolvedValue(null as never);
    const outcome = await deliver("issues", issueBody("opened"));
    expect(outcome).toMatchObject({ handled: false, reason: "no_acting_member" });
    expect(stubs.runAction).not.toHaveBeenCalled();
    expect(stubs.patchMapping).toHaveBeenCalledWith(3, 5, { lastError: "no_member_with_manager_role" });
  });

  it("answers a ping and ignores an event it does not subscribe to", async () => {
    expect(await deliver("ping", { zen: "Keep it logically awesome." })).toMatchObject({ handled: true, reason: "ping" });
    expect(await deliver("push", issueBody("whatever"))).toMatchObject({ handled: false, reason: "event_push_ignored" });
  });
});

describe("issue_comment deliveries", () => {
  it("writes the comment as one history row, not a card edit", async () => {
    const outcome = await deliver("issue_comment", {
      ...issueBody("created"),
      comment: { body: "Shipping this today.\n\nWith a blank line.", user: { login: "priya" } },
    });
    expect(outcome).toMatchObject({ handled: true, taskId: 42 });
    expect(stubs.runAction).not.toHaveBeenCalled();
    expect(stubs.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 42,
        orgId: 3,
        kind: "updated",
        note: "GitHub comment by @priya: Shipping this today. With a blank line.",
        actor: expect.objectContaining({ via: "github" }),
      }),
    );
  });

  it("truncates a novel", async () => {
    await deliver("issue_comment", { ...issueBody("created"), comment: { body: "x".repeat(5_000), user: { login: "priya" } } });
    const note = (stubs.recordEvent.mock.calls[0][0] as { note: string }).note;
    expect(note.length).toBeLessThan(1_100);
    expect(note.endsWith("…")).toBe(true);
  });

  it("says nothing when the issue has no card yet", async () => {
    stubs.taskByExternalKey.mockResolvedValue(null as never);
    const outcome = await deliver("issue_comment", { ...issueBody("created"), comment: { body: "hi", user: { login: "priya" } } });
    expect(outcome).toMatchObject({ handled: false, reason: "no_task_for_issue" });
    expect(stubs.recordEvent).not.toHaveBeenCalled();
  });

  it("ignores an edited or deleted comment", async () => {
    const outcome = await deliver("issue_comment", { ...issueBody("edited"), comment: { body: "hi", user: { login: "priya" } } });
    expect(outcome).toMatchObject({ handled: false, reason: "issue_comment_edited_ignored" });
  });
});

describe("installation deliveries", () => {
  it("records that the App was uninstalled, and keeps the mappings", async () => {
    const outcome = await handleGithubDelivery({
      event: "installation",
      deliveryId: "d-2",
      body: { action: "deleted", installation: { id: 555 }, sender: { login: "danimoya" } },
    });
    expect(outcome).toMatchObject({ handled: true, reason: "installation_deleted" });
    expect(stubs.patchGithubConfig).toHaveBeenCalledWith(3, { lastError: "installation_deleted" });
  });
});
