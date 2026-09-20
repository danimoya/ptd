/**
 * A QR encoder, byte mode, versions 1–10, error-correction levels L and M.
 *
 * Scope on purpose: the only thing PTD ever draws as a QR code is an
 * `otpauth://` URI of 80–160 characters, which fits comfortably inside version
 * 10-M (213 bytes). Everything a larger code would need — kanji mode, ECI,
 * structured append, versions with two alignment-pattern rows — is absent
 * rather than half-implemented, so the file stays readable and testable.
 *
 * Implements ISO/IEC 18004: Reed–Solomon over GF(256) with the primitive
 * polynomial 0x11D, block interleaving, the eight data masks scored by the four
 * penalty rules, BCH(15,5) format information and BCH(18,6) version information.
 * Output is an SVG, because a `<svg>` needs no image pipeline and prints well.
 */

export type EccLevel = "L" | "M";

/** [ec codewords per block, blocks in group 1, data per block, blocks in group 2, data per block] */
type Spec = [number, number, number, number, number];

const SPECS: Record<EccLevel, Record<number, Spec>> = {
  L: {
    1: [7, 1, 19, 0, 0],
    2: [10, 1, 34, 0, 0],
    3: [15, 1, 55, 0, 0],
    4: [20, 1, 80, 0, 0],
    5: [26, 1, 108, 0, 0],
    6: [18, 2, 68, 0, 0],
    7: [20, 2, 78, 0, 0],
    8: [24, 2, 97, 0, 0],
    9: [30, 2, 116, 0, 0],
    10: [18, 2, 68, 2, 69],
  },
  M: {
    1: [10, 1, 16, 0, 0],
    2: [16, 1, 28, 0, 0],
    3: [26, 1, 44, 0, 0],
    4: [18, 2, 32, 0, 0],
    5: [24, 2, 43, 0, 0],
    6: [16, 4, 27, 0, 0],
    7: [18, 4, 31, 0, 0],
    8: [22, 2, 38, 2, 39],
    9: [22, 3, 36, 2, 37],
    10: [26, 4, 43, 1, 44],
  },
};

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

/** Level bits as they appear in the format information field. */
const LEVEL_BITS: Record<EccLevel, number> = { L: 0b01, M: 0b00 };

export const MAX_VERSION = 10;

/* ── GF(256) ─────────────────────────────────────────────────────────── */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** The RS generator polynomial of the given degree, coefficients high-order first. */
function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Remainder of data·x^degree divided by the generator — the EC codewords. */
export function reedSolomon(data: number[], ecCount: number): number[] {
  const gen = generatorPoly(ecCount);
  const remainder = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) remainder[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return remainder;
}

/* ── BCH ─────────────────────────────────────────────────────────────── */

function bch(value: number, generator: number, dataBits: number, totalBits: number): number {
  let rest = value << (totalBits - dataBits);
  const genBits = 32 - Math.clz32(generator);
  while (32 - Math.clz32(rest) >= genBits) rest ^= generator << (32 - Math.clz32(rest) - genBits);
  return (value << (totalBits - dataBits)) | rest;
}

/** 15 bits: 5 data (level + mask), BCH generator 0x537, XORed with 0x5412. */
export function formatBits(level: EccLevel, mask: number): number {
  return bch((LEVEL_BITS[level] << 3) | mask, 0x537, 5, 15) ^ 0x5412;
}

/** 18 bits: 6 data (version), BCH generator 0x1f25. Only versions ≥ 7 carry it. */
export function versionBits(version: number): number {
  return bch(version, 0x1f25, 6, 18);
}

/* ── Bit stream ──────────────────────────────────────────────────────── */

class BitBuffer {
  readonly bits: number[] = [];
  put(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
}

function dataCapacity(version: number, level: EccLevel): number {
  const [, g1, d1, g2, d2] = SPECS[level][version];
  return g1 * d1 + g2 * d2;
}

/** The smallest version that holds `byteLength` bytes in byte mode. */
export function chooseVersion(byteLength: number, level: EccLevel): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const countBits = version < 10 ? 8 : 16;
    if (dataCapacity(version, level) * 8 >= 4 + countBits + byteLength * 8) return version;
  }
  throw new Error(`Payload of ${byteLength} bytes does not fit in a version-${MAX_VERSION} QR code`);
}

