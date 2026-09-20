import { describe, expect, it } from "vitest";
import { chooseVersion, dataCodewords, encodeQr, formatBits, penalty, penaltyScores, qrSvg, reedSolomon, versionBits } from "../../server/auth/qr";

/* ────────────────────────────────────────────────────────────────────────
 * An independent reader.
 *
 * Rather than trusting the encoder's own notion of which modules carry data,
 * this rebuilds the function-pattern map from the specification's description
 * (finder blocks with separators, the two timing lines, alignment patterns, the
 * format and version areas, the always-dark module) and then walks the zigzag,
 * un-masking as it goes. If placement, masking, interleaving or the ECC layout
 * were wrong, the payload would not come back out.
 * ──────────────────────────────────────────────────────────────────────── */

const ALIGNMENT: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Data capacity in codewords, per version, for levels L and M. */
const CAPACITY: Record<"L" | "M", Record<number, number>> = {
  L: { 1: 19, 2: 34, 3: 55, 4: 80, 5: 108, 6: 136, 7: 156, 8: 194, 9: 232, 10: 274 },
  M: { 1: 16, 2: 28, 3: 44, 4: 64, 5: 86, 6: 108, 7: 124, 8: 154, 9: 182, 10: 216 },
};

/** [ec per block, blocks g1, data g1, blocks g2, data g2] */
const BLOCKS: Record<"L" | "M", Record<number, [number, number, number, number, number]>> = {
  L: { 1: [7, 1, 19, 0, 0], 2: [10, 1, 34, 0, 0], 3: [15, 1, 55, 0, 0], 4: [20, 1, 80, 0, 0], 5: [26, 1, 108, 0, 0], 6: [18, 2, 68, 0, 0], 7: [20, 2, 78, 0, 0], 8: [24, 2, 97, 0, 0], 9: [30, 2, 116, 0, 0], 10: [18, 2, 68, 2, 69] },
  M: { 1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0], 4: [18, 2, 32, 0, 0], 5: [24, 2, 43, 0, 0], 6: [16, 4, 27, 0, 0], 7: [18, 4, 31, 0, 0], 8: [22, 2, 38, 2, 39], 9: [22, 3, 36, 2, 37], 10: [26, 4, 43, 1, 44] },
};

function functionMap(version: number): boolean[][] {
  const size = version * 4 + 17;
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const block = (r0: number, c0: number, h: number, w: number) => {
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < size && c < size) map[r][c] = true;
  };
  block(0, 0, 9, 9);
  block(0, size - 8, 9, 8);
  block(size - 8, 0, 8, 9);
  for (let i = 0; i < size; i++) {
    map[6][i] = true;
    map[i][6] = true;
  }
  for (const r of ALIGNMENT[version]) {
    for (const c of ALIGNMENT[version]) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      block(r - 2, c - 2, 5, 5);
    }
  }
  if (version >= 7) {
    block(0, size - 11, 6, 3);
    block(size - 11, 0, 3, 6);
  }
  return map;
}

function readStream(modules: (0 | 1)[][], version: number, mask: number): number[] {
  const size = modules.length;
  const map = functionMap(version);
  const maskAt = MASKS[mask];
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (map[row][col]) continue;
        bits.push(modules[row][col] ^ (maskAt(row, col) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out.push(byte);
  }
  return out;
}

/** Undo the interleave and drop the ECC, leaving the data codewords in order. */
function deinterleave(stream: number[], version: number, level: "L" | "M"): number[] {
  const [, g1, d1, g2, d2] = BLOCKS[level][version];
  const lengths = [...Array(g1).fill(d1), ...Array(g2).fill(d2)] as number[];
  const blocks: number[][] = lengths.map(() => []);
  let index = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) {
    for (let b = 0; b < blocks.length; b++) if (i < lengths[b]) blocks[b].push(stream[index++]);
  }
  return blocks.flat();
}

function decodePayload(text: string, level: "L" | "M"): string {
  const code = encodeQr(text, { level });
  const data = deinterleave(readStream(code.modules, code.version, code.mask), code.version, level);
  const bits = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((b) => (byte >> b) & 1));
  const take = (n: number, from: number) => bits.slice(from, from + n).reduce((acc, bit) => (acc << 1) | bit, 0);
  expect(take(4, 0)).toBe(0b0100); // byte mode
  const countBits = code.version < 10 ? 8 : 16;
  const length = take(countBits, 4);
  const bytes: number[] = [];
  for (let i = 0; i < length; i++) bytes.push(take(8, 4 + countBits + i * 8));
  return Buffer.from(bytes).toString("utf8");
}

