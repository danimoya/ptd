/**
 * A QR encoder in one file, with no dependencies.
 *
 * A certified invoice has to carry its verification URL in a form a phone can
 * read off paper, which means a QR code; and a PDF that anyone may open must not
 * drag a transitive image/encoder dependency into the server. So the encoder is
 * written out here: byte mode, error-correction levels L and M, versions 1–10,
 * which is every size a `https://host/verify/<64 hex>` URL can need (version 10
 * at level M holds 216 bytes; the URL is under a hundred).
 *
 * The pipeline is the one in ISO/IEC 18004:
 *
 *   bytes → mode + length + payload bits → pad → split into blocks →
 *   Reed-Solomon parity per block → interleave → place on the matrix →
 *   try all eight masks, keep the one with the lowest penalty → format/version bits.
 *
 * Everything is integer arithmetic over GF(256) with the standard primitive
 * polynomial 0x11D, so the output is byte-for-byte reproducible: the same URL
 * always produces the same modules, which matters because the QR is printed onto
 * a document whose bytes are hashed.
 */

/* ── GF(256) ─────────────────────────────────────────────────────────── */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial for `degree` error-correction codewords. */
export function rsGenerator(degree: number): Uint8Array {
  let poly = Uint8Array.from([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** The `degree` parity codewords for one data block. */
export function rsEncode(data: Uint8Array, degree: number): Uint8Array {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < degree; i += 1) rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

/* ── Capacity tables (versions 1–10, levels L and M) ─────────────────── */

export type Ecc = "L" | "M";

interface Spec {
  /** Error-correction codewords per block. */
  ec: number;
  /** [blocks, data codewords per block] for the first group. */
  g1: [number, number];
  /** Same for the second group, when the version splits blocks unevenly. */
  g2?: [number, number];
}

const SPECS: Record<Ecc, Record<number, Spec>> = {
  L: {
    1: { ec: 7, g1: [1, 19] },
    2: { ec: 10, g1: [1, 34] },
    3: { ec: 15, g1: [1, 55] },
    4: { ec: 20, g1: [1, 80] },
    5: { ec: 26, g1: [1, 108] },
    6: { ec: 18, g1: [2, 68] },
    7: { ec: 20, g1: [2, 78] },
    8: { ec: 24, g1: [2, 97] },
    9: { ec: 30, g1: [2, 116] },
    10: { ec: 18, g1: [2, 68], g2: [2, 69] },
  },
  M: {
    1: { ec: 10, g1: [1, 16] },
    2: { ec: 16, g1: [1, 28] },
    3: { ec: 26, g1: [1, 44] },
    4: { ec: 18, g1: [2, 32] },
    5: { ec: 24, g1: [2, 43] },
    6: { ec: 16, g1: [4, 27] },
    7: { ec: 18, g1: [4, 31] },
    8: { ec: 22, g1: [2, 38], g2: [2, 39] },
    9: { ec: 22, g1: [3, 36], g2: [2, 37] },
    10: { ec: 26, g1: [4, 43], g2: [1, 44] },
  },
};

export const MAX_VERSION = 10;

/** Centres of the alignment patterns, per version. */
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const dataCodewords = (spec: Spec): number => spec.g1[0] * spec.g1[1] + (spec.g2 ? spec.g2[0] * spec.g2[1] : 0);

/** Bits the character-count indicator takes in byte mode. */
const countBits = (version: number): number => (version < 10 ? 8 : 16);

/** Payload bytes a version/level pair can carry in byte mode. */
export function capacity(version: number, ecc: Ecc): number {
  const spec = SPECS[ecc][version];
  if (!spec) return 0;
  return Math.floor((dataCodewords(spec) * 8 - 4 - countBits(version)) / 8);
}

/** The smallest version that fits `length` bytes, or null past version 10. */
export function fitVersion(length: number, ecc: Ecc): number | null {
  for (let v = 1; v <= MAX_VERSION; v += 1) if (capacity(v, ecc) >= length) return v;
  return null;
}

/* ── Bit stream ──────────────────────────────────────────────────────── */

class Bits {
  private bits: number[] = [];

  push(value: number, length: number) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  /** Terminator, byte alignment and the alternating 0xEC/0x11 pad. */
  toCodewords(total: number): Uint8Array {
    const capacityBits = total * 8;
    for (let i = 0; i < 4 && this.bits.length < capacityBits; i += 1) this.bits.push(0);
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const out = new Uint8Array(total);
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | this.bits[i + j];
      out[i / 8] = byte;
    }
    for (let i = this.bits.length / 8, pad = 0; i < total; i += 1, pad += 1) out[i] = pad % 2 === 0 ? 0xec : 0x11;
    return out;
  }
}

/** Data codewords and parity, split into blocks and interleaved as the spec requires. */
export function codewordsFor(payload: Uint8Array, version: number, ecc: Ecc): Uint8Array {
  const spec = SPECS[ecc][version];
  if (!spec) throw new Error(`QR version ${version} level ${ecc} is not supported`);
  const bits = new Bits();
  bits.push(0b0100, 4); // byte mode
  bits.push(payload.length, countBits(version));
  for (const byte of payload) bits.push(byte, 8);
  const data = bits.toCodewords(dataCodewords(spec));

  const groups: Uint8Array[] = [];
  let offset = 0;
  for (const [count, size] of [spec.g1, spec.g2 ?? [0, 0]] as [number, number][]) {
    for (let i = 0; i < count; i += 1) {
      groups.push(data.subarray(offset, offset + size));
      offset += size;
    }
  }
  const parity = groups.map((block) => rsEncode(block, spec.ec));

  const out: number[] = [];
  const longest = Math.max(...groups.map((g) => g.length));
  for (let i = 0; i < longest; i += 1) for (const block of groups) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < spec.ec; i += 1) for (const block of parity) out.push(block[i]);
  return Uint8Array.from(out);
}

/* ── BCH bits ────────────────────────────────────────────────────────── */

/** Format information: 2 bits of level, 3 of mask, BCH(15,5), masked with 0x5412. */
export function formatBits(ecc: Ecc, mask: number): number {
  const level = ecc === "L" ? 0b01 : 0b00;
  const data = (level << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

/** Version information, BCH(18,6). Only versions 7 and up carry it. */
export function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i -= 1) if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
  return (version << 12) | rem;
}

/* ── Matrix ──────────────────────────────────────────────────────────── */

export interface QrCode {
  version: number;
  ecc: Ecc;
  size: number;
  mask: number;
  /** `modules[y][x]` — true is a dark module. */
  modules: boolean[][];
}

const FINDER = (m: boolean[][], reserved: boolean[][], x: number, y: number) => {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const px = x + dx;
      const py = y + dy;
      if (py < 0 || py >= m.length || px < 0 || px >= m.length) continue;
      const edge = dx === -1 || dx === 7 || dy === -1 || dy === 7;
      const ring = dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      m[py][px] = !edge && (ring || core);
      reserved[py][px] = true;
    }
  }
};

