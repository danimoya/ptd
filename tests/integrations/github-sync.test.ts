import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "../../server/actions/registry";
import type { GithubMapping, GithubRow } from "../../server/integrations/github/store";

/**
 * Issue → task, with the registry stubbed.
 *
 * What is asserted is the mapping itself — which action is called with which arguments
 * — and above all that it is idempotent: the second delivery of the same issue must not
 * change anything. That is the property the whole adapter leans on (it is why the
 * webhook needs no replay window), so it is tested directly rather than inferred.
 */

vi.mock("../../db", () => ({ db: {} }));

const stubs = vi.hoisted(() => ({
  installationToken: vi.fn(async () => ({ ok: true as const, token: "ghs-test", expiresAt: Date.now() + 3_600_000 })),
  listOpenIssues: vi.fn(),
  userEmail: vi.fn(async () => null as string | null),
  memberByEmail: vi.fn(async () => null as { userId: number; displayName: string } | null),
}));

vi.mock("../../server/integrations/github/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/integrations/github/api")>();
  return {
    ...actual,
    installationToken: stubs.installationToken,
    listOpenIssues: stubs.listOpenIssues,
    userEmail: stubs.userEmail,
  };
});

vi.mock("../../server/integrations/shared/identity", () => ({ memberByEmail: stubs.memberByEmail }));

const { assigneeResolver, descriptionFrom, dueDateFrom, externalKeyFor, importOpenIssues, parseExternalKey, upsertIssueTask } =
  await import("../../server/integrations/github/sync");
const { readIssue } = await import("../../server/integrations/github/api");

const ctx: ActionContext = {
  userId: 7,
  email: "dani@example.com",
  displayName: "Dani",
  orgId: 3,
  role: "admin",
  authType: "human",
  via: "github",
};

const mapping: GithubMapping = {
  streamId: 5,
  repo: "danimoya/ptd",
  direction: "both",
  mappedBy: 7,
  mappedAt: "2026-09-01T00:00:00.000Z",
};

const issue = (overrides: Record<string, unknown> = {}) =>
  readIssue({
    number: 12,
    title: "Ship the GitHub adapter",
    body: "Two directions, one externalKey.",
    state: "open",
    html_url: "https://github.com/danimoya/ptd/issues/12",
    labels: [{ name: "adapter" }, { name: "priority:high" }],
    assignee: null,
    milestone: null,
    user: { login: "danimoya" },
    ...overrides,
  })!;

/** A runAction stub that behaves like the real find_or_create / update pair. */
function registry(options: { existing?: { id: number; completed: boolean } } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let card = options.existing ? { ...options.existing, fields: {} as Record<string, unknown> } : null;
  const runAction = vi.fn(async (name: string, args: unknown) => {
    const input = args as Record<string, unknown>;
    calls.push({ name, args: input });
    if (name === "task.find_or_create") {
      if (!card) {
        card = { id: 42, completed: false, fields: { title: input.title, streamId: input.streamId } };
        return { task: { id: 42, completed: false, streamId: input.streamId }, created: true };
      }
      return { task: { id: card.id, completed: card.completed, streamId: mapping.streamId }, created: false };
    }
    if (name === "task.update") {
      const before = JSON.stringify(card!.fields);
      const { taskId, ...fields } = input;
      card!.fields = { ...card!.fields, ...fields };
      if (fields.completed === false) card!.completed = false;
      return { changed: before !== JSON.stringify(card!.fields) };
    }
    if (name === "task.complete") {
      const changed = !card!.completed;
      card!.completed = true;
      return { changed };
    }
    throw new Error(`unexpected action ${name}`);
  });
  return { runAction, calls, card: () => card };
}

const deps = (runAction: ReturnType<typeof registry>["runAction"]) => ({
  runAction: runAction as never,
  resolveAssignee: async () => null,
});

beforeEach(() => {
  vi.clearAllMocks();
  stubs.installationToken.mockResolvedValue({ ok: true as const, token: "ghs-test", expiresAt: Date.now() + 3_600_000 });
  stubs.userEmail.mockResolvedValue(null);
  stubs.memberByEmail.mockResolvedValue(null);
});

