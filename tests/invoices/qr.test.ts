import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import {
  capacity,
  codewordsFor,
  encodeQr,
  fitVersion,
  formatBits,
  MAX_VERSION,
  penalty,
  qrToText,
  rsEncode,
  rsGenerator,
  versionBits,
} from "../../server/invoices/qr";

/**
 * The encoder is checked against ISO/IEC 18004's own published tables rather than
 * against itself: the 32 format strings, the version-information words for
 * versions 7–10, the byte-mode capacity table, and the Reed-Solomon parity of the
 * standard's worked example. Those are values the encoder cannot accidentally
 * agree with.
 *
 * Two golden hashes then pin whole symbols, so a future refactor cannot quietly
 * change the modules. They were produced after checking the matrices
 * module-for-module against an independent encoder (segno) across versions 1–10
 * at both supported error levels.
 */

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

describe("Reed-Solomon over GF(256)", () => {
  it("produces the parity of the standard's worked example", () => {
    // ISO/IEC 18004 Annex I: version 1-M, the sixteen data codewords below.
    const data = Uint8Array.from([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
    expect(hex(rsEncode(data, 10))).toBe("A5 24 D4 C1 ED 36 C7 87 2C 55");
  });

  it("builds a generator polynomial of the requested degree", () => {
    for (const degree of [7, 10, 13, 15, 16, 18, 20, 22, 24, 26, 30]) {
      expect(rsGenerator(degree)).toHaveLength(degree + 1);
      expect(rsGenerator(degree)[0]).toBe(1);
    }
  });

  it("emits exactly `degree` parity codewords", () => {
    expect(rsEncode(Uint8Array.from([1, 2, 3]), 7)).toHaveLength(7);
    expect(rsEncode(new Uint8Array(0), 10)).toHaveLength(10);
  });
});

describe("the published bit tables", () => {
  it("matches all 32 format strings for the two supported levels", () => {
    const L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];
    const M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
    for (let mask = 0; mask < 8; mask += 1) {
      expect(formatBits("L", mask)).toBe(L[mask]);
      expect(formatBits("M", mask)).toBe(M[mask]);
    }
  });

  it("matches the version-information words for the versions that carry them", () => {
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(8)).toBe(0x085bc);
    expect(versionBits(9)).toBe(0x09a99);
    expect(versionBits(10)).toBe(0x0a4d3);
  });
});