describe("Reed–Solomon", () => {
  it("produces the ECC codewords the specification's worked example does", () => {
    // ISO/IEC 18004 Annex I.2: the 1-M example for "01234567".
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(reedSolomon(data, 10)).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });
});

describe("bit fields", () => {
  it("computes the tabulated format information", () => {
    expect(formatBits("M", 0)).toBe(0b101010000010010);
    expect(formatBits("M", 1)).toBe(0b101000100100101);
    expect(formatBits("L", 0)).toBe(0b111011111000100);
    expect(formatBits("L", 1)).toBe(0b111001011110011);
  });

  it("computes the tabulated version information", () => {
    expect(versionBits(7)).toBe(0b000111110010010100);
    expect(versionBits(8)).toBe(0b001000010110111100);
    expect(versionBits(9)).toBe(0b001001101010011001);
    expect(versionBits(10)).toBe(0b001010010011010011);
  });
});

describe("codeword assembly", () => {
  it("writes the header, terminator and alternating pad codewords", () => {
    // "short": 4-bit mode, 8-bit count, five bytes, 4-bit terminator, then EC/11.
    expect(dataCodewords(Buffer.from("short", "utf8"), 1, "L")).toEqual([
      0x40, 0x57, 0x36, 0x86, 0xf7, 0x27, 0x40, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
    ]);
  });

  it("fills the capacity exactly when the payload does", () => {
    for (const level of ["L", "M"] as const) {
      for (const version of [1, 4, 7, 10]) {
        const length = CAPACITY[level][version] - (version < 10 ? 2 : 3);
        const data = dataCodewords(Buffer.alloc(length, 0x41), version, level);
        expect(data).toHaveLength(CAPACITY[level][version]);
        expect(data.at(-1)).not.toBe(0x11); // no pad codeword: the payload reached the end
      }
    }
  });

  it("refuses a payload that does not fit the version it was given", () => {
    expect(() => dataCodewords(Buffer.alloc(200, 0x41), 1, "M")).toThrow(/overflow/i);
  });
});

describe("version choice", () => {
  it("takes the smallest version that holds the payload", () => {
    expect(chooseVersion(14, "M")).toBe(1);
    expect(chooseVersion(15, "M")).toBe(2);
    expect(chooseVersion(17, "L")).toBe(1);
    expect(chooseVersion(18, "L")).toBe(2);
    expect(chooseVersion(213, "M")).toBe(10);
  });

  it("refuses more than version 10 holds", () => {
    expect(() => chooseVersion(400, "M")).toThrow(/version-10/);
  });
});

describe("matrix", () => {
  const code = encodeQr("otpauth://totp/PTD:elena@atelier14.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=PTD&algorithm=SHA1&digits=6&period=30", { level: "M" });

  it("is square, odd-sized, and sized to its version", () => {
    expect(code.size).toBe(code.version * 4 + 17);
    expect(code.modules).toHaveLength(code.size);
    for (const row of code.modules) expect(row).toHaveLength(code.size);
  });

  it("carries three finder patterns and both timing lines", () => {
    const finder = (r: number, c: number) => {
      for (let dr = 0; dr < 7; dr++) {
        for (let dc = 0; dc < 7; dc++) {
          const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
          expect(code.modules[r + dr][c + dc]).toBe(ring === 2 ? 0 : 1);
        }
      }
    };
    finder(0, 0);
    finder(0, code.size - 7);
    finder(code.size - 7, 0);
    for (let i = 8; i < code.size - 8; i++) {
      expect(code.modules[6][i]).toBe(i % 2 === 0 ? 1 : 0);
      expect(code.modules[i][6]).toBe(i % 2 === 0 ? 1 : 0);
    }
    expect(code.modules[code.size - 8][8]).toBe(1); // the always-dark module
  });

  it("picks a mask by score, deterministically, and never a worse one", () => {
    const again = encodeQr("otpauth://totp/PTD:elena@atelier14.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=PTD&algorithm=SHA1&digits=6&period=30", { level: "M" });
    expect(again.mask).toBe(code.mask);
    const chosen = penalty(code.modules);
    for (let mask = 0; mask < 8; mask++) {
      const candidate = encodeQr("otpauth://totp/PTD:elena@atelier14.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=PTD&algorithm=SHA1&digits=6&period=30", { level: "M", mask });
      expect(penalty(candidate.modules)).toBeGreaterThanOrEqual(chosen);
    }
  });
});

