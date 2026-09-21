import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", async () => {
  const mod = await import("./access-db");
  return {
    db: new Proxy(
      {},
      {
        get: (_target, prop) => {
          const value = (mod.state.db as unknown as Record<string, unknown>)[prop as string];
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(mod.state.db) : value;
        },
      }
    ),
  };
});

import { verifySessionJwt } from "../../server/auth/jwt";
import {
  codeHashOf,
  eligibilityOf,
  initialAccess,
  invoiceByVerifyToken,
  maskEmail,
  MAX_CODE_ATTEMPTS,
  NEUTRAL_REQUEST_MESSAGE,
  normaliseEmail,
  recipientHash,
  recipientsOf,
  redeemAccessCode,
  requestAccessCode,
  shareInvoice,
  unshareInvoice,
  verifyAccessToken,
} from "../../server/invoices/access";
import { contentHashOf, SNAPSHOT_VERSION, type InvoiceSnapshot } from "../../server/invoices/snapshot";
import { AccessDb, state } from "./access-db";

const TOKEN = "f58bcb303d70aa83a9aa6e362c68752cb92d367a2940c63c7aacc0144817f8cf";
const OTHER_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

const CONTRACTOR = "priya@atelier14.demo";
const CLIENT = "annika@northwind.example";
const MANAGER = "marcus@atelier14.demo";
const STRANGER = "someone@elsewhere.example";

function snapshot(over: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    kind: "contractor",
    org: { id: 1, name: "Atelier 14" },
    contractor: { userId: 3, name: "Priya Indigo", billingName: "Indigo Studio Ltd", taxId: "FR90210445" },
    period: { month: 9, year: 2026, label: "September 2026", from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" },
    currency: "USD",
    rate: 40,
    lines: [],
    totals: { minutes: 200, amountCents: 13333, humanMinutes: 200, agentMinutes: 0, tokens: 0, costUsd: 0 },
    issuedAt: "2026-09-20T12:00:00.000Z",
    reference: "PTD-CTR-2026-09-0001",
    ...over,
  };
}