describe("capacity", () => {
  it("matches the byte-mode capacity table for versions 1–10", () => {
    const versions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(versions.map((v) => capacity(v, "L"))).toEqual([17, 32, 53, 78, 106, 134, 154, 192, 230, 271]);
    expect(versions.map((v) => capacity(v, "M"))).toEqual([14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
  });

  it("picks the smallest version that fits, and refuses what will not", () => {
    expect(fitVersion(14, "M")).toBe(1);
    expect(fitVersion(15, "M")).toBe(2);
    expect(fitVersion(213, "M")).toBe(10);
    expect(fitVersion(214, "M")).toBeNull();
    expect(fitVersion(271, "L")).toBe(MAX_VERSION);
  });

  it("refuses a payload past the largest supported version rather than truncating it", () => {
    expect(() => encodeQr("x".repeat(400))).toThrow(/will not fit/);
  });
});

describe("codeword assembly", () => {
  it("fills the data capacity exactly, including the alternating pad", () => {
    const spec = [
      { version: 1, ecc: "M" as const, total: 26 },
      { version: 6, ecc: "M" as const, total: 172 },
      { version: 10, ecc: "L" as const, total: 346 },
    ];
    for (const s of spec) {
      expect(codewordsFor(new TextEncoder().encode("hours"), s.version, s.ecc)).toHaveLength(s.total);
    }
  });

  it("starts with the byte-mode indicator and the payload length", () => {
    // 0100 (byte) + 00000101 (5 bytes) + "hours" → 0x40 0x56 ...
    const cw = codewordsFor(new TextEncoder().encode("hours"), 1, "M");
    expect(cw[0]).toBe(0x40);
    expect(cw[1]).toBe(0x56); // 0101 then the high nibble of 'h' (0x68)
  });

  it("pads a short payload with 0xEC / 0x11 alternately", () => {
    const cw = codewordsFor(new TextEncoder().encode("a"), 1, "M");
    // 4 + 8 + 8 = 20 bits + terminator → 3 codewords of content, then pads.
    expect(Array.from(cw.subarray(3, 9))).toEqual([0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
  });
});

describe("encodeQr", () => {
  it("sizes the symbol as 4·version + 17 and reserves the three finders", () => {
    const code = encodeQr("PTD", { ecc: "M" });
    expect(code.size).toBe(code.version * 4 + 17);
    for (const [x, y] of [
      [0, 0],
      [code.size - 7, 0],
      [0, code.size - 7],
    ]) {
      // A finder is a 7×7 ring: dark border, light inset, dark 3×3 core.
      expect(code.modules[y][x]).toBe(true);
      expect(code.modules[y + 1][x + 1]).toBe(false);
      expect(code.modules[y + 3][x + 3]).toBe(true);
    }
  });

  it("keeps the timing patterns and the one always-dark module", () => {
    const code = encodeQr("PTD");
    for (let i = 8; i < code.size - 8; i += 1) {
      expect(code.modules[6][i]).toBe(i % 2 === 0);
      expect(code.modules[i][6]).toBe(i % 2 === 0);
    }
    expect(code.modules[code.size - 8][8]).toBe(true);
  });

  it("searches the masks rather than fixing one", () => {
    const masks = new Set(
      ["PTD", "hours", "https://ptd.example.com/verify/" + "ab".repeat(32), "a", "b", "c", "d", "e", "f", "g"].map((t) => encodeQr(t, { ecc: "M" }).mask)
    );
    // A fixed mask would give one value across ten different payloads.
    expect(masks.size).toBeGreaterThan(1);
    for (const mask of masks) {
      expect(mask).toBeGreaterThanOrEqual(0);
      expect(mask).toBeLessThan(8);
    }
  });

  it("is deterministic — the same URL always draws the same symbol", () => {
    const url = "https://ptd.example.com/verify/" + "ab".repeat(32);
    const a = encodeQr(url, { ecc: "M" });
    const b = encodeQr(url, { ecc: "M" });
    expect(qrToText(a)).toBe(qrToText(b));
  });

  it("matches a golden symbol, checked module-for-module against an independent encoder", () => {
    const url = "https://ptd.example.com/verify/" + "ab".repeat(32);
    const code = encodeQr(url, { ecc: "M" });
    const rows = code.modules.map((r) => r.map((b) => (b ? "1" : "0")).join("")).join("\n");
    expect([code.version, code.mask, code.size]).toEqual([6, 2, 41]);
    expect(createHash("sha256").update(rows).digest("hex")).toBe("6b5c286c3a12b53dee8d16e379d4a7f021fbcd24d07ea3a54d87533297f26d86");
  });

  it("matches a golden version-1 symbol at level L", () => {
    const code = encodeQr("PTD", { ecc: "L" });
    const rows = code.modules.map((r) => r.map((b) => (b ? "1" : "0")).join("")).join("\n");
    expect([code.version, code.mask, code.size]).toEqual([1, 7, 21]);
    expect(createHash("sha256").update(rows).digest("hex")).toBe("ac21f72a9089a2d3fb227d0dbcd6f44974c8946f252b6295084235d905de532f");
  });

  it("carries the whole verification URL a certified invoice needs, at every plausible host length", () => {
    for (const host of ["http://127.0.0.1:3062", "https://ptd.danimoya.com", "https://tracking.a-rather-long-company-name.example.co.uk"]) {
      const url = `${host}/verify/${"c".repeat(64)}`;
      const code = encodeQr(url, { ecc: "M" });
      expect(code.version).toBeLessThanOrEqual(MAX_VERSION);
      expect(code.size).toBe(code.version * 4 + 17);
    }
  });

  it("uses more modules for level M than for level L on the same payload", () => {
    const url = "https://ptd.example.com/verify/" + "ab".repeat(32);
    expect(encodeQr(url, { ecc: "M" }).version).toBeGreaterThanOrEqual(encodeQr(url, { ecc: "L" }).version);
  });

  it("encodes non-ASCII as UTF-8 bytes rather than refusing", () => {
    expect(() => encodeQr("Atelier 14 — hours rendered · €300")).not.toThrow();
  });
});

describe("penalty", () => {
  it("punishes a blank field heavily and a real symbol lightly", () => {
    const blank = Array.from({ length: 21 }, () => new Array(21).fill(false));
    expect(penalty(blank)).toBeGreaterThan(penalty(encodeQr("PTD").modules));
  });
});
