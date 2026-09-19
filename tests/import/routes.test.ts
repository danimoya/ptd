import { describe, expect, it, vi } from "vitest";

vi.mock("../../db", async () => {
  const { FakeDb } = await import("./fake-db");
  return { db: new FakeDb() };
});

import { extractCsv, parseMultipart, readSource } from "../../server/importers/routes";
import { toCsv } from "../../server/importers/csv";
import { mapperFor } from "../../server/importers/mappers";

const CSV = "Issue key,Summary\nATL-1,Fix it\n";

/** What a browser's `fetch(form)` actually puts on the wire. */
function multipart(boundary: string, parts: { name: string; filename?: string; body: string }[]): string {
  const chunks = parts.map((p) => {
    const disposition = p.filename ? `form-data; name="${p.name}"; filename="${p.filename}"` : `form-data; name="${p.name}"`;
    const type = p.filename ? "\r\nContent-Type: text/csv" : "";
    return `--${boundary}\r\nContent-Disposition: ${disposition}${type}\r\n\r\n${p.body}\r\n`;
  });
  return `${chunks.join("")}--${boundary}--\r\n`;
}

describe("extractCsv", () => {
  it("takes a raw text/csv body as the file", () => {
    expect(extractCsv(CSV, "text/csv").csv).toBe(CSV);
  });

  it("takes {csv} out of a JSON body express.json already parsed", () => {
    expect(extractCsv({ csv: CSV }, "application/json")).toEqual({ csv: CSV, filename: null });
  });

  it("rejects a JSON body without a csv field", () => {
    expect(() => extractCsv({ file: CSV }, "application/json")).toThrow(/csv/);
  });

  it("rejects an empty body", () => {
    expect(() => extractCsv("", "text/csv")).toThrow(/No file content/);
  });

  it("finds the file part of a multipart body", () => {
    const body = multipart("X-BOUND", [
      { name: "source", body: "jira" },
      { name: "file", filename: "export.csv", body: CSV },
    ]);
    expect(extractCsv(body, 'multipart/form-data; boundary="X-BOUND"')).toEqual({ csv: CSV, filename: "export.csv" });
  });
});

describe("parseMultipart", () => {
  it("accepts an unquoted boundary", () => {
    const body = multipart("abc123", [{ name: "csv", filename: "a.csv", body: CSV }]);
    expect(parseMultipart(body, "multipart/form-data; boundary=abc123").csv).toBe(CSV);
  });

  it("does not eat the CRLF of a quoted field that ends the file", () => {
    const csv = 'a,b\n"one\ntwo",3\n';
    const body = multipart("b", [{ name: "csv", filename: "a.csv", body: csv }]);
    expect(parseMultipart(body, "multipart/form-data; boundary=b").csv).toBe(csv);
  });

  it("falls back to a named text field when no part has a filename", () => {
    const body = multipart("b", [{ name: "csv", body: CSV }]);
    expect(parseMultipart(body, "multipart/form-data; boundary=b")).toEqual({ csv: CSV, filename: null });
  });

  it("prefers a real file part over a text field", () => {
    const body = multipart("b", [
      { name: "csv", body: "ignored" },
      { name: "upload", filename: "real.csv", body: CSV },
    ]);
    expect(parseMultipart(body, "multipart/form-data; boundary=b").filename).toBe("real.csv");
  });

  it("refuses a body with no boundary", () => {
    expect(() => parseMultipart("whatever", "multipart/form-data")).toThrow(/boundary/);
  });

  it("refuses a body with no usable part", () => {
    const body = multipart("b", [{ name: "unrelated", body: "x" }]);
    expect(() => parseMultipart(body, "multipart/form-data; boundary=b")).toThrow(/No file part/);
  });
});

describe("readSource", () => {
  it("defaults to auto", () => {
    expect(readSource(undefined)).toBe("auto");
    expect(readSource("")).toBe("auto");
    expect(readSource("auto")).toBe("auto");
  });

  it("accepts a known source and rejects anything else", () => {
    expect(readSource("linear")).toBe("linear");
    expect(() => readSource("monday")).toThrow(/Unknown source/);
  });
});

describe("templates", () => {
  it("serialises to a CSV that quotes the multi-value cells", () => {
    const body = toCsv(mapperFor("generic").template());
    expect(body).toContain('"admin,finance"');
    expect(body.endsWith("\r\n")).toBe(true);
  });
});
