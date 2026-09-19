import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

// AES-256-GCM for secrets at rest (Slack/GitHub/webhook credentials in org_integrations.config).
// A 256-bit symmetric key keeps its security margin against quantum attackers (Grover halves
// it to 128 bits), which is why this is the one place PTD stores third-party secrets.
function key(): Buffer {
  const raw = process.env.PTD_SECRET_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production") throw new Error("PTD_SECRET_KEY must be set in production");
    return createHash("sha256").update("ptd-dev-secret-key").digest();
  }
  return raw.length === 64 && /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, "hex") : createHash("sha256").update(raw).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function decryptSecret(sealed: string): string {
  const [v, iv, ct, tag] = sealed.split(".");
  if (v !== "v1" || !iv || !ct || !tag) throw new Error("Malformed sealed secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
