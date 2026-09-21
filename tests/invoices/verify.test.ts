import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import { generateKeyPairSync, sign as cryptoSign } from "crypto";
import { db } from "../../db";
import { contentHashOf, entrySha256, SNAPSHOT_VERSION, type HashableEntry, type InvoiceSnapshot } from "../../server/invoices/snapshot";
import { looksLikeToken, publicVerifyByToken, publicViewOf, verifyByToken } from "../../server/invoices/verify";
import type { FakeDb } from "./fake-db";

const fake = db as unknown as FakeDb;

const TOKEN = "f58bcb303d70aa83a9aa6e362c68752cb92d367a2940c63c7aacc0144817f8cf";

const keys = generateKeyPairSync("ed25519");
const PUBLIC = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const sign = (hash: string) => cryptoSign(null, Buffer.from(hash, "utf8"), keys.privateKey).toString("base64");

const liveEntry = (over: Partial<HashableEntry> = {}): HashableEntry => ({
  id: 14,
  userId: 3,
  checkIn: new Date("2026-09-15T09:00:00.000Z"),
  checkOut: new Date("2026-09-15T12:20:00.000Z"),
  isBreak: false,
  taskId: 11,
  streamId: 3,
  customerId: 1,
  entrySource: "human",
  tokensUsed: null,
  apiCostUsd: null,
  ...over,
});

function snapshot(): InvoiceSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    kind: "contractor",
    org: { id: 1, name: "Atelier 14" },
    contractor: { userId: 3, name: "Priya Indigo", billingName: "Indigo Studio Ltd", taxId: "FR90210445" },
    period: { month: 9, year: 2026, label: "September 2026", from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" },
    currency: "USD",
    rate: 40,
    lines: [
      {
        entryId: 14,
        checkIn: "2026-09-15T09:00:00.000Z",
        checkOut: "2026-09-15T12:20:00.000Z",
        minutes: 200,
        taskId: 11,
        taskKey: "MOB-1",
        taskTitle: "Onboarding copy and screens",
        streamId: 3,
        streamName: "Mobile onboarding",
        entrySource: "human",
        tokensUsed: null,
        apiCostUsd: null,
        approvalStatus: "approved",
        entrySha256: entrySha256(liveEntry()),
      },
    ],
    totals: { minutes: 200, amountCents: 13333, humanMinutes: 200, agentMinutes: 0, tokens: 0, costUsd: 0 },
    issuedAt: "2026-09-20T12:00:00.000Z",
    reference: "PTD-CTR-2026-09-0001",
  };
}

/** Queue the three reads verifyByToken makes: the invoice, the key, the live rows. */
function scenario(opts: { snapshot?: InvoiceSnapshot; contentHash?: string; signature?: string; voidedAt?: Date | null; live?: HashableEntry[]; publicKey?: string } = {}) {
  const snap = opts.snapshot ?? snapshot();
  const hash = opts.contentHash ?? contentHashOf(snap);
  fake.reset().queue(
    [
      {
        id: 1,
        orgId: 1,
        kind: "contractor",
        snapshot: snap,
        contentHash: hash,
        signature: opts.signature ?? sign(hash),
        signingKeyId: 1,
        verifyToken: TOKEN,
        voidedAt: opts.voidedAt ?? null,
      },
    ],
    [{ id: 1, algorithm: "ed25519", publicKey: opts.publicKey ?? PUBLIC, privateKeySealed: "sealed", createdAt: new Date(), retiredAt: null }],
    opts.live === undefined ? [liveEntry()] : opts.live
  );
}

beforeEach(() => fake.reset());

describe("token shape", () => {
  it("accepts a 64-character hex token and nothing else", () => {
    expect(looksLikeToken(TOKEN)).toBe(true);
    expect(looksLikeToken(TOKEN.toUpperCase())).toBe(true);
    expect(looksLikeToken("not-a-token")).toBe(false);
    expect(looksLikeToken(TOKEN.slice(0, 63))).toBe(false);
    expect(looksLikeToken(`${TOKEN}0`)).toBe(false);
  });

  it("answers the same way for a malformed token as for one that never existed", async () => {
    const bad = await verifyByToken("../../etc/passwd");
    expect(bad.valid).toBe(false);
    expect(bad.invoice).toBeUndefined();
    expect(bad.reason).toMatch(/No invoice carries that verification token/);
    // No query is even attempted for a token that cannot exist.
    expect(fake.selects).toBe(0);
  });

  it("does not say whether an unknown but well-formed token ever existed", async () => {
    fake.queue([]);
    const missing = await verifyByToken("a".repeat(64));
    expect(missing.valid).toBe(false);
    expect(missing.invoice).toBeUndefined();
    expect(missing.reason).toMatch(/No invoice carries that verification token/);
  });
});