/** The data codewords: header, payload, terminator, byte padding, pad codewords. */
export function dataCodewords(data: Buffer, version: number, level: EccLevel): number[] {
  const capacity = dataCapacity(version, level);
  const countBits = version < 10 ? 8 : 16;
  const bb = new BitBuffer();
  bb.put(0b0100, 4); // byte mode
  bb.put(data.length, countBits);
  for (const byte of data) bb.put(byte, 8);

  const limit = capacity * 8;
  if (bb.length > limit) throw new Error("QR payload overflows the chosen version");
  bb.put(0, Math.min(4, limit - bb.length)); // terminator
  while (bb.length % 8 !== 0) bb.bits.push(0);

  const out: number[] = [];
  for (let i = 0; i < bb.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb.bits[i + j];
    out.push(byte);
  }
  const pad = [0xec, 0x11];
  for (let i = 0; out.length < capacity; i++) out.push(pad[i % 2]);
  return out;
}

/** Split into blocks, append each block's EC codewords, interleave both runs. */
function interleave(data: number[], version: number, level: EccLevel): number[] {
  const [ecCount, g1, d1, g2, d2] = SPECS[level][version];
  const blocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < g1; i++) {
    blocks.push(data.slice(offset, offset + d1));
    offset += d1;
  }
  for (let i = 0; i < g2; i++) {
    blocks.push(data.slice(offset, offset + d2));
    offset += d2;
  }
  const ecBlocks = blocks.map((b) => reedSolomon(b, ecCount));

  const out: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) for (const block of blocks) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < ecCount; i++) for (const block of ecBlocks) out.push(block[i]);
  return out;
}

/* ── Matrix ──────────────────────────────────────────────────────────── */

type Cell = 0 | 1;

interface Grid {
  size: number;
  modules: Cell[][];
  reserved: boolean[][];
}

function blank(version: number): Grid {
  const size = version * 4 + 17;
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<Cell>(size).fill(0)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function set(grid: Grid, row: number, col: number, value: Cell, reserve = true) {
  grid.modules[row][col] = value;
  if (reserve) grid.reserved[row][col] = true;
}

function placeFinder(grid: Grid, row: number, col: number) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= grid.size || cc >= grid.size) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(grid, rr, cc, inRing || inCore ? 1 : 0);
    }
  }
}

function placeAlignment(grid: Grid, version: number) {
  const centres = ALIGNMENT[version];
  for (const r of centres) {
    for (const c of centres) {
      // Skip the three that would collide with a finder pattern.
      if ((r === 6 && c === 6) || (r === 6 && c === grid.size - 7) || (r === grid.size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          set(grid, r + dr, c + dc, ring === 1 ? 0 : 1);
        }
      }
    }
  }
}

function placeTiming(grid: Grid) {
  for (let i = 8; i < grid.size - 8; i++) {
    const value: Cell = i % 2 === 0 ? 1 : 0;
    set(grid, 6, i, value);
    set(grid, i, 6, value);
  }
}

function reserveFormat(grid: Grid, version: number) {
  for (let i = 0; i < 9; i++) {
    if (i !== 6) set(grid, 8, i, 0);
    if (i !== 6) set(grid, i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    set(grid, 8, grid.size - 1 - i, 0);
    set(grid, grid.size - 1 - i, 8, 0);
  }
  set(grid, grid.size - 8, 8, 1); // the always-dark module
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      set(grid, Math.floor(i / 3), grid.size - 11 + (i % 3), 0);
      set(grid, grid.size - 11 + (i % 3), Math.floor(i / 3), 0);
    }
  }
}

