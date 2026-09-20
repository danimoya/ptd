import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Attachment storage safety.
 *
 * The rule under test is the one the feature lives or dies by: nothing the
 * caller sends may influence where a file is written or read. The filename is a
 * label, the path comes from the org id and the sha256, and anything that is not
 * that exact shape is refused.
 */
vi.mock("../../db", () => ({ db: {} }));

import {
  dispositionFor,
  filesRoot,
  humanSize,
  isInlineMime,
  mimeFromFilename,
  resolveMime,
  resolveStoragePath,
  safeFilename,
  sanitizeMime,
  storageKeyFor,
} from "../../server/plan/attachments";
import { ActionError } from "../../server/actions/registry";

const SHA = "a".repeat(64);

afterEach(() => {
  delete process.env.PTD_FILES_DIR;
});

describe("safeFilename", () => {
  it("keeps a plain name", () => {
    expect(safeFilename("spec v2.pdf")).toBe("spec v2.pdf");
  });

  it("disarms traversal, separators and control characters", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("/etc/shadow")).toBe("shadow");
    expect(safeFilename("..\\..\\windows\\system32\\cmd.exe")).toBe("cmd.exe");
    expect(safeFilename("re\u0000port\n.txt")).toBe("report.txt");
    expect(safeFilename('quote".txt')).toBe("quote.txt");
    expect(safeFilename("..")).toBe("upload.bin");
    expect(safeFilename(".hidden")).toBe("hidden");
    expect(safeFilename("")).toBe("upload.bin");
    expect(safeFilename(undefined)).toBe("upload.bin");
  });

  it("never returns a name containing a path separator", () => {
    for (const evil of ["a/b", "a\\b", "....//etc/passwd", "x/../../y"]) {
      const safe = safeFilename(evil);
      expect(safe).not.toContain("/");
      expect(safe).not.toContain("\\");
    }
  });

  it("bounds the length", () => {
    expect(safeFilename(`${"x".repeat(400)}.txt`).length).toBe(200);
  });
});

describe("storage keys", () => {
  it("shards by the first two byte pairs of the digest", () => {
    expect(storageKeyFor(7, SHA)).toBe(`7/aa/aa/${SHA}`);
  });

  it("resolves inside the root", () => {
    process.env.PTD_FILES_DIR = "/tmp/ptd-test-files";
    expect(resolveStoragePath(storageKeyFor(1, SHA))).toBe(`/tmp/ptd-test-files/1/aa/aa/${SHA}`);
    expect(filesRoot()).toBe("/tmp/ptd-test-files");
  });

  it("refuses any key that is not the shape it writes", () => {
    process.env.PTD_FILES_DIR = "/tmp/ptd-test-files";
    const bad = [
      "../../etc/passwd",
      `1/aa/aa/${SHA}/../../../../etc/passwd`,
      `1/../${SHA}`,
      `1/aa/aa/${"z".repeat(64)}`,
      `1/aa/aa/${SHA.slice(0, 63)}`,
      `/1/aa/aa/${SHA}`,
      "",
    ];
    for (const key of bad) {
      expect(() => resolveStoragePath(key), key).toThrow(ActionError);
    }
  });
});

describe("MIME handling", () => {
  it("only renders a short list of types in place", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv"]) {
      expect(isInlineMime(mime), mime).toBe(true);
    }
    // An SVG is a script host, and these files are served from the app's own origin.
    for (const mime of ["image/svg+xml", "text/html", "application/xhtml+xml", "application/javascript", "application/zip", "application/octet-stream"]) {
      expect(isInlineMime(mime), mime).toBe(false);
    }
  });

  it("normalises a Content-Type header and falls back to octet-stream", () => {
    expect(sanitizeMime("Image/PNG")).toBe("image/png");
    expect(sanitizeMime("text/plain; charset=utf-8")).toBe("text/plain");
    expect(sanitizeMime("not a mime")).toBe("application/octet-stream");
    expect(sanitizeMime("<script>")).toBe("application/octet-stream");
    expect(sanitizeMime(undefined)).toBe("application/octet-stream");
  });

  it("guesses from the extension only when the header said nothing useful", () => {
    expect(resolveMime("application/octet-stream", "notes.txt")).toBe("text/plain");
    expect(resolveMime(undefined, "shot.PNG".toLowerCase())).toBe("image/png");
    expect(resolveMime("application/pdf", "notes.txt")).toBe("application/pdf");
    expect(resolveMime("application/octet-stream", "archive.zip")).toBe("application/octet-stream");
    expect(mimeFromFilename("passwd")).toBeNull();
    // The guess can only ever name a type that is already allowed inline.
    expect(mimeFromFilename("payload.svg")).toBeNull();
    expect(mimeFromFilename("payload.html")).toBeNull();
  });

  it("forces a download for everything it will not render", () => {
    expect(dispositionFor("image/png", "shot.png")).toEqual({
      contentType: "image/png",
      disposition: `inline; filename="shot.png"; filename*=UTF-8''shot.png`,
    });
    const svg = dispositionFor("image/svg+xml", "logo.svg");
    expect(svg.contentType).toBe("application/octet-stream");
    expect(svg.disposition.startsWith("attachment;")).toBe(true);
    // A non-ASCII name survives verbatim in filename* and is reduced to
    // underscores in the ASCII filename an older client reads.
    const unicode = dispositionFor("application/pdf", "rapport-été.pdf");
    expect(unicode.disposition).toContain(`filename="rapport-_t_.pdf"`);
    expect(unicode.disposition).toContain("filename*=UTF-8''rapport-%C3%A9t%C3%A9.pdf");
    // A quote in the label cannot break out of the header's quoted string.
    expect(dispositionFor("application/pdf", 'a"b.pdf').disposition).not.toContain('"a"b.pdf"');
  });
});

describe("humanSize", () => {
  it("reads like a file manager", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(999)).toBe("999 B");
    expect(humanSize(2048)).toBe("2.0 kB");
    expect(humanSize(1048576)).toBe("1.0 MB");
  });
});
