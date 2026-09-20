import { describe, expect, it } from "vitest";
import { csvCell, csvRow, toCsv } from "../../server/export/csv";

describe("csvCell", () => {
  it("leaves a plain value alone", () => {
    expect(csvCell("Casey Owner")).toBe("Casey Owner");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(true)).toBe("true");
  });

  it("writes nothing for nothing", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes anything a reader could misparse, doubling embedded quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("carriage\rreturn")).toBe('"carriage\rreturn"');
  });

  it("writes a date as an instant and an object as JSON", () => {
    expect(csvCell(new Date("2026-09-20T19:00:00.000Z"))).toBe("2026-09-20T19:00:00.000Z");
    expect(csvCell({ orgId: 2 })).toBe('"{""orgId"":2}"');
    expect(csvCell([1, 2, 3])).toBe('"[1,2,3]"');
  });

  it("defuses a cell a spreadsheet would read as a formula", () => {
    // The apostrophe is what Excel, Numbers and LibreOffice all treat as "text".
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+HYPERLINK()")).toBe("'+HYPERLINK()");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    // An apostrophe needs no quoting under RFC 4180, so the cell is only prefixed.
    expect(csvCell("=cmd|' /c calc'!A0")).toBe("'=cmd|' /c calc'!A0");
    // A normal negative number is data, not an attack, but the prefix is cheap
    // and reversible; what matters is that the value survives verbatim after it.
    expect(csvCell("-5").slice(1)).toBe("-5");
  });
});

describe("rows and documents", () => {
  it("joins cells with commas", () => {
    expect(csvRow(["a", 1, null, "b,c"])).toBe('a,1,,"b,c"');
  });

  it("writes a header and one CRLF-terminated line per record, in column order", () => {
    const csv = toCsv(["id", "kind", "meta"], [
      { id: 1, kind: "token.minted", meta: { name: "probe" } },
      { id: 2, kind: "token.revoked", meta: null },
    ]);
    expect(csv).toBe('id,kind,meta\r\n1,token.minted,"{""name"":""probe""}"\r\n2,token.revoked,\r\n');
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("writes just the header for no rows, so the columns are still documented", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b\r\n");
  });

  it("writes an empty cell for a column a row does not have", () => {
    expect(toCsv(["a", "b"], [{ a: 1 }])).toBe("a,b\r\n1,\r\n");
  });
});