describe("a sound invoice", () => {
  it("verifies, and reports all three checks passing", async () => {
    scenario();
    const r = await verifyByToken(TOKEN);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.integrity).toMatchObject({
      contentHashMatches: true,
      signatureValid: true,
      entriesUnchanged: true,
      changedEntryIds: [],
      missingEntryIds: [],
      entriesChecked: 1,
      keyId: 1,
      algorithm: "ed25519",
    });
  });

  it("states what the document says, in the terms a verifier needs", async () => {
    scenario();
    const r = await verifyByToken(TOKEN);
    expect(r.invoice).toMatchObject({
      reference: "PTD-CTR-2026-09-0001",
      kind: "contractor",
      org: "Atelier 14",
      contractorOrCustomer: "Indigo Studio Ltd",
      currency: "USD",
      rate: 40,
      voided: false,
    });
    expect(r.invoice!.totals).toEqual({ minutes: 200, hours: 3.33, amountCents: 13333 });
  });

  it("shows a date, a duration and what the work was booked against — and no notes or emails", async () => {
    scenario();
    const r = await verifyByToken(TOKEN);
    expect(r.lines).toEqual([
      { date: "2026-09-15", minutes: 200, taskKey: "MOB-1", taskTitle: "Onboarding copy and screens", streamName: "Mobile onboarding", entrySource: "human" },
    ]);
    const body = JSON.stringify(r);
    expect(body).not.toContain("notes");
    expect(body).not.toContain("@");
    expect(body).not.toContain("entrySha256");
    expect(body).not.toContain("checkIn");
  });
});

describe("the three checks fail independently", () => {
  it("catches a rewritten snapshot", async () => {
    const snap = snapshot();
    const hash = contentHashOf(snap);
    const signature = sign(hash);
    snap.totals.minutes = 9000; // edited after the hash was taken
    scenario({ snapshot: snap, contentHash: hash, signature });
    const r = await verifyByToken(TOKEN);
    expect(r.valid).toBe(false);
    expect(r.integrity).toMatchObject({ contentHashMatches: false, signatureValid: true, entriesUnchanged: true });
    expect(r.reasons).toContain("The frozen record no longer hashes to the value recorded with it, so the record has been altered.");
  });

  it("catches a snapshot rewritten together with its hash, by the signature", async () => {
    const snap = snapshot();
    snap.totals.minutes = 9000;
    // The forger recomputed the hash but cannot produce a signature for it.
    scenario({ snapshot: snap, contentHash: contentHashOf(snap), signature: sign("a different hash entirely") });
    const r = await verifyByToken(TOKEN);
    expect(r.valid).toBe(false);
    expect(r.integrity).toMatchObject({ contentHashMatches: true, signatureValid: false });
    expect(r.reasons).toContain("The signature does not verify against the signing key this invoice names.");
  });

  it("catches an edited ledger row, and names it", async () => {
    scenario({ live: [liveEntry({ checkOut: new Date("2026-09-15T18:00:00.000Z") })] });
    const r = await verifyByToken(TOKEN);
    expect(r.valid).toBe(false);
    expect(r.integrity).toMatchObject({ contentHashMatches: true, signatureValid: true, entriesUnchanged: false, changedEntryIds: [14] });
    expect(r.reason).toBe("1 time entry has been altered since this invoice was issued.");
  });

  it("catches a deleted ledger row", async () => {
    scenario({ live: [] });
    const r = await verifyByToken(TOKEN);
    expect(r.valid).toBe(false);
    expect(r.integrity).toMatchObject({ entriesUnchanged: false, missingEntryIds: [14], changedEntryIds: [] });
    expect(r.reason).toMatch(/has been deleted since this invoice was issued/);
  });

  it("fails a voided invoice while confirming the record itself is intact", async () => {
    scenario({ voidedAt: new Date("2026-09-21T09:00:00.000Z") });
    const r = await verifyByToken(TOKEN);
    expect(r.valid).toBe(false);
    expect(r.invoice).toMatchObject({ voided: true, voidedAt: "2026-09-21T09:00:00.000Z" });
    expect(r.integrity).toMatchObject({ contentHashMatches: true, signatureValid: true, entriesUnchanged: true });
    expect(r.reason).toBe("This invoice has been voided by the organization that issued it.");
  });

  it("fails when the key the invoice names has gone missing", async () => {
    const snap = snapshot();
    const hash = contentHashOf(snap);
    fake.reset().queue(
      [{ id: 1, orgId: 1, kind: "contractor", snapshot: snap, contentHash: hash, signature: sign(hash), signingKeyId: 7, verifyToken: TOKEN, voidedAt: null }],
      [],
      [liveEntry()]
    );
    const r = await verifyByToken(TOKEN);
    expect(r.valid).toBe(false);
    expect(r.integrity).toMatchObject({ signatureValid: false, keyId: 7, algorithm: null });
  });

  it("reports every reason at once when several things are wrong", async () => {
    const snap = snapshot();
    const hash = contentHashOf(snap);
    const signature = sign(hash);
    snap.rate = 999;
    scenario({ snapshot: snap, contentHash: hash, signature, voidedAt: new Date(), live: [] });
    const r = await verifyByToken(TOKEN);
    expect(r.reasons?.length).toBe(3);
    expect(r.valid).toBe(false);
  });
});

