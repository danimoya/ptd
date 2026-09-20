import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ActionError, defineAction, runAction, setActionAuditHook, type ActionContext } from "../../server/actions/registry";

/**
 * The registry's audit hook. Deliberately tested against the registry alone —
 * the module under test imports no database, and neither does this file, which is
 * the property that keeps `defineAction` usable from docs and manifest code.
 */
const ctx: ActionContext = {
  userId: 1,
  email: "a@b.test",
  displayName: "A B",
  orgId: 3,
  role: "owner",
  authType: "human",
  via: "web",
};

let counter = 0;
const unique = (name: string) => `${name}.${++counter}`;

afterEach(() => setActionAuditHook(null));

describe("audited actions", () => {
  it("fire the hook with the definition, the parsed args and the context", async () => {
    const seen: unknown[] = [];
    setActionAuditHook((event) => seen.push(event));
    const name = unique("test.audited");
    defineAction({
      name,
      title: "t",
      description: "d",
      input: z.object({ id: z.number(), extra: z.string().optional() }),
      requiredRole: "member",
      surface: "org",
      audited: true,
      handler: async (args) => ({ ok: args.id }),
    });

    await runAction(name, { id: 42 }, ctx);
    expect(seen).toHaveLength(1);
    const event = seen[0] as { def: { name: string }; args: unknown; result: unknown; ctx: ActionContext };
    expect(event.def.name).toBe(name);
    expect(event.args).toEqual({ id: 42 });
    expect(event.result).toEqual({ ok: 42 });
    expect(event.ctx.orgId).toBe(3);
  });

  it("do not fire when the action is not marked", async () => {
    const seen: unknown[] = [];
    setActionAuditHook((event) => seen.push(event));
    const name = unique("test.plain");
    defineAction({ name, title: "t", description: "d", input: z.object({}), requiredRole: "member", surface: "org", handler: async () => 1 });
    await runAction(name, {}, ctx);
    expect(seen).toHaveLength(0);
  });

  it("do not fire when the handler throws — nothing happened, so nothing is recorded", async () => {
    const seen: unknown[] = [];
    setActionAuditHook((event) => seen.push(event));
    const name = unique("test.throws");
    defineAction({
      name,
      title: "t",
      description: "d",
      input: z.object({}),
      requiredRole: "member",
      surface: "org",
      audited: true,
      handler: async () => {
        throw new ActionError("conflict", "no");
      },
    });
    await expect(runAction(name, {}, ctx)).rejects.toBeInstanceOf(ActionError);
    expect(seen).toHaveLength(0);
  });

  it("do not fire when the role gate or the schema refuses", async () => {
    const seen: unknown[] = [];
    setActionAuditHook((event) => seen.push(event));
    const name = unique("test.gated");
    defineAction({
      name,
      title: "t",
      description: "d",
      input: z.object({ id: z.number() }),
      requiredRole: "owner",
      surface: "org",
      audited: true,
      handler: async () => 1,
    });
    await expect(runAction(name, { id: 1 }, { ...ctx, role: "member" })).rejects.toThrow(/requires role owner/);
    await expect(runAction(name, { id: "not a number" }, ctx)).rejects.toThrow(/id/);
    expect(seen).toHaveLength(0);
  });

  it("cannot fail the action they describe", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setActionAuditHook(() => {
      throw new Error("the log is on fire");
    });
    const name = unique("test.hook-throws");
    defineAction({
      name,
      title: "t",
      description: "d",
      input: z.object({}),
      requiredRole: "member",
      surface: "org",
      audited: true,
      handler: async () => "fine",
    });
    await expect(runAction(name, {}, ctx)).resolves.toBe("fine");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
