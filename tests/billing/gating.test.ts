/**
 * The gating matrix: plan × feature, as the four call sites see it.
 *
 * `assertFeature` is what `org.set_security` and `audit.export` call;
 * `assertCertifiedInvoices` is what both invoice-issuing actions call;
 * `assertAiAllowed` is what every AI action calls. The point of testing them here
 * rather than only through the actions is that the refusal *message* is part of the
 * product: a gate that says "no" without saying what to buy is a wall.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";

vi.mock("../../db", () => ({ db: fakeDb }));

const { assertAiAllowed, assertCertifiedInvoices, assertFeature, gatedPlan, upgradeMessage } = await import("../../server/billing/gate");
const { ActionError } = await import("../../server/actions/registry");

const ORG_ID = 4;
const HOSTED = { PTD_HOSTED: "1", PTD_HOSTED_MAX_MEMBERS: "100" } as unknown as NodeJS.ProcessEnv;
const SELF = {} as NodeJS.ProcessEnv;

function org(plan: string, over: Record<string, unknown> = {}) {
  fakeDb.reset().setOrg({ id: ORG_ID, plan, stripeCustomerId: "cus_live", stripeSubscriptionId: "sub_live", ...over });
}

beforeEach(() => org("free"));

describe("gatedPlan", () => {
  it("is null — nothing to judge — when the deployment is self-hosted or the org is", async () => {
    expect(await gatedPlan(ORG_ID, SELF)).toBeNull();
    org("self_hosted");
    expect(await gatedPlan(ORG_ID, HOSTED)).toBeNull();
  });

  it("is the org's plan on the hosted instance, with v1's `hosted` read as team", async () => {
    org("team");
    expect(await gatedPlan(ORG_ID, HOSTED)).toBe("team");
    org("hosted");
    expect(await gatedPlan(ORG_ID, HOSTED)).toBe("team");
  });
});

describe("assertFeature — the security policy and the audit export are Business", () => {
  const cases: { plan: string; allowed: boolean }[] = [
    { plan: "free", allowed: false },
    { plan: "team", allowed: false },
    { plan: "business", allowed: true },
    { plan: "self_hosted", allowed: true },
  ];

  for (const feature of ["security_policy", "audit_export"] as const) {
    for (const { plan, allowed } of cases) {
      it(`${plan} ${allowed ? "may" : "may not"} use ${feature}`, async () => {
        org(plan);
        const run = assertFeature(ORG_ID, feature, "The thing", HOSTED);
        // A self-hosted organization is not judged at all, so the gate answers null.
        if (allowed) await expect(run).resolves.toBe(plan === "self_hosted" ? null : plan);
        else await expect(run).rejects.toThrow(ActionError);
      });
    }
  }

  it("names the plan to buy, and its price, in the refusal", async () => {
    org("team");
    const err = await assertFeature(ORG_ID, "audit_export", "Exporting the audit log as CSV", HOSTED).catch((e) => e);
    expect((err as Error).message).toBe(
      "Exporting the audit log as CSV is part of the Business plan ($49/month, or $490 a year). This organization is on Team — upgrade in Org → Billing.",
    );
    expect((err as InstanceType<typeof ActionError>).code).toBe("forbidden");
    expect(upgradeMessage("X", "free", "team")).toMatch(/Team plan \(\$15\/month, or \$150 a year\)/);
  });

  it("returns immediately on a self-hosted deployment, whatever the org row says", async () => {
    org("free");
    expect(await assertFeature(ORG_ID, "security_policy", "X", SELF)).toBeNull();
  });
});

describe("assertCertifiedInvoices", () => {
  it("refuses Free and says both what it costs on Team and that Business includes it", async () => {
    org("free");
    const err = await assertCertifiedInvoices(ORG_ID, HOSTED).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as Error).message).toMatch(/Team plan/);
    expect((err as Error).message).toMatch(/\$1 each; Business includes them/);
  });

  it("allows Team and marks the invoice as metered", async () => {
    org("team");
    expect(await assertCertifiedInvoices(ORG_ID, HOSTED)).toEqual({ plan: "team", metered: true, customerId: "cus_live" });
  });

  it("allows Business and meters nothing", async () => {
    org("business");
    expect(await assertCertifiedInvoices(ORG_ID, HOSTED)).toEqual({ plan: "business", metered: false, customerId: "cus_live" });
  });

  it("refuses a Team organization it cannot bill, before anything is frozen", async () => {
    org("team", { stripeSubscriptionId: null });
    const err = await assertCertifiedInvoices(ORG_ID, HOSTED).catch((e) => e);
    expect((err as InstanceType<typeof ActionError>).code).toBe("conflict");
    expect((err as Error).message).toMatch(/no live Stripe subscription/);
  });

  it("allows everything and meters nothing when self-hosted", async () => {
    org("free");
    expect(await assertCertifiedInvoices(ORG_ID, SELF)).toEqual({ plan: null, metered: false, customerId: null });
    org("self_hosted");
    expect(await assertCertifiedInvoices(ORG_ID, HOSTED)).toEqual({ plan: "self_hosted", metered: false, customerId: null });
  });
});

describe("assertAiAllowed", () => {
  const withServerKey = { hasOrgKey: false, serverKeyConfigured: true, env: HOSTED };

  it("refuses Free outright, with or without a key of its own", async () => {
    org("free");
    await expect(assertAiAllowed(ORG_ID, withServerKey)).rejects.toThrow(/Team plan/);
    await expect(assertAiAllowed(ORG_ID, { hasOrgKey: true, serverKeyConfigured: true, env: HOSTED })).rejects.toThrow(ActionError);
  });

  it("meters Team and Business when PTD's key answers", async () => {
    for (const plan of ["team", "business"]) {
      org(plan);
      expect(await assertAiAllowed(ORG_ID, withServerKey)).toEqual({ plan, source: "ptd", metered: true, customerId: "cus_live" });
    }
  });

  it("meters nothing when the organization brought its own key", async () => {
    org("team");
    expect(await assertAiAllowed(ORG_ID, { hasOrgKey: true, serverKeyConfigured: true, env: HOSTED })).toEqual({
      plan: "team",
      source: "org",
      metered: false,
      customerId: "cus_live",
    });
  });

  it("tells a Team organization to connect its own key when the deployment has none", async () => {
    org("team");
    const err = await assertAiAllowed(ORG_ID, { hasOrgKey: false, serverKeyConfigured: false, env: HOSTED }).catch((e) => e);
    expect((err as InstanceType<typeof ActionError>).code).toBe("invalid");
    expect((err as Error).message).toMatch(/ai\.connect/);
  });

  it("refuses to spend PTD's key for an organization it cannot bill", async () => {
    org("team", { stripeCustomerId: null, stripeSubscriptionId: null });
    const err = await assertAiAllowed(ORG_ID, withServerKey).catch((e) => e);
    expect((err as InstanceType<typeof ActionError>).code).toBe("conflict");
    expect((err as Error).message).toMatch(/cost plus 20%/);
  });

  it("allows everything, metered nowhere, when self-hosted", async () => {
    org("free");
    expect(await assertAiAllowed(ORG_ID, { hasOrgKey: false, serverKeyConfigured: true, env: SELF })).toEqual({
      plan: null,
      source: "ptd",
      metered: false,
      customerId: null,
    });
  });
});

describe("PTD_HOSTED unset", () => {
  it("makes every gate a no-op that reads nothing", async () => {
    org("free");
    fakeDb.selects = [];
    expect(await gatedPlan(ORG_ID, SELF)).toBeNull();
    expect(await assertFeature(ORG_ID, "audit_export", "X", SELF)).toBeNull();
    expect(await assertCertifiedInvoices(ORG_ID, SELF)).toMatchObject({ metered: false });
    expect(await assertAiAllowed(ORG_ID, { hasOrgKey: false, serverKeyConfigured: false, env: SELF })).toMatchObject({ metered: false });
    expect(fakeDb.selects).toHaveLength(0);
  });
});
