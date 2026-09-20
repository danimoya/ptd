import { describe, expect, it } from "vitest";

/**
 * Custom field keys and per-kind validation.
 *
 * The validator is the only thing standing between a jsonb column and whatever
 * an agent felt like posting, so every kind is exercised both ways: what it
 * accepts (and how it normalises it) and what it refuses.
 */
import { vi } from "vitest";
vi.mock("../../db", () => ({ db: {} }));

import { choicesOf, deriveKey, FIELD_KINDS, validateValue } from "../../server/plan/customFields";
import { ActionError } from "../../server/actions/registry";

type Field = Parameters<typeof validateValue>[0];
const field = (kind: string, options?: string[]): Field => ({
  key: "f",
  kind,
  options: options ? { choices: options } : null,
});

describe("deriveKey", () => {
  it("makes a stable snake_case wire name out of a label", () => {
    expect(deriveKey("Customer severity")).toBe("customer_severity");
    expect(deriveKey("  Spec URL  ")).toBe("spec_url");
    expect(deriveKey("Needs sign-off?")).toBe("needs_sign_off");
    expect(deriveKey("ETA (days)")).toBe("eta_days");
  });

  it("never produces an empty key or one starting with a digit", () => {
    expect(deriveKey("???")).toBe("field");
    expect(deriveKey("")).toBe("field");
    expect(deriveKey("2026 target")).toBe("f_2026_target");
  });

  it("bounds the length so it fits the column", () => {
    expect(deriveKey("a".repeat(100)).length).toBeLessThanOrEqual(34);
  });
});

describe("choicesOf", () => {
  it("reads the choices out of the jsonb blob, defensively", () => {
    expect(choicesOf({ options: { choices: ["a", "b"] } })).toEqual(["a", "b"]);
    expect(choicesOf({ options: { choices: ["a", 3, null] } })).toEqual(["a"]);
    expect(choicesOf({ options: null })).toEqual([]);
    expect(choicesOf({ options: { other: 1 } })).toEqual([]);
  });
});

describe("validateValue", () => {
  it("covers every kind the schema allows", () => {
    // If a kind is added, this test fails until it is handled here too.
    for (const kind of FIELD_KINDS) {
      const f = field(kind, kind === "select" || kind === "multiselect" ? ["a"] : undefined);
      const sample: Record<string, unknown> = {
        text: "x",
        number: 1,
        date: "2026-09-20",
        select: "a",
        multiselect: ["a"],
        checkbox: true,
        url: "https://example.com",
      };
      expect(() => validateValue(f, sample[kind]), kind).not.toThrow();
    }
  });

  it("text: a string within bounds", () => {
    expect(validateValue(field("text"), "hello")).toBe("hello");
    expect(() => validateValue(field("text"), 12)).toThrow(ActionError);
    expect(() => validateValue(field("text"), "x".repeat(2001))).toThrow(/2000 characters/);
  });

  it("number: coerces a numeric string, refuses anything else", () => {
    expect(validateValue(field("number"), 8)).toBe(8);
    expect(validateValue(field("number"), "8.5")).toBe(8.5);
    expect(validateValue(field("number"), "-3")).toBe(-3);
    for (const bad of ["eight", "", "  ", true, [], NaN, Infinity]) {
      expect(() => validateValue(field("number"), bad), String(bad)).toThrow(ActionError);
    }
  });

  it("date: stores a calendar day, not an instant", () => {
    expect(validateValue(field("date"), "2026-09-20")).toBe("2026-09-20");
    expect(validateValue(field("date"), "2026-09-20T22:15:00.000Z")).toBe("2026-09-20");
    for (const bad of ["not-a-date", "", 20260920, "2026-13-45"]) {
      expect(() => validateValue(field("date"), bad), String(bad)).toThrow(ActionError);
    }
  });

  it("checkbox: booleans, and the two strings a form sends", () => {
    expect(validateValue(field("checkbox"), true)).toBe(true);
    expect(validateValue(field("checkbox"), false)).toBe(false);
    expect(validateValue(field("checkbox"), "true")).toBe(true);
    expect(validateValue(field("checkbox"), "false")).toBe(false);
    for (const bad of ["maybe", 1, 0, null]) {
      expect(() => validateValue(field("checkbox"), bad), String(bad)).toThrow(ActionError);
    }
  });

  it("url: http(s) only — no javascript:, no data:, no bare host", () => {
    expect(validateValue(field("url"), " https://example.com/spec ")).toBe("https://example.com/spec");
    expect(validateValue(field("url"), "http://internal/spec")).toBe("http://internal/spec");
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "example.com", "", 5]) {
      expect(() => validateValue(field("url"), bad), String(bad)).toThrow(ActionError);
    }
  });

  it("select: exactly one of the offered options", () => {
    const f = field("select", ["low", "high"]);
    expect(validateValue(f, "high")).toBe("high");
    for (const bad of ["medium", "HIGH", ["high"], 1, null]) {
      expect(() => validateValue(f, bad), JSON.stringify(bad)).toThrow(ActionError);
    }
  });

  it("multiselect: a de-duplicated subset of the options, single values accepted", () => {
    const f = field("multiselect", ["web", "ios", "android"]);
    expect(validateValue(f, ["web", "ios"])).toEqual(["web", "ios"]);
    expect(validateValue(f, ["web", "web"])).toEqual(["web"]);
    expect(validateValue(f, "ios")).toEqual(["ios"]);
    expect(validateValue(f, [])).toEqual([]);
    for (const bad of [["web", "desktop"], ["web", 3], "desktop"]) {
      expect(() => validateValue(f, bad), JSON.stringify(bad)).toThrow(ActionError);
    }
  });

  it("names the field in every message, so an agent knows which key it got wrong", () => {
    try {
      validateValue({ key: "severity", kind: "select", options: { choices: ["low"] } }, "nope");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ActionError).message).toContain('"severity"');
      expect((error as ActionError).message).toContain("low");
    }
  });

  it("refuses a kind it does not know rather than storing it blindly", () => {
    expect(() => validateValue(field("colour"), "red")).toThrow(/unknown kind/);
  });
});
