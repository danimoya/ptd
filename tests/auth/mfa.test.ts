import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", async () => {
  const { FakeDb } = await import("../track/fake-db");
  return { db: new FakeDb() };
});

import { db } from "../../db";
import { users, type User } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../../server/crypto";
import {
  beginTotpSetup, completeTotpSetup, consumeRecoveryCode, disableTotp, regenerateRecoveryCodes,
  remainingRecoveryCodes, verifyUserTotp,
} from "../../server/auth/mfa";
import { signPurposeJwt, signSessionJwt, verifyPurposeJwt, verifySessionJwt } from "../../server/auth/jwt";
import { base32Decode, totp } from "../../server/auth/totp";
import type { FakeDb } from "../track/fake-db";

const fake = db as unknown as FakeDb;
beforeEach(() => fake.reset());

const user = (over: Partial<User> = {}): User =>
  ({
    id: 7,
    email: "casey@owner.test",
    passwordHash: "$2a$12$whatever",
    displayName: "Casey Owner",
    isAgent: false,
    totpSecretSealed: null,
    totpEnabled: false,
    recoveryCodesSealed: null,
    createdAt: new Date(),
    ...over,
  }) as User;

const lastUpdate = () => fake.updates.at(-1)?.values as Record<string, unknown>;

describe("enrolment", () => {
  it("seals the secret, leaves 2FA off, and hands back a URI and a QR", async () => {
    const enrolment = await beginTotpSetup(user());
    expect(base32Decode(enrolment.secret)).toHaveLength(20);
    expect(enrolment.uri).toContain(`secret=${enrolment.secret}`);
    expect(enrolment.qrSvg.startsWith("<svg")).toBe(true);
    expect(enrolment.digits).toBe(6);
    expect(enrolment.period).toBe(30);

    const written = lastUpdate();
    expect(fake.updates.at(-1)?.table).toBe(users);
    expect(written.totpEnabled).toBeUndefined(); // enrolment alone must not enable it
    expect(String(written.totpSecretSealed)).not.toContain(enrolment.secret);
    expect(decryptSecret(String(written.totpSecretSealed))).toBe(enrolment.secret);
  });

  it("turns 2FA on only for a code the secret actually produces, and then mints ten codes", async () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const pending = user({ totpSecretSealed: encryptSecret(secret) });

    expect(await completeTotpSetup(pending, "000000")).toEqual({ ok: false, reason: "bad_code" });
    expect(fake.updates).toHaveLength(0);

    const outcome = await completeTotpSetup(pending, totp(secret));
    expect(outcome.ok).toBe(true);
    expect(outcome.recoveryCodes).toHaveLength(10);
    const written = lastUpdate();
    expect(written.totpEnabled).toBe(true);
    expect(JSON.parse(decryptSecret(String(written.recoveryCodesSealed)))).toEqual(outcome.recoveryCodes);
  });

  it("refuses when there is no enrolment in progress, or when it is already on", async () => {
    expect(await completeTotpSetup(user(), "123456")).toEqual({ ok: false, reason: "no_secret" });
    expect(await completeTotpSetup(user({ totpEnabled: true }), "123456")).toEqual({ ok: false, reason: "already_enabled" });
  });

  it("treats a secret it can no longer decrypt as no secret, rather than locking the account", async () => {
    const enrolled = user({ totpSecretSealed: "v1.not.valid.ciphertext", totpEnabled: true });
    expect(verifyUserTotp(enrolled, "123456")).toBe(false);
    expect(await completeTotpSetup(user({ totpSecretSealed: "v1.nope.nope.nope" }), "123456")).toEqual({ ok: false, reason: "no_secret" });
  });
});

