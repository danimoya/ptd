import { describe, expect, it } from "vitest";
import {
  base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hotp, matchRecoveryCode,
  normaliseRecoveryCode, otpauthUri, totp, totpCounter, verifyTotp, TOTP_STEP_SECONDS,
} from "../../server/auth/totp";

/** RFC 4226 Appendix D / RFC 6238 Appendix B both use this ASCII secret. */
const RFC_SECRET = Buffer.from("12345678901234567890", "utf8");
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    for (const bytes of [[], [0], [255], [1, 2, 3], [0xde, 0xad, 0xbe, 0xef], Array.from({ length: 20 }, (_, i) => i * 7)]) {
      const buf = Buffer.from(bytes);
      expect(base32Decode(base32Encode(buf))).toEqual(buf);
    }
  });

  it("matches the RFC 4648 alphabet, unpadded", () => {
    expect(base32Encode(Buffer.from("12345678901234567890", "utf8"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Encode(Buffer.from("foobar", "utf8"))).toBe("MZXW6YTBOI");
  });

  it("is forgiving about case, whitespace and padding on the way in", () => {
    expect(base32Decode("mzxw6ytboi")).toEqual(Buffer.from("foobar", "utf8"));
    expect(base32Decode("MZXW6YTBOI======")).toEqual(Buffer.from("foobar", "utf8"));
    expect(base32Decode("MZXW 6YTB OI")).toEqual(Buffer.from("foobar", "utf8"));
    expect(() => base32Decode("MZXW0YTB")).toThrow();
  });

  it("mints a 160-bit secret by default", () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });
});

describe("HOTP — RFC 4226 Appendix D", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  it.each(expected.map((code, counter) => [counter, code] as const))("counter %i is %s", (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });
});

describe("TOTP — RFC 6238 Appendix B (SHA-1)", () => {
  // The RFC tabulates eight digits; PTD uses six, so the vectors are checked at
  // eight and the six-digit answer is asserted to be their tail.
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  it.each(vectors)("T=%i gives %s", (seconds, code) => {
    const counter = Math.floor(seconds / TOTP_STEP_SECONDS);
    expect(hotp(RFC_SECRET, counter, 8)).toBe(code);
    expect(hotp(RFC_SECRET, counter, 6)).toBe(code.slice(2));
  });

  it("derives the counter from the clock", () => {
    expect(totpCounter(59_000)).toBe(1);
    expect(totpCounter(1111111109_000)).toBe(37037036);
    expect(totp(RFC_SECRET_B32, 59_000)).toBe("287082");
  });
});

describe("verifyTotp", () => {
  const now = 1_700_000_000_000;

  it("accepts the current code", () => {
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now), { atMs: now })).toBe(true);
  });

  it("accepts one step of drift either way, and no more", () => {
    const step = TOTP_STEP_SECONDS * 1000;
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now - step), { atMs: now })).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now + step), { atMs: now })).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now - 2 * step), { atMs: now })).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now + 2 * step), { atMs: now })).toBe(false);
  });

  it("refuses anything that is not six digits", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 345", "０００００"]) {
      expect(verifyTotp(RFC_SECRET_B32, bad, { atMs: now })).toBe(false);
    }
  });

  it("strips punctuation a person might type", () => {
    const code = totp(RFC_SECRET_B32, now);
    expect(verifyTotp(RFC_SECRET_B32, `${code.slice(0, 3)} ${code.slice(3)}`, { atMs: now })).toBe(true);
  });
});

describe("otpauth URI", () => {
  it("is the shape an authenticator app expects", () => {
    const uri = otpauthUri({ issuer: "PTD", account: "elena@atelier14.test", secret: RFC_SECRET_B32 });
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe("otpauth:");
    expect(uri.startsWith("otpauth://totp/PTD:elena%40atelier14.test?")).toBe(true);
    expect(parsed.searchParams.get("secret")).toBe(RFC_SECRET_B32);
    expect(parsed.searchParams.get("issuer")).toBe("PTD");
    expect(parsed.searchParams.get("algorithm")).toBe("SHA1");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
  });
});

describe("recovery codes", () => {
  it("mints ten distinct codes without the characters that get misread", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
      expect(code).not.toMatch(/[oil01]/);
    }
  });

  it("normalises presentation but not content", () => {
    expect(normaliseRecoveryCode(" AB-cde ")).toBe("abcde");
    expect(normaliseRecoveryCode("ab cde")).toBe("abcde");
  });

  it("finds the matching code by index, whatever the punctuation", () => {
    const codes = ["abcde-fghjk", "mnpqr-stuvw"];
    expect(matchRecoveryCode(codes, "ABCDE-FGHJK")).toBe(0);
    expect(matchRecoveryCode(codes, "mnpqrstuvw")).toBe(1);
    expect(matchRecoveryCode(codes, "mnpqr-stuv")).toBe(-1);
    expect(matchRecoveryCode(codes, "")).toBe(-1);
    expect(matchRecoveryCode([], "abcde-fghjk")).toBe(-1);
  });
});