describe("externalKey", () => {
  it("round-trips repo and issue number, lower-cased", () => {
    expect(externalKeyFor("DaniMoya/PTD", 12)).toBe("gh:danimoya/ptd#12");
    expect(parseExternalKey("gh:danimoya/ptd#12")).toEqual({ repo: "danimoya/ptd", number: 12 });
  });

  it("refuses a key from another source, so the outbound side never edits the wrong thing", () => {
    for (const bad of ["", "PTD-12", "jira:ABC-1", "gh:danimoya/ptd", "gh:ptd#12", "gh:danimoya/ptd#abc", null, undefined]) {
      expect(parseExternalKey(bad as string), String(bad)).toBeNull();
    }
  });
});

describe("field mapping", () => {
  it("keeps a body as the description and truncates an enormous one", () => {
    expect(descriptionFrom(issue())).toBe("Two directions, one externalKey.");
    expect(descriptionFrom(issue({ body: "   " }))).toBeNull();
    expect(descriptionFrom(issue({ body: null }))).toBeNull();
    const long = descriptionFrom(issue({ body: "x".repeat(20_000) }))!;
    expect(long.length).toBeLessThan(20_000);
    expect(long).toContain("truncated");
  });

  it("takes the milestone's due date and ignores a milestone without one", () => {
    expect(dueDateFrom(issue({ milestone: { due_on: "2026-10-01T07:00:00Z" } }))).toBe("2026-10-01T07:00:00.000Z");
    expect(dueDateFrom(issue({ milestone: { due_on: null } }))).toBeNull();
    expect(dueDateFrom(issue({ milestone: { due_on: "not a date" } }))).toBeNull();
    expect(dueDateFrom(issue())).toBeNull();
  });

  it("drops a pull request: GitHub models one as an issue, PTD does not track them", () => {
    expect(readIssue({ number: 3, title: "A PR", pull_request: { url: "x" } })).toBeNull();
  });
});

describe("upsertIssueTask", () => {
  it("creates a card keyed on the issue, with labels as tags and the mapped stream", async () => {
    const reg = registry();
    const result = await upsertIssueTask(ctx, mapping, issue(), deps(reg.runAction));

    expect(result).toMatchObject({ taskId: 42, externalKey: "gh:danimoya/ptd#12", created: true });
    expect(reg.calls[0]).toEqual({
      name: "task.find_or_create",
      args: { title: "Ship the GitHub adapter", externalKey: "gh:danimoya/ptd#12", streamId: 5 },
    });
    expect(reg.calls[1].name).toBe("task.update");
    expect(reg.calls[1].args).toMatchObject({
      taskId: 42,
      title: "Ship the GitHub adapter",
      description: "Two directions, one externalKey.",
      tags: ["adapter", "priority:high"],
      dueDate: null,
      streamId: 5,
    });
  });

  it("is idempotent: the same issue twice creates once and changes nothing the second time", async () => {
    const reg = registry();
    const first = await upsertIssueTask(ctx, mapping, issue(), deps(reg.runAction));
    const second = await upsertIssueTask(ctx, mapping, issue(), deps(reg.runAction));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.changed).toBe(false);
    expect(reg.calls.filter((c) => c.name === "task.find_or_create")).toHaveLength(2);
    expect(reg.calls.filter((c) => c.name === "task.complete")).toHaveLength(0);
  });

  it("completes the card when the issue is closed, and only once", async () => {
    const reg = registry();
    const closed = await upsertIssueTask(ctx, mapping, issue({ state: "closed" }), deps(reg.runAction));
    expect(closed.completed).toBe(true);
    expect(reg.calls.some((c) => c.name === "task.complete")).toBe(true);

    const again = await upsertIssueTask(ctx, mapping, issue({ state: "closed" }), deps(reg.runAction));
    expect(again.completed).toBe(false);
  });

  it("sends a reopened issue's card back to the backlog", async () => {
    const reg = registry({ existing: { id: 42, completed: true } });
    const result = await upsertIssueTask(ctx, mapping, issue({ state: "open" }), deps(reg.runAction));
    expect(result.reopened).toBe(true);
    const update = reg.calls.find((c) => c.name === "task.update")!;
    expect(update.args).toMatchObject({ completed: false, status: "backlog" });
    expect(reg.calls.some((c) => c.name === "task.complete")).toBe(false);
  });

  it("assigns the card when the GitHub profile's email matches a member, and otherwise leaves it alone", async () => {
    const reg = registry();
    const matched = await upsertIssueTask(ctx, mapping, issue({ assignee: { login: "danimoya" } }), {
      runAction: reg.runAction as never,
      resolveAssignee: async () => 9,
    });
    expect(matched.assignedTo).toBe(9);
    expect(reg.calls.find((c) => c.name === "task.update")!.args).toMatchObject({ assignedTo: 9 });

    const reg2 = registry();
    await upsertIssueTask(ctx, mapping, issue({ assignee: { login: "stranger" } }), {
      runAction: reg2.runAction as never,
      resolveAssignee: async () => null,
    });
    // Never send assignedTo at all rather than clearing a PTD-side assignment.
    expect(reg2.calls.find((c) => c.name === "task.update")!.args).not.toHaveProperty("assignedTo");
  });

  it("mirrors an unlabelled issue as an empty tag list, so removing a label removes the tag", async () => {
    const reg = registry();
    await upsertIssueTask(ctx, mapping, issue({ labels: [] }), deps(reg.runAction));
    expect(reg.calls.find((c) => c.name === "task.update")!.args).toMatchObject({ tags: [] });
  });
});