describe("a customer invoice", () => {
  it("names the customer rather than a contractor", async () => {
    const snap = snapshot();
    snap.kind = "customer";
    delete snap.contractor;
    snap.customer = { id: 1, name: "Northwind Retail", billingAddress: null, billingEmail: null };
    scenario({ snapshot: snap });
    const r = await verifyByToken(TOKEN);
    expect(r.invoice).toMatchObject({ kind: "customer", contractorOrCustomer: "Northwind Retail" });
    expect(r.valid).toBe(true);
  });
});

describe("the anonymous answer the bare link gives", () => {
  /**
   * The point of these: a verification link is printed on a document that gets
   * forwarded, filed and attached to other mail. It has to prove the document is
   * genuine without telling whoever ends up with it who is billing whom for how
   * much. So the assertions are about what is *absent*.
   */
  it("proves the invoice and names nothing else", async () => {
    scenario();
    const r = await publicVerifyByToken(TOKEN);
    expect(r.valid).toBe(true);
    expect(r.invoice).toEqual({
      reference: "PTD-CTR-2026-09-0001",
      kind: "contractor",
      issuedAt: "2026-09-20T12:00:00.000Z",
      voided: false,
    });
    expect(r.integrity).toEqual({ contentHashMatches: true, signatureValid: true, entriesUnchanged: true, keyId: 1 });
    expect(r.detailsAvailable).toBe(true);
    expect(r.lines).toBeUndefined();
  });

  it("carries no organization, no party, no period, no money and no hours", async () => {
    scenario();
    const body = JSON.stringify(await publicVerifyByToken(TOKEN));
    for (const leak of ["Atelier 14", "Priya", "Indigo Studio", "FR90210445", "September 2026", "USD", "13333", "200", "MOB-1", "Onboarding"]) {
      expect(body).not.toContain(leak);
    }
    // Not even the digest, which is a fingerprint of the whole record.
    expect(body).not.toContain(contentHashOf(snapshot()));
    expect(body).not.toContain("@");
  });

  it("still says which assurance broke, in counts rather than names", async () => {
    scenario({ live: [liveEntry({ checkOut: new Date("2026-09-15T18:00:00.000Z") })] });
    const r = await publicVerifyByToken(TOKEN);
    expect(r.valid).toBe(false);
    expect(r.integrity).toMatchObject({ entriesUnchanged: false, contentHashMatches: true, signatureValid: true });
    expect(r.reason).toBe("1 time entry has been altered since this invoice was issued.");
    // The altered row's id is a detail, and details are behind a code.
    expect(JSON.stringify(r)).not.toContain("changedEntryIds");
  });

  it("says a withdrawn invoice is withdrawn without saying when", async () => {
    scenario({ voidedAt: new Date("2026-09-21T09:00:00.000Z") });
    const r = await publicVerifyByToken(TOKEN);
    expect(r.invoice).toMatchObject({ voided: true });
    expect(JSON.stringify(r)).not.toContain("2026-09-21");
  });

  it("answers an unknown token the same way the full check does", async () => {
    fake.queue([]);
    const r = await publicVerifyByToken("a".repeat(64));
    expect(r.valid).toBe(false);
    expect(r.invoice).toBeUndefined();
    expect(r.integrity).toBeUndefined();
    expect(r.reason).toMatch(/No invoice carries that verification token/);
  });

  it("is a projection of the one verification routine, not a second opinion", async () => {
    scenario();
    const full = await verifyByToken(TOKEN);
    expect(publicViewOf(full).valid).toBe(full.valid);
    expect(publicViewOf(full).integrity?.signatureValid).toBe(full.integrity?.signatureValid);
  });
});
