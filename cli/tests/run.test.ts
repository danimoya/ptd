/** `ptd run` body assembly: the one place --json is both a body and a switch. */
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.ts";
import { buildBody } from "../src/commands/registry.ts";
import { UsageError } from "../src/errors.ts";

const build = (argv: string[]) => {
  const { flags, positionals } = parseArgs(argv);
  return buildBody(flags, positionals.slice(2));
};

describe("buildBody", () => {
  it("builds a body from --key=value with coercion", () => {
    expect(build(["run", "task.totals", "--taskId=3"])).toEqual({ body: { taskId: 3 }, raw: false });
    expect(build(["run", "task.create", "--title=Ship it", "--urgency=8", "--effort=2"]).body).toEqual({
      title: "Ship it",
      urgency: 8,
      effort: 2,
    });
  });

  it("takes a whole JSON object from --json", () => {
    expect(build(["run", "tasks.query", "--json", '{"limit":5,"status":["backlog"]}'])).toEqual({
      body: { limit: 5, status: ["backlog"] },
      raw: false,
    });
  });

  it("treats a bare --json as the raw-output switch", () => {
    expect(build(["run", "next_task", "--json"])).toEqual({ body: {}, raw: true });
  });

  it("lets --key=value override a field of --json", () => {
    expect(build(["run", "tasks.query", "--json", '{"limit":5}', "--limit=2"]).body).toEqual({ limit: 2 });
  });

  it("accepts --body as the unambiguous alias", () => {
    expect(build(["run", "task.get", "--body", '{"taskId":3}'])).toEqual({ body: { taskId: 3 }, raw: false });
  });

  it("refuses malformed or non-object JSON", () => {
    expect(() => build(["run", "x", "--json={oops}"])).toThrow(UsageError);
    expect(() => build(["run", "x", "--json=[1,2]"])).toThrow(/must be a JSON object/);
  });

  it("refuses a stray positional rather than guessing the field", () => {
    expect(() => build(["run", "task.get", "3"])).toThrow(/Unexpected argument "3"/);
  });
});