function skeleton(version: number): { modules: boolean[][]; reserved: boolean[][] } {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  FINDER(modules, reserved, 0, 0);
  FINDER(modules, reserved, size - 7, 0);
  FINDER(modules, reserved, 0, size - 7);

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    modules[6][i] = dark;
    reserved[6][i] = true;
    modules[i][6] = dark;
    reserved[i][6] = true;
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centres = ALIGNMENT[version] ?? [];
  for (const cy of centres) {
    for (const cx of centres) {
      const onFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
      if (onFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          modules[cy + dy][cx + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          reserved[cy + dy][cx + dx] = true;
        }
      }
    }
  }

  // Format-information areas and the dark module.
  for (let i = 0; i < 9; i += 1) {
    if (!reserved[8][i]) reserved[8][i] = true;
    if (!reserved[i][8]) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  modules[size - 8][8] = true;
  reserved[size - 8][8] = true;

  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      reserved[b][a] = true;
      reserved[a][b] = true;
    }
  }

  return { modules, reserved };
}

/** The zig-zag walk: two columns at a time, right to left, skipping column 6. */
function placeData(modules: boolean[][], reserved: boolean[][], codewords: Uint8Array) {
  const size = modules.length;
  let bit = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    const col = right === 6 ? 5 : right; // column 6 is the vertical timing pattern
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (const x of [col, col - 1]) {
        if (reserved[y][x]) continue;
        const byte = codewords[bit >> 3];
        modules[y][x] = byte !== undefined && ((byte >> (7 - (bit & 7))) & 1) === 1;
        bit += 1;
      }
    }
    upward = !upward;
    if (col === 5) right -= 1; // the skipped column has already been consumed
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const FINDER_RUN = [true, false, true, true, true, false, true];