/**
 * The 15 format bits, twice: down the left of the top-left finder and along the
 * top of the bottom-left one (copy 1), then across row 8 from the right and
 * around the corner (copy 2). Bit 0 is the least significant.
 */
function writeFormat(grid: Grid, level: EccLevel, mask: number) {
  const bits = formatBits(level, mask);
  const last = grid.size - 1;
  for (let i = 0; i < 15; i++) {
    const bit: Cell = ((bits >> i) & 1) as Cell;
    // Copy 1 — column 8 downwards, then the bottom-left strip.
    if (i < 6) set(grid, i, 8, bit);
    else if (i < 8) set(grid, i + 1, 8, bit);
    else set(grid, grid.size - 15 + i, 8, bit);
    // Copy 2 — row 8 from the right edge, then back to the top-left corner.
    if (i < 8) set(grid, 8, last - i, bit);
    else if (i === 8) set(grid, 8, 7, bit);
    else set(grid, 8, 14 - i, bit);
  }
}

function writeVersion(grid: Grid, version: number) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit: Cell = ((bits >> i) & 1) as Cell;
    const row = Math.floor(i / 3);
    const col = grid.size - 11 + (i % 3);
    set(grid, row, col, bit);
    set(grid, col, row, bit);
  }
}

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** The upward/downward zigzag from the bottom-right corner, column 6 skipped. */
function placeData(grid: Grid, stream: number[], mask: number) {
  let bitIndex = 0;
  let upward = true;
  for (let right = grid.size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < grid.size; step++) {
      const row = upward ? grid.size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (grid.reserved[row][col]) continue;
        const byte = stream[bitIndex >> 3] ?? 0;
        let bit: Cell = ((byte >> (7 - (bitIndex & 7))) & 1) as Cell;
        if (maskAt(mask, row, col)) bit = (bit ^ 1) as Cell;
        grid.modules[row][col] = bit;
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

/** The 1:1:3:1:1 finder-lookalike, dark:light:dark×3:light:dark. */
const N3_PATTERN: Cell[] = [1, 0, 1, 1, 1, 0, 1];

function findPattern(seq: Cell[], from: number): number {
  outer: for (let i = from; i + 7 <= seq.length; i++) {
    for (let j = 0; j < 7; j++) if (seq[i + j] !== N3_PATTERN[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Rule 3, counted the way ISO/IEC 18004:2015 words it: the 1:1:3:1:1 pattern
 * penalised when a four-module light area sits on *either* side of it — and the
 * quiet zone outside the symbol counts as that light area, which is why a match
 * flush against an edge scores too. (The 11-module fixed patterns some encoders
 * match instead miss exactly those edge cases.)
 */
function n3Occurrences(seq: Cell[]): number {
  const size = seq.length;
  let count = 0;
  let idx = findPattern(seq, 0);
  while (idx !== -1) {
    let next = idx + 7;
    const darkBefore = seq.slice(Math.max(idx - 4, 0), idx).some((b) => b === 1);
    const darkAfter = seq.slice(idx + 7, Math.min(idx + 11, size)).some((b) => b === 1);
    if (idx === 0 || idx === size - 7 || !darkBefore || !darkAfter) count += 40;
    else next = idx + 4;
    idx = findPattern(seq, next);
  }
  return count;
}

export interface PenaltyScores {
  /** Runs of five or more modules of one colour: 3 + (length − 5). */
  n1: number;
  /** Every 2×2 block of one colour: 3 each. */
  n2: number;
  /** Finder-lookalikes beside a light area: 40 each. */
  n3: number;
  /** Dark proportion away from half, in 5% steps: 10 each. */
  n4: number;
}

/**
 * ISO/IEC 18004 §7.8.3 Table 11, rule by rule. Exposed separately from the sum
 * so a test can pin each rule to a matrix it can reason about, rather than
 * asserting one opaque total.
 */
export function penaltyScores(modules: Cell[][]): PenaltyScores {
  const size = modules.length;
  let score = 0;

  // Rule 1 — runs of five or more of one colour, in both directions.
  const runs = (get: (a: number, b: number) => Cell) => {
    for (let a = 0; a < size; a++) {
      let length = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) length++;
        else {
          if (length >= 5) score += length - 2;
          length = 1;
        }
      }
      if (length >= 5) score += length - 2;
    }
  };
  runs((r, c) => modules[r][c]);
  runs((c, r) => modules[r][c]);

  const n1 = score;
  score = 0;

  // Rule 2 — every 2×2 block of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }

  const n2 = score;
  score = 0;

  // Rule 3 — finder-lookalikes, row-wise and column-wise.
  for (let i = 0; i < size; i++) {
    score += n3Occurrences(modules[i]);
    score += n3Occurrences(modules.map((row) => row[i]));
  }
  const n3 = score;

  // Rule 4 — how far the dark proportion strays from half, in 5% steps.
  let dark = 0;
  for (const row of modules) for (const cell of row) dark += cell;
  const percent = (dark * 100) / (size * size);
  const n4 = Math.floor(Math.abs(percent - 50) / 5) * 10;

  return { n1, n2, n3, n4 };
}

/** The four rules, summed — what mask selection minimises. */
export function penalty(modules: Cell[][]): number {
  const { n1, n2, n3, n4 } = penaltyScores(modules);
  return n1 + n2 + n3 + n4;
}

export interface QrOptions {
  level?: EccLevel;
  /** Fix the mask (0–7) instead of scoring all eight. Tests use it; callers do not. */
  mask?: number;
  version?: number;
}

export interface QrCode {
  version: number;
  level: EccLevel;
  mask: number;
  size: number;
  modules: Cell[][];
}

/** Encode a string (UTF-8, byte mode) into a module matrix. */
export function encodeQr(text: string, opts: QrOptions = {}): QrCode {
  const level = opts.level ?? "M";
  const data = Buffer.from(text, "utf8");
  const version = opts.version ?? chooseVersion(data.length, level);
  const stream = interleave(dataCodewords(data, version, level), version, level);

  const build = (mask: number): Grid => {
    const grid = blank(version);
    placeFinder(grid, 0, 0);
    placeFinder(grid, 0, grid.size - 7);
    placeFinder(grid, grid.size - 7, 0);
    placeAlignment(grid, version);
    placeTiming(grid);
    reserveFormat(grid, version);
    writeVersion(grid, version);
    placeData(grid, stream, mask);
    writeFormat(grid, level, mask);
    return grid;
  };

  let mask = opts.mask;
  let grid: Grid;
  if (mask === undefined) {
    let best = Infinity;
    mask = 0;
    grid = build(0);
    for (let candidate = 0; candidate < 8; candidate++) {
      const attempt = build(candidate);
      const score = penalty(attempt.modules);
      if (score < best) {
        best = score;
        mask = candidate;
        grid = attempt;
      }
    }
  } else {
    grid = build(mask);
  }
  return { version, level, mask, size: grid.size, modules: grid.modules };
}

/**
 * One `<path>` of filled squares on a background rect: no per-module elements,
 * so a version-10 code is a few kilobytes rather than a few thousand nodes.
 * `shape-rendering: crispEdges` keeps the modules square at any zoom.
 */
export function qrSvg(text: string, opts: QrOptions & { margin?: number; scale?: number; title?: string } = {}): string {
  const code = encodeQr(text, opts);
  const margin = opts.margin ?? 4;
  const scale = opts.scale ?? 4;
  const span = code.size + margin * 2;
  const parts: string[] = [];
  for (let r = 0; r < code.size; r++) {
    for (let c = 0; c < code.size; c++) {
      if (code.modules[r][c]) parts.push(`M${c + margin} ${r + margin}h1v1h-1z`);
    }
  }
  const title = opts.title ? `<title>${opts.title.replace(/[<>&]/g, "")}</title>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="${span * scale}" height="${span * scale}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">${title}` +
    `<rect width="${span}" height="${span}" fill="#ffffff"/>` +
    `<path fill="#000000" d="${parts.join("")}"/></svg>`
  );
}
