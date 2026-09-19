import { describe, expect, it } from "vitest";
import { BOM, csvCell, detectDelimiter, parseCsv, parseGrid, toCsv } from "../../server/importers/csv";

describe("parseGrid", () => {
  it("reads plain records", () => {
    expect(parseGrid("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps a delimiter inside a quoted field", () => {
    expect(parseGrid('key,summary\nATL-1,"Totals, taxes and fees"')).toEqual([
      ["key", "summary"],
      ["ATL-1", "Totals, taxes and fees"],
    ]);
  });

  it("keeps a newline inside a quoted field", () => {
    const grid = parseGrid('key,description\nATL-1,"line one\nline two"\nATL-2,plain');
    expect(grid).toHaveLength(3);
    expect(grid[1][1]).toBe("line one\nline two");
    expect(grid[2]).toEqual(["ATL-2", "plain"]);
  });

  it("unescapes a doubled quote", () => {
    expect(parseGrid('a\n"she said ""no"""')[1][0]).toBe('she said "no"');
  });

  it("keeps a bare quote in the middle of an unquoted field", () => {
    expect(parseGrid('size\n3" pipe')[1][0]).toBe('3" pipe');
  });

  it("handles CRLF, LF and a bare CR", () => {
    expect(parseGrid("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseGrid("a,b\r1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("does not invent a record for a trailing newline", () => {
    expect(parseGrid("a\n1\n")).toHaveLength(2);
  });

  it("keeps an empty trailing field", () => {
    expect(parseGrid("a,b,c\n1,,")).toEqual([["a", "b", "c"], ["1", "", ""]]);
  });

  it("reads a quoted field that ends the file without a newline", () => {
    expect(parseGrid('a\n"unterminated')[1][0]).toBe("unterminated");
  });
});

describe("parseCsv", () => {
  it("strips a UTF-8 BOM from the first header", () => {
    const parsed = parseCsv(`${BOM}Issue key,Summary\nATL-1,Fix it`);
    expect(parsed.columns).toEqual(["Issue key", "Summary"]);
    expect(parsed.rows[0]["Issue key"]).toBe("ATL-1");
  });

  it("detects a semicolon delimiter", () => {
    const parsed = parseCsv("Name;Status;Due\nRewrite;In progress;2026-03-19");
    expect(parsed.delimiter).toBe(";");
    expect(parsed.columns).toEqual(["Name", "Status", "Due"]);
    expect(parsed.rows[0].Status).toBe("In progress");
  });

  it("detects a tab delimiter", () => {
    expect(parseCsv("a\tb\tc\n1\t2\t3").delimiter).toBe("\t");
  });

  it("de-duplicates repeated headers and records the grouping", () => {
    const parsed = parseCsv("Issue key,Labels,Labels,Labels\nATL-1,billing,regression,ui");
    expect(parsed.columns).toEqual(["Issue key", "Labels", "Labels (2)", "Labels (3)"]);
    expect(parsed.duplicates.Labels).toEqual(["Labels", "Labels (2)", "Labels (3)"]);
    expect(parsed.rows[0]["Labels (3)"]).toBe("ui");
    expect(parsed.warnings.join(" ")).toMatch(/appears 3 times/);
  });

  it("names an empty header after its position", () => {
    expect(parseCsv("a,,c\n1,2,3").columns).toEqual(["a", "column 2", "c"]);
  });

  it("pads a short row and warns about it", () => {
    const parsed = parseCsv("a,b,c\n1,2");
    expect(parsed.rows[0]).toEqual({ a: "1", b: "2", c: "" });
    expect(parsed.warnings.join(" ")).toMatch(/did not have 3 cells/);
  });

  it("drops blank separator lines", () => {
    expect(parseCsv("a,b\n1,2\n,\n3,4").rows).toHaveLength(2);
  });

  it("caps the number of rows", () => {
    const body = Array.from({ length: 5 }, (_, i) => `r${i}`).join("\n");
    const parsed = parseCsv(`a\n${body}`, { maxRows: 2 });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.warnings.join(" ")).toMatch(/first 2 rows/);
  });

  it("reports an empty file rather than throwing", () => {
    expect(parseCsv("").columns).toEqual([]);
    expect(parseCsv("").warnings).toContain("The file is empty.");
  });

  it("trims cell whitespace", () => {
    expect(parseCsv("a , b\n 1 , 2 ").rows[0]).toEqual({ a: "1", b: "2" });
  });
});

describe("detectDelimiter", () => {
  it("ignores delimiters inside the header's quoted cells", () => {
    expect(detectDelimiter('"a,b,c,d";e;f')).toBe(";");
  });

  it("only looks at the header record", () => {
    expect(detectDelimiter("a,b\n1;2;3;4;5;6")).toBe(",");
  });

  it("defaults to a comma when nothing separates anything", () => {
    expect(detectDelimiter("single")).toBe(",");
  });
});

describe("writing", () => {
  it("quotes only what has to be quoted", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("has,comma")).toBe('"has,comma"');
    expect(csvCell('has"quote')).toBe('"has""quote"');
    expect(csvCell("has\nnewline")).toBe('"has\nnewline"');
    expect(csvCell(null)).toBe("");
  });

  it("round-trips through parseGrid with CRLF separators", () => {
    const grid = [
      ["key", "summary"],
      ["ATL-1", 'Totals, "taxes"\nand fees'],
    ];
    const text = toCsv(grid);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(parseGrid(text)).toEqual(grid);
  });
});