describe("penalty", () => {
  const blank = () => Array.from({ length: 21 }, () => new Array(21).fill(0)) as (0 | 1)[][];

  it("scores a blank symbol as runs, blocks and total imbalance", () => {
    const scores = penaltyScores(blank());
    expect(scores.n1).toBe(42 * (21 - 2)); // 21 rows + 21 columns, each one run of 21
    expect(scores.n2).toBe(20 * 20 * 3); // every 2×2 block is one colour
    expect(scores.n3).toBe(0);
    expect(scores.n4).toBe(100); // 0% dark is ten 5% steps from half
    expect(penalty(blank())).toBe(scores.n1 + scores.n2 + scores.n3 + scores.n4);
  });

  it("scores a perfect checkerboard as nothing at all", () => {
    const grid = Array.from({ length: 21 }, (_, r) => Array.from({ length: 21 }, (_, c) => ((r + c) % 2) as 0 | 1));
    expect(penaltyScores(grid)).toEqual({ n1: 0, n2: 0, n3: 0, n4: 0 });
  });

  it("charges forty per finder-lookalike, and only where a light area sits beside it", () => {
    const atEdge = blank();
    for (const [i, bit] of [1, 0, 1, 1, 1, 0, 1].entries()) atEdge[10][i] = bit as 0 | 1;
    expect(penaltyScores(atEdge).n3).toBe(40);

    const inTheMiddle = blank();
    for (const [i, bit] of [1, 0, 1, 1, 1, 0, 1].entries()) inTheMiddle[10][6 + i] = bit as 0 | 1;
    expect(penaltyScores(inTheMiddle).n3).toBe(40);

    const boxedIn = blank();
    for (const [i, bit] of [1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1].entries()) boxedIn[10][3 + i] = bit as 0 | 1;
    expect(penaltyScores(boxedIn).n3).toBe(0);

    const vertical = blank();
    for (const [i, bit] of [1, 0, 1, 1, 1, 0, 1].entries()) vertical[i][10] = bit as 0 | 1;
    expect(penaltyScores(vertical).n3).toBe(40);
  });

  it("scores rule 1 by run length, three for five plus one for each extra", () => {
    const grid = Array.from({ length: 21 }, (_, r) => Array.from({ length: 21 }, (_, c) => ((r + c) % 2) as 0 | 1));
    for (let c = 0; c < 7; c++) grid[10][c] = 1; // one run of seven in an otherwise clean row
    const scores = penaltyScores(grid);
    expect(scores.n1).toBeGreaterThanOrEqual(7 - 2);
  });
});

describe("round trip", () => {
  const payloads: [string, "L" | "M"][] = [
    ["short", "L"],
    ["otpauth://totp/PTD:a@b.test?secret=GEZDGNBVGY3TQOJQ&issuer=PTD&algorithm=SHA1&digits=6&period=30", "M"],
    ["otpauth://totp/PTD:someone.with.a.long.address@a-very-long-domain.example?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=PTD&algorithm=SHA1&digits=6&period=30", "M"],
    ["x".repeat(1), "M"],
    ["y".repeat(120), "L"],
    ["z".repeat(213), "M"],
    ["ünïcödé — a påyload with multibyte characters", "M"],
  ];

  it.each(payloads)("reads back %s at level %s", (text, level) => {
    expect(decodePayload(text, level)).toBe(text);
  });
});

describe("svg", () => {
  const svg = qrSvg("otpauth://totp/PTD:a@b.test?secret=GEZDGNBVGY3TQOJQ", { level: "M", mask: 3 });

  it("is one path on a white rect, with the quiet zone in the viewBox", () => {
    const code = encodeQr("otpauth://totp/PTD:a@b.test?secret=GEZDGNBVGY3TQOJQ", { level: "M", mask: 3 });
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${code.size + 8} ${code.size + 8}"`);
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg.endsWith("</svg>")).toBe(true);
    // One h1v1 square per dark module.
    const dark = code.modules.flat().filter((m) => m === 1).length;
    expect(svg.match(/h1v1h-1z/g)).toHaveLength(dark);
  });
});
