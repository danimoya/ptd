import { describe, expect, it } from "vitest";
import {
  ACCESS_TTL_MS, CODE_TTL_MS, REFRESH_TTL_MS,
  hashOpaque, hashSecret, isValidChallenge, isValidVerifier, newClientId, newRefreshToken,
  s256, safeEqual, verifyPkce, verifySecret,
} from "../../server/oauth/pkce";

// RFC 7636 appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("S256", () => {
  it("reproduces the RFC 7636 test vector", () => {
    expect(s256(VERIFIER)).toBe(CHALLENGE);
  });

  it("verifies a matching verifier and rejects a wrong one", () => {
    expect(verifyPkce(VERIFIER, CHALLENGE)).toBe(true);
    expect(verifyPkce(`${VERIFIER.slice(0, -1)}X`, CHALLENGE)).toBe(false);
  });

  it("refuses the plain method, even when verifier === challenge", () => {
    const plain = "a".repeat(43);
    expect(verifyPkce(plain, plain, "plain")).toBe(false);
    expect(verifyPkce(plain, plain, "S256")).toBe(false);
  });

  it("refuses a verifier outside 43–128 unreserved characters", () => {
    expect(isValidVerifier("short")).toBe(false);
    expect(isValidVerifier("a".repeat(43))).toBe(true);
    expect(isValidVerifier("a".repeat(128))).toBe(true);
    expect(isValidVerifier("a".repeat(129))).toBe(false);
    expect(isValidVerifier(`${"a".repeat(42)}/`)).toBe(false);
    expect(isValidVerifier(undefined)).toBe(false);
  });

  it("applies the same shape rule to a challenge", () => {
    expect(isValidChallenge(CHALLENGE)).toBe(true);
    expect(isValidChallenge("")).toBe(false);
    expect(isValidChallenge("nope")).toBe(false);
  });
});

describe("safeEqual", () => {
  it("compares equal and unequal strings without throwing on length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcdef")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("opaque token hashing", () => {
  it("is deterministic, so a refresh token row can be found by its token", () => {
    const token = newRefreshToken();
    expect(hashOpaque(token)).toBe(hashOpaque(token));
    expect(hashOpaque(token)).not.toBe(hashOpaque(newRefreshToken()));
    expect(hashOpaque(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never stores the token itself", () => {
    const token = newRefreshToken();
    expect(hashOpaque(token)).not.toContain(token.slice(5));
  });

  it("mints distinguishable, prefixed identifiers", () => {
    expect(newRefreshToken()).toMatch(/^ptdr_[0-9a-f]{48}$/);
    expect(newClientId()).toMatch(/^ptdc_[0-9a-f]{32}$/);
    expect(newClientId()).not.toBe(newClientId());
  });
});

describe("client secrets", () => {
  it("round-trips through salted scrypt and rejects a wrong secret", async () => {
    const stored = await hashSecret("s3cret");
    expect(stored).toMatch(/^[0-9a-f]{128}\.[0-9a-f]{32}$/);
    expect(await verifySecret("s3cret", stored)).toBe(true);
    expect(await verifySecret("s3cre7", stored)).toBe(false);
    expect(await verifySecret("s3cret", "garbage")).toBe(false);
  });

  it("salts per row, so two clients with the same secret do not collide", async () => {
    expect(await hashSecret("same")).not.toBe(await hashSecret("same"));
  });
});

describe("lifetimes", () => {
  it("are the ones the metadata advertises", () => {
    expect(ACCESS_TTL_MS).toBe(3_600_000);
    expect(CODE_TTL_MS).toBe(600_000);
    expect(REFRESH_TTL_MS).toBe(30 * 86_400_000);
  });
});