/** The four penalty rules of ISO/IEC 18004 §8.8.2, summed. */
export function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) {
        run += 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
    // N3: the 1:1:3:1:1 finder-like run with four light modules on either side.
    for (let i = 0; i + 6 < size; i += 1) {
      let hit = true;
      for (let j = 0; j < 7; j += 1) if (get(i + j) !== FINDER_RUN[j]) hit = false;
      if (!hit) continue;
      const before = [i - 4, i - 3, i - 2, i - 1].every((k) => k < 0 || !get(k));
      const after = [i + 7, i + 8, i + 9, i + 10].every((k) => k >= size || !get(k));
      if (before || after) score += 40;
    }
  };

  for (let y = 0; y < size; y += 1) line((x) => modules[y][x]);
  for (let x = 0; x < size; x += 1) line((y) => modules[y][x]);

  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) dark += 1;
      if (y + 1 < size && x + 1 < size) {
        const a = modules[y][x];
        if (a === modules[y][x + 1] && a === modules[y + 1][x] && a === modules[y + 1][x + 1]) score += 3;
      }
    }
  }

  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

function writeFormat(modules: boolean[][], ecc: Ecc, mask: number) {
  const size = modules.length;
  const bits = formatBits(ecc, mask);
  const at = (i: number) => ((bits >> i) & 1) === 1;
  // First copy, wrapped around the top-left finder.
  for (let i = 0; i <= 5; i += 1) modules[i][8] = at(i);
  modules[7][8] = at(6);
  modules[8][8] = at(7);
  modules[8][7] = at(8);
  for (let i = 9; i <= 14; i += 1) modules[8][14 - i] = at(i);
  // Second copy, split between the other two finders.
  for (let i = 0; i <= 7; i += 1) modules[8][size - 1 - i] = at(i);
  for (let i = 8; i <= 14; i += 1) modules[size - 15 + i][8] = at(i);
  // The one module that is dark in every symbol.
  modules[size - 8][8] = true;
}

function writeVersion(modules: boolean[][], version: number) {
  if (version < 7) return;
  const size = modules.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const on = ((bits >> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + size - 11;
    modules[b][a] = on;
    modules[a][b] = on;
  }
}

/**
 * Encode `text` as a QR code. Level M by default — a printed invoice gets
 * folded, and M tolerates 15% damage against L's 7%.
 */
export function encodeQr(text: string, opts: { ecc?: Ecc; minVersion?: number } = {}): QrCode {
  const ecc = opts.ecc ?? "M";
  const payload = new TextEncoder().encode(text);
  const fitted = fitVersion(payload.length, ecc);
  if (fitted === null) {
    throw new Error(`${payload.length} bytes will not fit in a version-${MAX_VERSION} QR at level ${ecc}`);
  }
  const version = Math.max(fitted, opts.minVersion ?? 1);
  const codewords = codewordsFor(payload, version, ecc);

  let best: QrCode | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const { modules, reserved } = skeleton(version);
    placeData(modules, reserved, codewords);
    const fn = MASKS[mask];
    for (let y = 0; y < modules.length; y += 1) {
      for (let x = 0; x < modules.length; x += 1) if (!reserved[y][x] && fn(x, y)) modules[y][x] = !modules[y][x];
    }
    writeFormat(modules, ecc, mask);
    writeVersion(modules, version);
    const score = penalty(modules);
    if (score < bestScore) {
      bestScore = score;
      best = { version, ecc, size: modules.length, mask, modules };
    }
  }
  return best!;
}

/** Debug/test rendering: one character per module, two columns wide so it is square. */
export function qrToText(code: QrCode, dark = "██", light = "  "): string {
  return code.modules.map((row) => row.map((on) => (on ? dark : light)).join("")).join("\n");
}
