/**
 * The deployment's invoice-signing key.
 *
 * Ed25519, created on first use and never exported afterwards: the public half is
 * stored in the clear (it is meant to be published, at
 * `/.well-known/ptd-signing-key.json`) and the private half is sealed with
 * `encryptSecret`, the same AES-256-GCM envelope the integrations' credentials
 * use, so a database dump alone cannot forge an invoice.
 *
 * Keys are never deleted. `retired_at` stops a key being used for new invoices
 * while it stays published, because an invoice issued two years ago must still be
 * verifiable by whoever is holding the PDF.
 *
 * Ed25519 rather than RSA: 32-byte public keys and 64-byte signatures print small
 * enough to sit on a paper document, and Node's `crypto` does it without a
 * dependency.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "crypto";
import { desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { signingKeys } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../crypto";

export const SIGNING_ALGORITHM = "ed25519";

export interface SigningKey {
  id: number;
  algorithm: string;
  publicKey: string;
  createdAt: Date;
  retiredAt: Date | null;
}

/**
 * First use creates the key. Two requests arriving together would otherwise both
 * insert one, so the creation is funnelled through a single in-process promise;
 * across replicas the loser's key is simply an extra published key, never a lost
 * invoice, because the invoice records which key signed it.
 */
let creating: Promise<SigningKey> | null = null;

async function readActive(): Promise<SigningKey | null> {
  const [row] = await db
    .select()
    .from(signingKeys)
    .where(isNull(signingKeys.retiredAt))
    .orderBy(desc(signingKeys.id))
    .limit(1);
  return row ?? null;
}

async function create(): Promise<SigningKey> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const [row] = await db
    .insert(signingKeys)
    .values({
      algorithm: SIGNING_ALGORITHM,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeySealed: encryptSecret(privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    })
    .returning();
  return row;
}

/** The key new invoices are signed with, created on the first call. */
export async function activeSigningKey(): Promise<SigningKey> {
  const existing = await readActive();
  if (existing) return existing;
  if (!creating) {
    creating = create().finally(() => {
      creating = null;
    });
  }
  return creating;
}

export async function signingKeyById(id: number): Promise<SigningKey | null> {
  const [row] = await db.select().from(signingKeys).where(eq(signingKeys.id, id)).limit(1);
  return row ?? null;
}

/** Every key the deployment has ever used, newest first — the well-known document. */
export async function publishedKeys(): Promise<{ id: number; algorithm: string; publicKey: string; createdAt: string; retiredAt: string | null }[]> {
  const rows = await db
    .select({ id: signingKeys.id, algorithm: signingKeys.algorithm, publicKey: signingKeys.publicKey, createdAt: signingKeys.createdAt, retiredAt: signingKeys.retiredAt })
    .from(signingKeys)
    .orderBy(desc(signingKeys.id));
  return rows.map((r) => ({
    id: r.id,
    algorithm: r.algorithm,
    publicKey: r.publicKey,
    createdAt: new Date(r.createdAt).toISOString(),
    retiredAt: r.retiredAt ? new Date(r.retiredAt).toISOString() : null,
  }));
}

/** Sign a content hash. The signed message is the ASCII of the hex digest. */
export async function signHash(contentHash: string, keyId: number): Promise<string> {
  const [row] = await db.select({ sealed: signingKeys.privateKeySealed }).from(signingKeys).where(eq(signingKeys.id, keyId)).limit(1);
  if (!row) throw new Error(`Signing key ${keyId} is missing`);
  const key = createPrivateKey(decryptSecret(row.sealed));
  return cryptoSign(null, Buffer.from(contentHash, "utf8"), key).toString("base64");
}

/** Verify a base64 signature over a hex digest with a PEM/SPKI public key. */
export function verifyHash(contentHash: string, signature: string, publicKeyPem: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(contentHash, "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
  } catch {
    // A malformed key or signature is a failed verification, not a 500.
    return false;
  }
}
