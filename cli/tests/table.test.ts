import { beforeAll, describe, expect, it } from "vitest";
import { setColor } from "../src/color.ts";
import { flatten, keyValue, minutes, renderCell, summarize, table } from "../src/table.ts";

beforeAll(() => setColor(false));

describe("table", () => {
  it("aligns columns to the widest cell and rules the header", () => {
    const out = table([
      { key: "SEC-3", id: 3, title: "Add CSRF tokens" },
      { key: "API-12", id: 120, title: "Rate limits" },
    ]);
    const lines = out.split("\n");
    // The header of a numeric column is right-aligned with its values.
    expect(lines[0]).toBe("key      id  title");
    expect(lines[1]).toBe("──────  ───  ───────────────");
    // Numbers right-aligned, strings left-aligned.
    expect(lines[2]).toBe("SEC-3     3  Add CSRF tokens");
    expect(lines[3]).toBe("API-12  120  Rate limits");
  });

  it("returns an empty string for no rows", () => {
    expect(table([])).toBe("");
  });

  it("honors an explicit column list and header override", () => {
    const out = table([{ a: 1, b: 2 }], [{ key: "b", header: "bee" }]);
    expect(out.split("\n")[0]).toBe("bee");
    expect(out).not.toContain("a");
  });

  it("clips a long cell with an ellipsis", () => {
    const out = table([{ title: "x".repeat(80) }], [{ key: "title", max: 10 }]);
    expect(out.split("\n")[2]).toBe(`${"x".repeat(9)}…`);
  });

  it("flattens whitespace so a multi-line note stays on its row", () => {
    expect(renderCell("two\nlines  here")).toBe("two lines here");
    expect(renderCell(null)).toBe("");
    expect(renderCell([1, 2])).toBe("1, 2");
  });
});

describe("keyValue", () => {
  it("pads labels to a common width", () => {
    expect(keyValue({ role: "owner", authType: "human" })).toBe("role      owner\nauthType  human");
  });

  it("drops undefined entries", () => {
    expect(keyValue({ a: 1, b: undefined })).toBe("a  1");
  });
});

describe("flatten", () => {
  it("turns nested buckets into dotted keys", () => {
    expect(flatten({ taskId: 3, bySource: { agent: { minutes: 78, tokens: 100 } } })).toEqual({
      taskId: 3,
      "bySource.agent.minutes": 78,
      "bySource.agent.tokens": 100,
    });
  });

  it("leaves arrays intact", () => {
    expect(flatten({ tags: ["a", "b"] })).toEqual({ tags: ["a", "b"] });
  });
});

describe("summarize", () => {
  it("renders an array of objects as a table with flattened columns", () => {
    const out = summarize([{ taskId: 3, bySource: { human: { minutes: 45 } } }]);
    expect(out.split("\n")[0]).toBe("taskId  bySource.human.minutes");
  });

  it("splits scalars from nested blocks", () => {
    const out = summarize({ overdue: 4, tasks: { open: 14, total: 18 } });
    expect(out).toContain("overdue  4");
    expect(out).toContain("tasks");
    expect(out).toContain("open   14");
  });

  it("says so when there is nothing", () => {
    expect(summarize(null)).toBe("(no result)");
    expect(summarize([])).toBe("(empty)");
  });
});

describe("minutes", () => {
  it("formats as hours and minutes", () => {
    expect(minutes(0)).toBe("0m");
    expect(minutes(45)).toBe("45m");
    expect(minutes(60)).toBe("1h");
    expect(minutes(95)).toBe("1h 35m");
    expect(minutes(null)).toBe("0m");
  });
});
