import { describe, expect, it } from "vitest";
import { crc32 as zlibCrc32 } from "zlib";
import { crc32, zipStore } from "../../server/export/zip";

/**
 * The archive is checked two ways: against Node's zlib (an independent CRC-32,
 * the one every unzip implementation agrees with) and by parsing the container
 * back out of the bytes — local headers, central directory, end record — the way
 * a reader would. `python3 -m zipfile -l` and `unzip -t` were run against the
 * live endpoint too; this keeps that honest without shelling out.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

interface ParsedEntry {
  name: string;
  data: Buffer;
  crc: number;
  method: number;
  flags: number;
  offset: number;
}

function parse(zip: Buffer): { entries: ParsedEntry[]; central: { name: string; offset: number; externalAttrs: number }[] } {
  const entries: ParsedEntry[] = [];
  let at = 0;
  while (zip.readUInt32LE(at) === LOCAL) {
    const flags = zip.readUInt16LE(at + 6);
    const method = zip.readUInt16LE(at + 8);
    const crc = zip.readUInt32LE(at + 14);
    const compressed = zip.readUInt32LE(at + 18);
    const uncompressed = zip.readUInt32LE(at + 22);
    const nameLength = zip.readUInt16LE(at + 26);
    const extraLength = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    const start = at + 30 + nameLength + extraLength;
    expect(compressed).toBe(uncompressed); // stored, never deflated
    entries.push({ name, data: zip.subarray(start, start + compressed), crc, method, flags, offset: at });
    at = start + compressed;
  }

  const directoryStart = at;
  const central: { name: string; offset: number; externalAttrs: number }[] = [];
  while (zip.readUInt32LE(at) === CENTRAL) {
    const nameLength = zip.readUInt16LE(at + 28);
    central.push({
      name: zip.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
      offset: zip.readUInt32LE(at + 42),
      externalAttrs: zip.readUInt32LE(at + 38),
    });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }

  expect(zip.readUInt32LE(at)).toBe(END);
  expect(zip.readUInt16LE(at + 8)).toBe(entries.length);
  expect(zip.readUInt16LE(at + 10)).toBe(entries.length);
  // The end record points at the byte where the central directory begins, and
  // says how long it is; both have to agree with what was just parsed.
  expect(zip.readUInt32LE(at + 16)).toBe(directoryStart);
  expect(zip.readUInt32LE(at + 12)).toBe(at - directoryStart);
  expect(at + 22).toBe(zip.length);
  return { entries, central };
}

describe("crc32", () => {
  it("agrees with zlib", () => {
    for (const sample of ["", "a", "hello world", "x".repeat(1000), "ünïcödé"]) {
      const buf = Buffer.from(sample, "utf8");
      expect(crc32(buf)).toBe(zlibCrc32(buf));
    }
    expect(crc32(Buffer.from("123456789", "utf8"))).toBe(0xcbf43926);
  });
});

describe("zipStore", () => {
  const entries = [
    { name: "README.txt", data: "PTD export\nsecond line\n" },
    { name: "organization.json", data: JSON.stringify({ id: 2, name: "Hosted Grade Ltd" }, null, 2) },
    { name: "members.csv", data: "userId,email\r\n7,casey@owner.test\r\n" },
    { name: "empty.csv", data: "" },
    { name: "ünïcödé.txt", data: "a payload with multibyte characters — ✓" },
  ];

  it("writes a readable container: one stored entry per file, in order", () => {
    const zip = zipStore(entries);
    const { entries: read, central } = parse(zip);
    expect(read.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(central.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    for (const [i, entry] of read.entries()) {
      expect(entry.method).toBe(0);
      expect(entry.data.toString("utf8")).toBe(entries[i].data);
      expect(entry.crc).toBe(zlibCrc32(Buffer.from(entries[i].data, "utf8")));
      expect(entry.flags & 0x0800).toBe(0x0800); // UTF-8 names
      expect(entry.flags & 0x0008).toBe(0); // no data descriptor: sizes are known up front
      expect(central[i].offset).toBe(entry.offset);
      expect(central[i].externalAttrs >>> 16).toBe(0o100644); // a regular, readable file
    }
  });

  it("takes a Buffer as readily as a string", () => {
    const binary = Buffer.from([0, 1, 2, 250, 251, 0]);
    const { entries: read } = parse(zipStore([{ name: "blob.bin", data: binary }]));
    expect(read[0].data.equals(binary)).toBe(true);
  });

  it("writes an archive with no entries at all", () => {
    const zip = zipStore([]);
    expect(zip).toHaveLength(22);
    expect(zip.readUInt32LE(0)).toBe(END);
  });

  it("puts a DOS timestamp in range, rounded to two seconds", () => {
    const zip = zipStore([{ name: "a.txt", data: "a", mtime: new Date("2026-09-20T19:04:33Z") }]);
    const time = zip.readUInt16LE(10);
    const date = zip.readUInt16LE(12);
    expect((date >> 9) + 1980).toBe(2026);
    expect((date >> 5) & 0x0f).toBe(9);
    expect(date & 0x1f).toBe(20);
    expect((time & 0x1f) * 2).toBe(32); // 33 seconds, rounded down by the format
  });
});
