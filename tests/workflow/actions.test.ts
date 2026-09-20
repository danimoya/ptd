import { describe, expect, it, vi } from "vitest";

/**
 * The workflow-depth action surface: the contract a client, an agent over MCP and
 * a chat bot all read. Names and roles are asserted here because they ARE the
 * API — renaming `task.comment_add` or relaxing `field.create` to member is a
 * breaking change that should fail a test, not a review.
 */
vi.mock("../../db", () => ({ db: {} }));

await import("../../server/actions/plan");
await import("../../server/actions/workflow");

const { allActions, getAction } = await import("../../server/actions/registry");
const { verbByName, VERBS } = await import("../../server/integrations/shared/verbs");
import type { ActionContext } from "../../server/actions/registry";

const EXPECTED: [string, "member" | "manager"][ ] = [
  ["task.comment_add", "member"],
  ["task.comment_list", "member"],
  ["task.comment_delete", "member"],
  ["task.attachment_list", "member"],
  ["task.attachment_delete", "member"],
  ["task.recur_set", "manager"],
  ["task.recur_list", "member"],
  ["field.create", "manager"],
  ["field.update", "manager"],
  ["field.list", "member"],
  ["field.archive", "manager"],
  ["task.set_custom", "member"],
  ["task.custom_values", "member"],
];

describe("the workflow actions", () => {
  it("are all registered on the plan surface with the documented role", () => {
    for (const [name, role] of EXPECTED) {
      const def = getAction(name);
      expect(def, name).toBeDefined();
      expect(def!.requiredRole, name).toBe(role);
      expect(def!.surface, name).toBe("plan");
      expect(def!.description.length, name).toBeGreaterThan(40);
    }
  });

  it("say in their description where the rule is finer than the role", () => {
    // Every action whose gate is narrower than its requiredRole has to explain
    // itself, or a caller's only way to learn the rule is a 403.
    expect(getAction("task.comment_delete")!.description).toMatch(/author/i);
    expect(getAction("task.attachment_delete")!.description).toMatch(/uploader/i);
    expect(getAction("task.set_custom")!.description).toMatch(/assigned to them/i);
  });

  it("validate their input before the handler can run", async () => {
    const def = getAction("task.comment_add")!;
    expect(def.input.safeParse({ taskId: 1, body: "" }).success).toBe(false);
    expect(def.input.safeParse({ taskId: 0, body: "x" }).success).toBe(false);
    expect(def.input.safeParse({ taskId: 1, body: "x".repeat(10_001) }).success).toBe(false);
    expect(def.input.safeParse({ taskId: 1, body: "ok" }).success).toBe(true);
    // A recurrence is set or cleared, never left undefined.
    const recur = getAction("task.recur_set")!;
    expect(recur.input.safeParse({ taskId: 1 }).success).toBe(false);
    expect(recur.input.safeParse({ taskId: 1, rule: null }).success).toBe(true);
    expect(recur.input.safeParse({ taskId: 1, rule: "daily" }).success).toBe(true);
    // A field kind outside the schema's list never reaches the database.
    const field = getAction("field.create")!;
    expect(field.input.safeParse({ name: "X", kind: "colour" }).success).toBe(false);
    expect(field.input.safeParse({ name: "X", kind: "select", options: ["a"] }).success).toBe(true);
  });

  it("do not collide with the actions plan.ts already owns", () => {
    const names = allActions().map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the /ptd comment verb", () => {
  const ctx = { userId: 1, email: "a@b.c", displayName: "A", orgId: 1, role: "member", authType: "human", via: "slack" } as ActionContext;
  const input = (args: string[]) => ({
    ctx,
    args,
    rest: args.join(" "),
    prefix: "/ptd ",
    deps: { resolveTask: async () => ({ id: 12, title: "T", externalKey: "PTD-12" }), now: () => 0 },
    who: { account: "a", scope: null },
  });

  it("is one entry in the shared table, so all three chat surfaces get it at once", () => {
    const verb = verbByName("comment");
    expect(verb).toBeDefined();
    expect(verb!.action).toBe("task.comment_add");
    expect(VERBS.filter((v) => v.name === "comment")).toHaveLength(1);
  });

  it("maps `comment <KEY> text` onto the action's input", async () => {
    const verb = verbByName("comment")!;
    expect(await verb.build(input(["PTD-12", "waiting", "on", "the", "vendor"]))).toEqual({ taskId: 12, body: "waiting on the vendor" });
    // The registry's own schema has to accept what the verb builds.
    expect(getAction("task.comment_add")!.input.safeParse({ taskId: 12, body: "waiting on the vendor" }).success).toBe(true);
  });

  it("refuses an empty comment and names the usage", async () => {
    const verb = verbByName("comment")!;
    await expect(verb.build(input(["PTD-12"]))).rejects.toThrow(/\/ptd comment/);
    await expect(verb.build(input([]))).rejects.toThrow(/\/ptd comment/);
  });

  it("renders an ephemeral confirmation with the comment quoted and escaped", () => {
    const verb = verbByName("comment")!;
    const reply = verb.render({ comment: { id: 1, body: "watch <the> vendor & the cert" } }, input(["PTD-12", "x"]));
    expect(reply.response_type).toBe("ephemeral");
    expect(reply.text).toContain("Comment added");
    expect(JSON.stringify(reply.blocks)).toContain("&lt;the&gt;");
    expect(JSON.stringify(reply.blocks)).toContain("&amp;");
  });
});
