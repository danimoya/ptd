/**
 * The generated action reference. Renders the real registry, so a new action with a
 * bad shape (a missing description, an unrenderable type, a pipe that would break
 * the table) fails here rather than in a docs review.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { BEGIN, END, renderReference, splice, typeName } from "../scripts/gen-docs";

// The registry's modules import the drizzle client at load time; postgres.js
// connects lazily, so a placeholder URL is enough and nothing is dialed.
process.env.DATABASE_URL ||= "postgres://docs:docs@127.0.0.1:5432/docs";

type Registry = typeof import("../server/actions");
let registry: Registry;

beforeAll(async () => {
  registry = await import("../server/actions");
});

describe("typeName", () => {
  it("renders the shapes actions use", () => {
    expect(typeName(z.string())).toBe("string");
    expect(typeName(z.number())).toBe("number");
    expect(typeName(z.number().int())).toBe("integer");
    expect(typeName(z.boolean())).toBe("boolean");
    expect(typeName(z.array(z.string()))).toBe("string[]");
    expect(typeName(z.enum(["a", "b"]))).toBe("`a` | `b`");
    expect(typeName(z.literal("none"))).toBe('`"none"`');
    expect(typeName(z.object({}))).toBe("object");
  });

  it("looks through optional, nullable and default wrappers", () => {
    expect(typeName(z.string().optional())).toBe("string");
    expect(typeName(z.number().int().nullable().optional())).toBe("integer");
    expect(typeName(z.boolean().default(false))).toBe("boolean");
  });
});

describe("renderReference", () => {
  it("documents every registered action, grouped by surface", () => {
    const actions = registry.allActions();
    expect(actions.length).toBeGreaterThan(50);
    const out = renderReference(actions as never);
    for (const action of actions) expect(out).toContain(`#### \`${action.name}\``);
    expect(out).toContain(`_${actions.length} actions, generated from`);
    for (const surface of new Set(actions.map((a) => a.surface))) expect(out).toContain(`| ${surface} |`);
  });

  it("names the minimum role of each action", () => {
    const out = renderReference(registry.allActions() as never);
    for (const action of registry.allActions()) {
      expect(out).toContain(`**${action.title}** · role \`${action.requiredRole}\` and above`);
    }
  });

  it("escapes the pipes that would otherwise break a table row", () => {
    for (const line of renderReference(registry.allActions() as never).split("\n")) {
      if (!line.startsWith("| `")) continue;
      // A table row has exactly four unescaped pipes: | field | type | flags | meaning |
      expect(line.replace(/\\\|/g, "").match(/\|/g)?.length).toBe(5);
    }
  });

  it("says so when an action takes no arguments", () => {
    const out = renderReference(registry.allActions().filter((a) => a.name === "whoami") as never);
    expect(out).toContain("Takes no arguments.");
  });
});

describe("splice", () => {
  it("replaces only what is between the markers", () => {
    const doc = `head\n\n${BEGIN}\nold\n${END}\n\ntail\n`;
    const out = splice(doc, "new");
    expect(out).toContain("head");
    expect(out).toContain("tail");
    expect(out).toContain("new");
    expect(out).not.toContain("old");
  });

  it("is idempotent", () => {
    const doc = `head\n\n${BEGIN}\nold\n${END}\n\ntail\n`;
    expect(splice(splice(doc, "new"), "new")).toBe(splice(doc, "new"));
  });

  it("refuses a document with no markers rather than guessing", () => {
    expect(() => splice("no markers here", "x")).toThrow(/must contain/);
  });
});
