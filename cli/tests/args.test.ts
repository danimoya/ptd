import { describe, expect, it } from "vitest";
import { bodyFromFlags, coerce, isFlag, numberFlag, parseArgs, parseDuration, stringFlag } from "../src/args.ts";

describe("parseArgs", () => {
  it("separates positionals from flags", () => {
    const { positionals, flags } = parseArgs(["start", "SEC-3", "wrote", "the", "middleware"]);
    expect(positionals).toEqual(["start", "SEC-3", "wrote", "the", "middleware"]);
    expect(flags.size).toBe(0);
  });

  it("reads --key=value and --key value", () => {
    const { flags } = parseArgs(["stop", "--tokens=1200", "--cost", "0.04"]);
    expect(flags.get("tokens")).toBe("1200");
    expect(flags.get("cost")).toBe("0.04");
  });

  it("treats a flag with no value as a boolean", () => {
    const { flags, positionals } = parseArgs(["tasks", "--mine", "--status", "backlog"]);
    expect(flags.get("mine")).toBe(true);
    expect(flags.get("status")).toBe("backlog");
    expect(positionals).toEqual(["tasks"]);
  });

  it("keeps notes out of --json, but takes a JSON object as its value", () => {
    const withNotes = parseArgs(["stop", "--json", "finished", "the", "sweep"]);
    expect(withNotes.flags.get("json")).toBe(true);
    expect(withNotes.positionals).toEqual(["stop", "finished", "the", "sweep"]);

    const withBody = parseArgs(["run", "task.get", "--json", '{"taskId":3}']);
    expect(withBody.flags.get("json")).toBe('{"taskId":3}');
    expect(withBody.positionals).toEqual(["run", "task.get"]);
  });

  it("expands single-letter aliases", () => {
    expect(parseArgs(["tasks", "-j"]).flags.get("json")).toBe(true);
    expect(parseArgs(["-h"]).flags.get("help")).toBe(true);
  });

  it("stops flag parsing at --", () => {
    const { positionals, flags } = parseArgs(["stop", "--", "--not-a-flag"]);
    expect(positionals).toEqual(["stop", "--not-a-flag"]);
    expect(flags.size).toBe(0);
  });

  it("counts a negative number as a value, not a flag", () => {
    expect(isFlag("-3")).toBe(false);
    expect(isFlag("--cost")).toBe(true);
    expect(parseArgs(["run", "x", "--offset", "-3"]).flags.get("offset")).toBe("-3");
  });
});

describe("coerce", () => {
  it("makes numbers, booleans and null out of the obvious spellings", () => {
    expect(coerce("3")).toBe(3);
    expect(coerce("-12")).toBe(-12);
    expect(coerce("0.04")).toBe(0.04);
    expect(coerce(".5")).toBe(0.5);
    expect(coerce("true")).toBe(true);
    expect(coerce("false")).toBe(false);
    expect(coerce("null")).toBeNull();
  });

  it("leaves task keys and prose alone", () => {
    expect(coerce("SEC-3")).toBe("SEC-3");
    expect(coerce("2026-09-20")).toBe("2026-09-20");
    expect(coerce("rotated 6 secrets")).toBe("rotated 6 secrets");
  });

  it("parses JSON literals, and a quoted number stays a string", () => {
    expect(coerce('["a","b"]')).toEqual(["a", "b"]);
    expect(coerce('{"a":1}')).toEqual({ a: 1 });
    expect(coerce('"0012"')).toBe("0012");
  });

  it("keeps malformed JSON as text rather than throwing", () => {
    expect(coerce("{not json")).toBe("{not json");
  });
});

describe("bodyFromFlags", () => {
  it("coerces values and drops the reserved flags", () => {
    const { flags } = parseArgs(["run", "task.create", "--title=Ship it", "--urgency=8", "--json", "--url", "https://x"]);
    expect(bodyFromFlags(flags)).toEqual({ title: "Ship it", urgency: 8 });
  });

  it("turns a bare flag into true", () => {
    const { flags } = parseArgs(["run", "task.list", "--includeCompleted"]);
    expect(bodyFromFlags(flags)).toEqual({ includeCompleted: true });
  });
});

describe("numberFlag / stringFlag", () => {
  it("returns undefined when absent and complains when unusable", () => {
    const { flags } = parseArgs(["stop", "--tokens=1200", "--cost=abc", "--notes"]);
    expect(numberFlag(flags, "tokens")).toBe(1200);
    expect(numberFlag(flags, "missing")).toBeUndefined();
    expect(() => numberFlag(flags, "cost")).toThrow(/must be a number/);
    expect(() => stringFlag(flags, "notes")).toThrow(/needs a value/);
  });
});

describe("parseDuration", () => {
  it("reads the spellings people type", () => {
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("45min")).toBe(45);
    expect(parseDuration("1h30m")).toBe(90);
    expect(parseDuration("1h 30m")).toBe(90);
    expect(parseDuration("1.5h")).toBe(90);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("30s")).toBe(0.5);
  });

  it("refuses anything that is not entirely a duration", () => {
    expect(parseDuration("45mx")).toBeNull();
    expect(parseDuration("tomorrow")).toBeNull();
    expect(parseDuration("SEC-3")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});
