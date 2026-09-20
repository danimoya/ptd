import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";

vi.mock("../../db", () => ({ db: fakeDb }));

const { assertWithinPlan, planLimitState, FREE_LIMIT_MESSAGE, TEAM_HUMAN_LIMIT_MESSAGE, capMessage } = await import("../../server/billing/limits");
const { ActionError } = await import("../../server/actions/registry");

const ORG_ID = 11;
const HOSTED = { PTD_HOSTED: "1", PTD_HOSTED_MAX_MEMBERS: "100" } as unknown as NodeJS.ProcessEnv;
const SELF = {} as NodeJS.ProcessEnv;

/** `humans` people and `agents` agent seats already in the organization. */
function seats(humans: number, agents = 0) {
  fakeDb.setMembers([
    ...Array.from({ length: humans }, (_, i) => ({ userId: i + 1, isAgent: false })),
    ...Array.from({ length: agents }, (_, i) => ({ userId: 1000 + i, isAgent: true })),
  ]);
}

beforeEach(() => {
  fakeDb.reset().setOrg({ id: ORG_ID, plan: "free" });
});

describe("free: three seats, humans and agents together", () => {
  it("allows the 2nd and 3rd seat", async () => {
    seats(1);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).resolves.toBeUndefined();
    seats(2);
    await expect(assertWithinPlan(ORG_ID, "agent", HOSTED)).resolves.toBeUndefined();
  });

  it("blocks the 4th seat, whichever kind it is, with the upgrade message", async () => {
    seats(3);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).rejects.toThrow(ActionError);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).rejects.toThrow(/limited to 3 members/);
    await expect(assertWithinPlan(ORG_ID, "agent", HOSTED)).rejects.toThrow(/limited to 3 members/);
    expect(FREE_LIMIT_MESSAGE).toMatch(/\$15\/month for up to 10 human seats/);
  });

  it("counts an agent seat exactly like a human one", async () => {
    seats(1, 2);
    await expect(assertWithinPlan(ORG_ID, "agent", HOSTED)).rejects.toThrow(/limited to 3 members/);
  });

  it("carries the forbidden code, so the HTTP face answers 403", async () => {
    seats(3);
    const err = await assertWithinPlan(ORG_ID, "member", HOSTED).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as InstanceType<typeof ActionError>).code).toBe("forbidden");
  });
});

describe("team: ten human seats, agents free", () => {
  beforeEach(() => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "team", stripeSubscriptionId: "sub_1" });
  });

  it("takes the 10th human and refuses the 11th", async () => {
    seats(9);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).resolves.toBeUndefined();
    seats(10);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).rejects.toThrow(/Team includes 10 human seats/);
    expect(TEAM_HUMAN_LIMIT_MESSAGE).toMatch(/Business is \$49\/month/);
  });

  it("lets agents past the human ceiling — they pay their own API bill", async () => {
    seats(10, 40);
    await expect(assertWithinPlan(ORG_ID, "agent", HOSTED)).resolves.toBeUndefined();
  });

  it("still stops at the hard member cap, agents included", async () => {
    seats(10, 90);
    await expect(assertWithinPlan(ORG_ID, "agent", HOSTED)).rejects.toThrow(/ceiling of 100 members/);
    expect(capMessage(100)).toMatch(/not a pricing limit/);
  });

  it("honours a deployment that sets its own cap", async () => {
    seats(4, 6);
    const smaller = { ...HOSTED, PTD_HOSTED_MAX_MEMBERS: "10" } as NodeJS.ProcessEnv;
    await expect(assertWithinPlan(ORG_ID, "agent", smaller)).rejects.toThrow(/ceiling of 10 members/);
  });
});

describe("business: humans past 50 are billed, not refused", () => {
  beforeEach(() => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "business", stripeSubscriptionId: "sub_2" });
  });

  it("takes the 51st human without a word", async () => {
    seats(50);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).resolves.toBeUndefined();
    seats(80);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).resolves.toBeUndefined();
  });

  it("refuses the 101st member — humans and agents together — and points at a conversation", async () => {
    seats(60, 40);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).rejects.toThrow(/ceiling of 100 members/);
    await expect(assertWithinPlan(ORG_ID, "agent", HOSTED)).rejects.toThrow(/ceiling of 100 members/);
  });
});

describe("what is never limited", () => {
  it("does not limit a self_hosted org even on the hosted instance", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "self_hosted" });
    seats(900);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).resolves.toBeUndefined();
  });

  it("stays quiet when the org row has vanished", async () => {
    fakeDb.queueEmpty("organizations");
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).resolves.toBeUndefined();
  });

  it("never limits anything on a self-hosted deployment, and never reads the database", async () => {
    seats(500);
    fakeDb.selects = [];
    await expect(assertWithinPlan(ORG_ID, "member", SELF)).resolves.toBeUndefined();
    expect(fakeDb.selects).toHaveLength(0);
  });

  it("reads a pricing-v1 `hosted` row as Team rather than as free", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "hosted", stripeSubscriptionId: "sub_legacy" });
    seats(6);
    await expect(assertWithinPlan(ORG_ID, "member", HOSTED)).resolves.toBeUndefined();
    expect(await planLimitState(ORG_ID, HOSTED)).toMatchObject({ plan: "team", humanSeats: 10 });
  });
});

describe("planLimitState", () => {
  it("reports both ceilings, the seat split and the narrowest bound", async () => {
    seats(2);
    expect(await planLimitState(ORG_ID, HOSTED)).toEqual({
      enforced: true,
      plan: "free",
      humanSeats: 3,
      totalMembers: 3,
      humans: 2,
      agents: 0,
      total: 2,
      seatOverage: 0,
      limit: 3,
      used: 2,
    });
  });

  it("counts the billable overage on Business", async () => {
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "business", stripeSubscriptionId: "sub_2" });
    seats(57, 3);
    expect(await planLimitState(ORG_ID, HOSTED)).toMatchObject({
      plan: "business",
      humanSeats: null,
      totalMembers: 100,
      humans: 57,
      agents: 3,
      total: 60,
      seatOverage: 7,
      // The only ceiling left on Business is the cap.
      limit: 100,
      used: 60,
    });
  });

  it("reports nothing enforced for self-hosting", async () => {
    expect(await planLimitState(ORG_ID, SELF)).toMatchObject({ enforced: false, limit: null });
    fakeDb.reset().setOrg({ id: ORG_ID, plan: "self_hosted" });
    expect(await planLimitState(ORG_ID, HOSTED)).toMatchObject({ enforced: false, limit: null });
  });
});