describe("assigneeResolver", () => {
  it("matches by public email and caches the answer for the run", async () => {
    stubs.userEmail.mockResolvedValue("dani@example.com");
    stubs.memberByEmail.mockResolvedValue({ userId: 9, displayName: "Dani" });
    const resolve = assigneeResolver("ghs-test");

    expect(await resolve(3, "danimoya")).toBe(9);
    expect(await resolve(3, "DaniMoya")).toBe(9);
    expect(stubs.userEmail).toHaveBeenCalledTimes(1);
  });

  it("leaves the card unassigned when the profile has no email, or no member matches", async () => {
    stubs.userEmail.mockResolvedValue(null);
    expect(await assigneeResolver("t")(3, "ghost")).toBeNull();

    stubs.userEmail.mockResolvedValue("nobody@example.com");
    stubs.memberByEmail.mockResolvedValue(null);
    expect(await assigneeResolver("t")(3, "stranger")).toBeNull();
  });

  it("never throws out of a GitHub outage", async () => {
    stubs.userEmail.mockRejectedValue(new Error("502"));
    await expect(assigneeResolver("t")(3, "danimoya")).resolves.toBeNull();
  });
});

describe("importOpenIssues", () => {
  const row: GithubRow = {
    id: 1,
    orgId: 3,
    enabled: true,
    createdBy: 7,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    config: { installationId: 555, account: { login: "danimoya", type: "User", id: 1 }, mappings: [mapping] },
  };

  it("upserts every open issue and counts what it did", async () => {
    stubs.listOpenIssues.mockResolvedValue({ ok: true, issues: [issue(), issue({ number: 13, title: "Second" })] });
    const reg = registry();
    const summary = await importOpenIssues(ctx, row, mapping, deps(reg.runAction));
    expect(summary).toMatchObject({ repo: "danimoya/ptd", issues: 2, created: 1, errors: [] });
    expect(reg.calls.filter((c) => c.name === "task.find_or_create")).toHaveLength(2);
  });

  it("reports a token failure instead of throwing", async () => {
    stubs.installationToken.mockResolvedValue({ ok: false as const, error: "bad_key" });
    const reg = registry();
    const summary = await importOpenIssues(ctx, row, mapping, deps(reg.runAction));
    expect(summary.errors[0]).toContain("bad_key");
    expect(reg.runAction).not.toHaveBeenCalled();
  });

  it("keeps going when one issue fails and names the one that did", async () => {
    stubs.listOpenIssues.mockResolvedValue({ ok: true, issues: [issue(), issue({ number: 99 })] });
    const reg = registry();
    reg.runAction.mockImplementationOnce(async () => {
      throw new Error("stream vanished");
    });
    const summary = await importOpenIssues(ctx, row, mapping, deps(reg.runAction));
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("#12");
    expect(summary.issues).toBe(2);
  });
});
