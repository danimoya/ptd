import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";

vi.mock("../../db", () => ({ db: fakeDb }));

const { assertWithinPlan, planLimitState, FREE_LIMIT_MESSAGE } = await import("../../server/billing/limits");
const { ActionError } = await import("../../server/actions/registry");

const ORG_ID = 11;
const HOSTED = { PTD_HOSTED: "1" } as unknown as NodeJS.ProcessEnv;
const SELF = {} as NodeJS.ProcessEnv;

function seats(n: number, agents = 0) {
  fakeDb.setMembers(Array.from({ length: n }, (_, i) => ({ userId: i + 1, isAgent: i >= n - agents })));
}

beforeEach(() => {
  fakeDb.reset().setOrg({ id: ORG_ID, plan: "free" });
});

describe("assertWithinPlan on a hosted deployment", () => {
  it("allows the 2nd and 3rd seat on free", async () => {
    seats(1);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).resolves.toBeUndefined();
    seats(2);
    await expect(assertWithinPlan(ORG_ID, "agent", HOSTED)).resolves.toBeUndefined();
  });

  it("blocks the 4th seat with the upgrade message", async () => {
    seats(3);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).rejects.toThrow(ActionError);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).rejects.toThrow("Free hosted organizations are limited to 3 members — upgrade for $15/month");
    expect(FREE_LIMIT_MESSAGE).toContain("$15/month");
  });

  it("counts an agent seat exactly like a human one", async () => {
    seats(3, 2); // 1 human + 2 agents
    await expect(assertWithinPlan(ORG_ID, "agent", HOSTED)).rejects.toThrow(/limited to 3 members/);
  });

  it("carries the forbidden code, so the HTTP face answers 403", async () => {
    seats(3);
    await assertWithinPlan(ORG_ID, "member", HOSTED).catch((err) => {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as InstanceType<typeof ActionError>).code).toBe("forbidden");
    });
  });

  it("does not limit a paid hosted org", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "hosted", stripeSubscriptionId: "sub_1" });
    seats(40);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).resolves.toBeUndefined();
  });

  it("does not limit a self_hosted org even on the hosted instance", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "self_hosted" });
    seats(9);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).resolves.toBeUndefined();
  });

  it("stays quiet when the org row has vanished", async () => {
    fakeDb.queueEmpty("organizations");
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).resolves.toBeUndefined();
  });
});

describe("assertWithinPlan on a self-hosted deployment", () => {
  it("never limits anything and never reads the database", async () => {
    seats(500);
    fakeDb.selects = [];
    await expect(assertWithinPlan(ORG_ID, "member", SELF)).resolves.toBeUndefined();
    expect(fakeDb.selects).toHaveLength(0);
  });
});

describe("planLimitState", () => {
  it("reports the free ceiling and the seats used", async () => {
    seats(2);
    expect(await planLimitState(ORG_ID, HOSTED)).toEqual({ enforced: true, plan: "free", limit: 3, used: 2 });
  });

  it("reports no ceiling for a paid org and for self-hosting", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "hosted" });
    expect(await planLimitState(ORG_ID, HOSTED)).toMatchObject({ enforced: false, limit: null });
    expect(await planLimitState(ORG_ID, SELF)).toMatchObject({ enforced: false, limit: null });
  });
});