describe("recovery codes", () => {
  const codes = ["aaaaa-bbbbb", "ccccc-ddddd", "eeeee-fffff"];
  const enrolled = () => user({ totpEnabled: true, totpSecretSealed: encryptSecret("GEZDGNBVGY3TQOJQ"), recoveryCodesSealed: encryptSecret(JSON.stringify(codes)) });

  it("counts what is left", () => {
    expect(remainingRecoveryCodes(enrolled())).toBe(3);
    expect(remainingRecoveryCodes(user())).toBe(0);
    expect(remainingRecoveryCodes(user({ recoveryCodesSealed: encryptSecret("not an array") }))).toBe(0);
  });

  it("spends one and rewrites the list without it", async () => {
    expect(await consumeRecoveryCode(enrolled(), "CCCCC-DDDDD")).toBe(true);
    expect(JSON.parse(decryptSecret(String(lastUpdate().recoveryCodesSealed)))).toEqual(["aaaaa-bbbbb", "eeeee-fffff"]);
  });

  it("clears the column when the last one is spent", async () => {
    const one = user({ totpEnabled: true, recoveryCodesSealed: encryptSecret(JSON.stringify(["aaaaa-bbbbb"])) });
    expect(await consumeRecoveryCode(one, "aaaaa bbbbb")).toBe(true);
    expect(lastUpdate().recoveryCodesSealed).toBeNull();
  });

  it("refuses a code that is not on the list, and writes nothing", async () => {
    expect(await consumeRecoveryCode(enrolled(), "zzzzz-yyyyy")).toBe(false);
    expect(await consumeRecoveryCode(user(), "aaaaa-bbbbb")).toBe(false);
    expect(fake.updates).toHaveLength(0);
  });

  it("replaces the whole set on request", async () => {
    const fresh = await regenerateRecoveryCodes(enrolled());
    expect(fresh).toHaveLength(10);
    expect(JSON.parse(decryptSecret(String(lastUpdate().recoveryCodesSealed)))).toEqual(fresh);
  });
});

describe("turning it off", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const enrolled = () => user({ totpEnabled: true, totpSecretSealed: encryptSecret(secret), recoveryCodesSealed: encryptSecret(JSON.stringify(["aaaaa-bbbbb"])) });

  it("needs a live code, and then clears every trace", async () => {
    expect(await disableTotp(enrolled(), totp(secret))).toEqual({ ok: true });
    expect(lastUpdate()).toMatchObject({ totpEnabled: false, totpSecretSealed: null, recoveryCodesSealed: null });
  });

  it("accepts a recovery code too, for the case the device is gone", async () => {
    expect(await disableTotp(enrolled(), "aaaaa-bbbbb")).toEqual({ ok: true });
    expect(lastUpdate()).toMatchObject({ totpEnabled: false, totpSecretSealed: null });
  });

  it("refuses a wrong code, and refuses when it is not on", async () => {
    expect(await disableTotp(enrolled(), "000000")).toEqual({ ok: false, reason: "bad_code" });
    expect(await disableTotp(user(), "000000")).toEqual({ ok: false, reason: "not_enabled" });
  });
});

describe("the pre-auth token is not a session", () => {
  it("is rejected by the session verifier, and the session token by the purpose verifier", () => {
    const preAuth = signPurposeJwt(7, "mfa");
    expect(() => verifySessionJwt(preAuth)).toThrow(/not a session token/);
    expect(verifyPurposeJwt(preAuth, "mfa")).toEqual({ id: 7 });

    const session = signSessionJwt(7);
    expect(verifySessionJwt(session)).toEqual({ id: 7 });
    expect(verifyPurposeJwt(session, "mfa")).toBeNull();
  });

  it("expires, and a forged one is refused", () => {
    const expired = signPurposeJwt(7, "mfa", -1);
    expect(verifyPurposeJwt(expired, "mfa")).toBeNull();
    expect(verifyPurposeJwt("not.a.jwt", "mfa")).toBeNull();
    const [header, payload] = signPurposeJwt(7, "mfa").split(".");
    expect(verifyPurposeJwt(`${header}.${payload}.forged-signature`, "mfa")).toBeNull();
  });
});
