import { beforeEach, describe, expect, it, vi } from "vitest";

// audit/log writes rows; the fake records them so the shape can be asserted.
vi.mock("../../db", async () => {
  const { FakeDb } = await import("../track/fake-db");
  return { db: new FakeDb() };
});

import { db } from "../../db";
import { auditEvents, memberships } from "../../db/schema";
import { audit, sanitiseMeta } from "../../server/audit/log";
import { withRequestFacts } from "../../server/audit/context";
import type { FakeDb } from "../track/fake-db";
import type { ActionContext } from "../../server/actions/registry";

const fake = db as unknown as FakeDb;
beforeEach(() => fake.reset());

const ctx: ActionContext = {
  userId: 7,
  email: "casey@owner.test",
  displayName: "Casey Owner",
  orgId: 2,
  role: "owner",
  authType: "human",
  via: "web",
};

const lastRow = () => fake.inserts.at(-1)?.values as Record<string, unknown>;

describe("sanitiseMeta", () => {
  it("redacts anything whose key reads like a credential", () => {
    expect(
      sanitiseMeta({
        name: "audit probe",
        token: "ptd_abcdef",
        secret: "s3cr3t",
        apiKey: "sk-live-1",
        passwordHash: "$2a$12$…",
        recoveryCode: "abcde-fghjk",
        totpSecret: "GEZDGNBVGY3TQOJQ",
      }),
    ).toEqual({
      name: "audit probe",
      token: "[redacted]",
      secret: "[redacted]",
      apiKey: "[redacted]",
      passwordHash: "[redacted]",
      recoveryCode: "[redacted]",
      totpSecret: "[redacted]",
    });
  });

  it("keeps counts and flags, which are the useful part of a credential event", () => {
    expect(sanitiseMeta({ recoveryCodes: 10, tokenRevoked: true })).toEqual({ recoveryCodes: 10, tokenRevoked: true });
  });

  it("redacts nested keys too, and stops descending at depth", () => {
    const meta = sanitiseMeta({ args: { code: "123456", requireTotp: true }, deep: { a: { b: { c: { d: 1 } } } } }) as Record<string, any>;
    expect(meta.args).toEqual({ code: "[redacted]", requireTotp: true });
    expect(JSON.stringify(meta.deep)).toContain("[…]");
  });

  it("clamps a long string and normalises the odd shapes", () => {
    const long = sanitiseMeta({ note: "x".repeat(900) }) as Record<string, string>;
    expect(long.note.length).toBe(501);
    expect(long.note.endsWith("…")).toBe(true);
    expect(sanitiseMeta(null)).toBeNull();
    expect(sanitiseMeta(undefined)).toBeNull();
    expect(sanitiseMeta("a string")).toEqual({ value: "a string" });
    expect(sanitiseMeta([1, 2])).toEqual({ value: [1, 2] });
  });
});

describe("audit()", () => {
  it("writes the actor, kind, target and sanitised meta", async () => {
    await audit(ctx, "token.minted", "7842c271", { name: "probe", secret: "nope" });
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0].table).toBe(auditEvents);
    expect(lastRow()).toMatchObject({
      orgId: 2,
      actorUserId: 7,
      actorLabel: "Casey Owner <casey@owner.test>",
      kind: "token.minted",
      target: "7842c271",
      meta: { name: "probe", secret: "[redacted]" },
    });
  });

  it("records the client IP from the request the call is running inside", async () => {
    await withRequestFacts({ ip: "203.0.113.9", userAgent: "curl", path: "/api/actions/x" }, () => audit(ctx, "auth.login"));
    expect(lastRow().ip).toBe("203.0.113.9");
  });

  it("takes the organization, actor and IP off an Express request", async () => {
    const req = {
      header: (name: string) => (name === "User-Agent" ? "Mozilla" : undefined),
      ip: "::ffff:198.51.100.7",
      socket: {},
      path: "/api/tokens",
      org: { id: 5, role: "admin" },
      user: [{ id: 9, email: "ada@admin.test", displayName: "Ada Admin" }],
    };
    await audit(req as never, "token.revoked", "abc12345");
    expect(lastRow()).toMatchObject({ orgId: 5, actorUserId: 9, actorLabel: "Ada Admin <ada@admin.test>", ip: "198.51.100.7" });
  });

  it("falls back to the actor's oldest membership when there is no org context", async () => {
    fake.queue(memberships, [{ orgId: 11 }]);
    await audit({ userId: 7, label: "Casey" }, "auth.login", "casey@owner.test");
    expect(lastRow().orgId).toBe(11);
  });

  it("respects an explicit null org — the row outlives the organization it describes", async () => {
    await audit({ orgId: null, userId: 7, label: "Casey" }, "org.deleted", "Hosted Grade Ltd (slug)");
    expect(lastRow().orgId).toBeNull();
    expect(fake.inserts).toHaveLength(1); // no membership lookup was needed
  });

  it("clamps the kind and the target to their columns", async () => {
    await audit(ctx, "k".repeat(80), "t".repeat(400));
    expect((lastRow().kind as string).length).toBe(48);
    expect((lastRow().target as string).length).toBe(120);
  });

  it("never rejects, whatever the database does", async () => {
    const boom = { insert: () => ({ values: () => Promise.reject(new Error("no database")) }) };
    vi.spyOn(fake, "insert").mockImplementationOnce(boom.insert as never);
    await expect(audit(ctx, "auth.login")).resolves.toBeUndefined();
  });
});