/** One invoice, its organization's managers, and the contractor it is about. */
function world(over: { snapshot?: InvoiceSnapshot; verifyToken?: string } = {}) {
  const db = new AccessDb({
    id: 7,
    orgId: 1,
    kind: "contractor",
    memberUserId: 3,
    reference: "PTD-CTR-2026-09-0001",
    verifyToken: over.verifyToken ?? TOKEN,
    snapshot: over.snapshot ?? snapshot(),
  });
  db.staff = [{ email: MANAGER, role: "manager", isAgent: false, userId: 2 }];
  db.people = [{ id: 3, email: CONTRACTOR, isAgent: false }];
  state.db = db;
  return db;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const accessOf = (db: AccessDb) => (db.invoice.snapshot as InvoiceSnapshot).access ?? { recipients: [], codes: [] };

/** Ask for a code the way the page does, and read it out of the development reply. */
async function codeFor(email: string, token = TOKEN): Promise<string> {
  const outcome = await requestAccessCode({ token, email, ip: "203.0.113.7" });
  expect(outcome.message).toBe(NEUTRAL_REQUEST_MESSAGE);
  expect(outcome.code).toBeTypeOf("string");
  return outcome.code as string;
}

beforeEach(() => {
  world();
});

describe("an address is never stored", () => {
  it("hashes per invoice, so the same person on two invoices does not correlate", () => {
    expect(recipientHash(TOKEN, CLIENT)).toHaveLength(64);
    expect(recipientHash(TOKEN, CLIENT)).toBe(recipientHash(TOKEN, ` ${CLIENT.toUpperCase()} `));
    expect(recipientHash(TOKEN, CLIENT)).not.toBe(recipientHash(OTHER_TOKEN, CLIENT));
  });

  it("masks the part that names a person and keeps the part that names a company", () => {
    expect(maskEmail(CLIENT)).toBe("a••••a@northwind.example");
    expect(maskEmail("AP@northwind.example")).toBe("a•@northwind.example");
    expect(normaliseEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("keeps no address anywhere in the row after a share", async () => {
    const db = world();
    const row = (await invoiceByVerifyToken(TOKEN))!;
    await shareInvoice({ row, emails: [CLIENT], sharedBy: "Elena Draftworks", sharedByUserId: 1, orgName: "Atelier 14" });
    const serialised = JSON.stringify(db.invoice);
    expect(serialised).not.toContain("annika");
    expect(serialised).not.toContain(CLIENT);
    expect(serialised).toContain(recipientHash(TOKEN, CLIENT));
  });
});

describe("the access block is not part of what was signed", () => {
  it("leaves the content hash exactly where it was", async () => {
    const bare = snapshot();
    const before = contentHashOf(bare);
    const row = (await invoiceByVerifyToken(TOKEN))!;
    await shareInvoice({ row, emails: [CLIENT], sharedBy: "Elena", sharedByUserId: 1, orgName: "Atelier 14" });
    const after = contentHashOf(state.db.invoice.snapshot as InvoiceSnapshot);
    expect(after).toBe(before);
  });
});

describe("the parties are allowlisted at issue", () => {
  it("names the contractor being paid", async () => {
    const access = await initialAccess({ verifyToken: TOKEN, snapshot: snapshot(), memberUserId: 3 });
    expect(access.recipients).toHaveLength(1);
    expect(access.recipients[0]).toMatchObject({ hash: recipientHash(TOKEN, CONTRACTOR), mask: maskEmail(CONTRACTOR), via: "issue", addedBy: null });
  });

  it("names a customer's billing address", async () => {
    const snap = snapshot({
      kind: "customer",
      contractor: undefined,
      customer: { id: 1, name: "Northwind Retail", billingAddress: null, billingEmail: CLIENT },
    });
    const access = await initialAccess({ verifyToken: TOKEN, snapshot: snap, memberUserId: null });
    expect(access.recipients.map((r) => r.hash)).toEqual([recipientHash(TOKEN, CLIENT)]);
  });

  it("does not name an agent seat, which has no inbox", async () => {
    state.db.people = [{ id: 3, email: "agent_claude_code@agents.ptd.local", isAgent: true }];
    const access = await initialAccess({ verifyToken: TOKEN, snapshot: snapshot(), memberUserId: 3 });
    expect(access.recipients).toEqual([]);
  });
});

describe("asking for a code says nothing about the address", () => {
  it("answers the same sentence for a token that never existed", async () => {
    const outcome = await requestAccessCode({ token: "b".repeat(64), email: CLIENT });
    expect(outcome).toEqual({ message: NEUTRAL_REQUEST_MESSAGE });
    expect(state.db.updates).toBe(0);
  });

  it("answers the same sentence for a stranger, and stores no code", async () => {
    const outcome = await requestAccessCode({ token: TOKEN, email: STRANGER });
    expect(outcome).toEqual({ message: NEUTRAL_REQUEST_MESSAGE });
    expect(outcome.code).toBeUndefined();
    expect(accessOf(state.db).codes).toEqual([]);
    await flush();
    expect(state.db.audits.map((a) => a.kind)).toContain("invoice.access_denied");
  });

  it("sends one to a named recipient, and stores only its hash", async () => {
    const db = world();
    const row = (await invoiceByVerifyToken(TOKEN))!;
    await shareInvoice({ row, emails: [CLIENT], sharedBy: "Elena", sharedByUserId: 1, orgName: "Atelier 14" });
    const code = await codeFor(CLIENT);

    expect(code).toMatch(/^\d{6}$/);
    const codes = accessOf(db).codes;
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ hash: recipientHash(TOKEN, CLIENT), codeHash: codeHashOf(TOKEN, code), attempts: 0 });
    expect(JSON.stringify(db.invoice)).not.toContain(code);
    await flush();
    const requested = db.audits.find((a) => a.kind === "invoice.access_requested");
    expect(requested).toMatchObject({ target: "PTD-CTR-2026-09-0001", meta: { recipient: recipientHash(TOKEN, CLIENT) } });
  });

  it("sends one to the organization's own managers and to the contractor being paid", async () => {
    await expect(eligibilityOf((await invoiceByVerifyToken(TOKEN))!, MANAGER)).resolves.toBe("standing");
    await expect(eligibilityOf((await invoiceByVerifyToken(TOKEN))!, CONTRACTOR)).resolves.toBe("standing");
    await expect(eligibilityOf((await invoiceByVerifyToken(TOKEN))!, STRANGER)).resolves.toBe("none");
    expect(await codeFor(MANAGER)).toMatch(/^\d{6}$/);
  });

  it("replaces the last code rather than leaving two live", async () => {
    const first = await codeFor(CONTRACTOR);
    const second = await codeFor(CONTRACTOR);
    // One recipient, one live code — the newer letter invalidates the older one.
    expect(accessOf(state.db).codes).toHaveLength(1);
    expect(accessOf(state.db).codes[0].codeHash).toBe(codeHashOf(TOKEN, second));
    if (first !== second) {
      expect(await redeemAccessCode({ token: TOKEN, email: CONTRACTOR, code: first })).toEqual({ ok: false, failure: "invalid" });
    }
  });
});

describe("redeeming one", () => {
  it("opens the details and hands back a token bound to this invoice", async () => {
    const db = world();
    const code = await codeFor(CONTRACTOR);
    const result = await redeemAccessCode({ token: TOKEN, email: CONTRACTOR, code, ip: "203.0.113.7" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(verifyAccessToken(`Bearer ${result.accessToken}`, TOKEN)).toEqual({ recipient: recipientHash(TOKEN, CONTRACTOR) });
    // The same grant is worthless against any other invoice.
    expect(verifyAccessToken(result.accessToken, OTHER_TOKEN)).toBeNull();
    // And it is not a session: the purpose claim is what keeps the two apart.
    expect(() => verifySessionJwt(result.accessToken)).toThrow();

    expect(accessOf(db).codes).toEqual([]);
    await flush();
    expect(db.audits.find((a) => a.kind === "invoice.access_granted")).toMatchObject({ meta: { recipient: recipientHash(TOKEN, CONTRACTOR) } });
  });

  it("counts the grant against the recipient without naming them", async () => {
    const db = world();
    const row = (await invoiceByVerifyToken(TOKEN))!;
    await shareInvoice({ row, emails: [CLIENT], sharedBy: "Elena", sharedByUserId: 1, orgName: "Atelier 14" });
    const code = await codeFor(CLIENT);
    await redeemAccessCode({ token: TOKEN, email: CLIENT, code });
    expect(recipientsOf((await invoiceByVerifyToken(TOKEN))!)).toEqual([
      { mask: maskEmail(CLIENT), addedAt: expect.any(String), via: "share", requests: 1, grants: 1 },
    ]);
    expect(JSON.stringify(db.invoice)).not.toContain("annika");
  });

  it("refuses a wrong code, and kills it on the fifth", async () => {
    const db = world();
    const code = await codeFor(CONTRACTOR);
    const wrong = code === "000000" ? "111111" : "000000";

    for (let attempt = 1; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const r = await redeemAccessCode({ token: TOKEN, email: CONTRACTOR, code: wrong });
      expect(r).toEqual({ ok: false, failure: "invalid" });
      expect(accessOf(db).codes[0].attempts).toBe(attempt);
    }
    expect(await redeemAccessCode({ token: TOKEN, email: CONTRACTOR, code: wrong })).toEqual({ ok: false, failure: "locked" });
    // Dead, so even the right code no longer opens it.
    expect(accessOf(db).codes).toEqual([]);
    expect(await redeemAccessCode({ token: TOKEN, email: CONTRACTOR, code })).toEqual({ ok: false, failure: "invalid" });
  });

  it("refuses an expired code and discards it", async () => {
    const db = world();
    await codeFor(CONTRACTOR);
    const snap = db.invoice.snapshot as InvoiceSnapshot;
    const code = "424242";
    snap.access!.codes = [
      {
        hash: recipientHash(TOKEN, CONTRACTOR),
        codeHash: codeHashOf(TOKEN, code),
        issuedAt: new Date(Date.now() - 3_600_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        attempts: 0,
      },
    ];
    expect(await redeemAccessCode({ token: TOKEN, email: CONTRACTOR, code })).toEqual({ ok: false, failure: "invalid" });
    expect(accessOf(db).codes).toEqual([]);
  });

  it("takes the code the way the letter prints it, spaces and all", async () => {
    world();
    const code = await codeFor(CONTRACTOR);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    const r = await redeemAccessCode({ token: TOKEN, email: CONTRACTOR, code: spaced });
    expect(r.ok).toBe(true);
  });

  it("refuses a code that belongs to a different address", async () => {
    world();
    const code = await codeFor(CONTRACTOR);
    expect(await redeemAccessCode({ token: TOKEN, email: MANAGER, code })).toEqual({ ok: false, failure: "invalid" });
  });

  it("refuses a forged or foreign access token outright", () => {
    expect(verifyAccessToken("", TOKEN)).toBeNull();
    expect(verifyAccessToken("Bearer not.a.jwt", TOKEN)).toBeNull();
  });
});

describe("sharing and withdrawing", () => {
  it("adds each address once, and treats a repeat as a re-send", async () => {
    const db = world();
    const row = (await invoiceByVerifyToken(TOKEN))!;
    const first = await shareInvoice({ row, emails: [CLIENT, CLIENT], sharedBy: "Elena", sharedByUserId: 1, orgName: "Atelier 14" });
    expect(first.shared).toHaveLength(1);
    expect(first.shared[0]).toMatchObject({ mask: maskEmail(CLIENT), added: true, mailed: false, reason: "smtp_not_configured" });

    const again = await shareInvoice({ row, emails: [CLIENT], sharedBy: "Elena", sharedByUserId: 1, orgName: "Atelier 14" });
    expect(again.shared[0].added).toBe(false);
    expect(again.recipients).toHaveLength(1);
    expect(accessOf(db).recipients).toHaveLength(1);
  });

  it("withdraws an address and destroys the code already sent to it", async () => {
    const db = world();
    const row = (await invoiceByVerifyToken(TOKEN))!;
    await shareInvoice({ row, emails: [CLIENT], sharedBy: "Elena", sharedByUserId: 1, orgName: "Atelier 14" });
    await codeFor(CLIENT);
    expect(accessOf(db).codes).toHaveLength(1);

    const gone = await unshareInvoice({ row: (await invoiceByVerifyToken(TOKEN))!, email: CLIENT });
    expect(gone).toMatchObject({ removed: true, mask: maskEmail(CLIENT), recipients: [] });
    expect(accessOf(db).codes).toEqual([]);

    const twice = await unshareInvoice({ row: (await invoiceByVerifyToken(TOKEN))!, email: CLIENT });
    expect(twice.removed).toBe(false);
  });

  it("does not let a withdrawn stranger ask for another code", async () => {
    const row = (await invoiceByVerifyToken(TOKEN))!;
    await shareInvoice({ row, emails: [STRANGER], sharedBy: "Elena", sharedByUserId: 1, orgName: "Atelier 14" });
    expect(await codeFor(STRANGER)).toMatch(/^\d{6}$/);
    await unshareInvoice({ row: (await invoiceByVerifyToken(TOKEN))!, email: STRANGER });
    const outcome = await requestAccessCode({ token: TOKEN, email: STRANGER });
    expect(outcome.code).toBeUndefined();
  });
});
