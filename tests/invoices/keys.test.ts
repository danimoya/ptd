import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import { generateKeyPairSync } from "crypto";
import { db } from "../../db";
import { signingKeys } from "../../db/schema";
import { encryptSecret } from "../../server/crypto";
import { activeSigningKey, publishedKeys, signHash, signingKeyById, verifyHash } from "../../server/invoices/keys";
import type { FakeDb } from "./fake-db";

const fake = db as unknown as FakeDb;

/** A real Ed25519 pair, sealed the way the table stores it. */
function pair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sealed: encryptSecret(privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
  };
}

const HASH = "752a0434bbb6560f88c56c653563daead28d18f21820418e6da978a1d5728803";

beforeEach(() => fake.reset());

describe("activeSigningKey", () => {
  it("returns the key that already exists rather than minting another", async () => {
    const k = pair();
    fake.queue([{ id: 3, algorithm: "ed25519", publicKey: k.publicKey, privateKeySealed: k.sealed, createdAt: new Date(), retiredAt: null }]);
    const key = await activeSigningKey();
    expect(key.id).toBe(3);
    expect(fake.inserts).toHaveLength(0);
  });

  it("creates an Ed25519 pair on first use, storing only the public half in the clear", async () => {
    fake.queue([]); // nothing active yet
    const key = await activeSigningKey();
    expect(fake.inserts).toHaveLength(1);
    const written = fake.inserts[0].values;
    expect(fake.inserts[0].table).toBe(signingKeys);
    expect(written.algorithm).toBe("ed25519");
    expect(written.publicKey).toContain("BEGIN PUBLIC KEY");
    // The private half is sealed, never stored as a PEM anyone can read.
    expect(written.privateKeySealed).toMatch(/^v1\./);
    expect(written.privateKeySealed).not.toContain("PRIVATE KEY");
    expect(key.publicKey).toBe(written.publicKey);
  });
});

describe("signHash / verifyHash", () => {
  it("signs a content hash so the published public key verifies it", async () => {
    const k = pair();
    fake.queue([{ sealed: k.sealed }]);
    const signature = await signHash(HASH, 1);
    expect(signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    // Ed25519 signatures are 64 bytes.
    expect(Buffer.from(signature, "base64")).toHaveLength(64);
    expect(verifyHash(HASH, signature, k.publicKey)).toBe(true);
  });

  it("refuses a signature over a different hash", async () => {
    const k = pair();
    fake.queue([{ sealed: k.sealed }]);
    const signature = await signHash(HASH, 1);
    expect(verifyHash(HASH.replace(/^7/, "8"), signature, k.publicKey)).toBe(false);
  });

  it("refuses a signature made with another key", async () => {
    const mine = pair();
    const theirs = pair();
    fake.queue([{ sealed: mine.sealed }]);
    const signature = await signHash(HASH, 1);
    expect(verifyHash(HASH, signature, theirs.publicKey)).toBe(false);
  });

  it("treats a malformed key or signature as a failed check, not a crash", () => {
    const k = pair();
    expect(verifyHash(HASH, "not base64 at all !!", k.publicKey)).toBe(false);
    expect(verifyHash(HASH, "AAAA", "-----BEGIN PUBLIC KEY-----\nnonsense\n-----END PUBLIC KEY-----\n")).toBe(false);
    expect(verifyHash(HASH, "", k.publicKey)).toBe(false);
  });

  it("says which key is missing rather than signing with nothing", async () => {
    fake.queue([]);
    await expect(signHash(HASH, 9)).rejects.toThrow(/Signing key 9 is missing/);
  });
});

describe("the published key document", () => {
  it("lists every key, retired ones included, so old invoices keep verifying", async () => {
    const a = pair();
    const b = pair();
    fake.queue([
      { id: 2, algorithm: "ed25519", publicKey: b.publicKey, createdAt: new Date("2026-09-01T00:00:00Z"), retiredAt: null },
      { id: 1, algorithm: "ed25519", publicKey: a.publicKey, createdAt: new Date("2026-01-01T00:00:00Z"), retiredAt: new Date("2026-09-01T00:00:00Z") },
    ]);
    const keys = await publishedKeys();
    expect(keys.map((k) => k.id)).toEqual([2, 1]);
    expect(keys[1].retiredAt).toBe("2026-09-01T00:00:00.000Z");
    // No sealed material may appear in a document that is served to the world.
    expect(JSON.stringify(keys)).not.toContain("v1.");
    expect(JSON.stringify(keys)).not.toContain("PRIVATE");
  });

  it("finds a key by id, and answers null for one that is not there", async () => {
    fake.queue([{ id: 4, algorithm: "ed25519", publicKey: "x", privateKeySealed: "y", createdAt: new Date(), retiredAt: null }], []);
    expect((await signingKeyById(4))?.id).toBe(4);
    expect(await signingKeyById(5)).toBeNull();
  });
});
