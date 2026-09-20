/** Reading a usage figure out of a wrapped command's file, output or CI environment. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evidenceFrom,
  githubEvidence,
  isCi,
  isGithubActions,
  normalizeUsage,
  parseUsageMarkers,
  readUsageFile,
  USAGE_MARKER,
} from "../src/usage.ts";

describe("normalizeUsage", () => {
  it("takes a bare total", () => {
    expect(normalizeUsage({ tokens: 55_000 })).toMatchObject({ tokens: 55_000 });
    expect(normalizeUsage({ total_tokens: 55_000 })).toMatchObject({ tokens: 55_000 });
    expect(normalizeUsage({ tokensUsed: 55_000 })).toMatchObject({ tokens: 55_000 });
  });

  it("derives the total from the split when no total is given", () => {
    const report = normalizeUsage({ input_tokens: 2_000, output_tokens: 900, cache_read_input_tokens: 300_000 });
    expect(report?.tokens).toBe(302_900);
    expect(report?.inputTokens).toBe(2_000);
    expect(report?.cacheReadTokens).toBe(300_000);
  });

  it("unwraps an SDK usage block", () => {
    const report = normalizeUsage({ model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 40 } });
    expect(report).toMatchObject({ tokens: 55, model: "claude-opus-5", cacheCreationTokens: 40 });
  });

  it("reads camelCase and snake_case cost and model keys", () => {
    expect(normalizeUsage({ tokens: 1, costUsd: 0.5 })?.costUsd).toBe(0.5);
    expect(normalizeUsage({ tokens: 1, api_cost_usd: 0.25 })?.costUsd).toBe(0.25);
    expect(normalizeUsage({ tokens: 1, model_id: "gpt-4o" })?.model).toBe("gpt-4o");
  });

  it("prefers an explicit total over the split, so a source can report both", () => {
    expect(normalizeUsage({ tokens: 900, input_tokens: 100, output_tokens: 100 })?.tokens).toBe(900);
  });

  it("carries anything it does not recognise into `extra`, for the evidence", () => {
    const report = normalizeUsage({ tokens: 10, turns: 3, sessionId: "s-1", commit: "deadbeef" });
    expect(report?.turns).toBe(3);
    expect(report?.extra).toEqual({ sessionId: "s-1", commit: "deadbeef" });
  });

  it("rejects anything with no usable number in it", () => {
    expect(normalizeUsage({ hello: "world" })).toBeNull();
    expect(normalizeUsage({ tokens: 0 })).toBeNull();
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage([1, 2])).toBeNull();
    expect(normalizeUsage("12")).toBeNull();
  });

  it("accepts a cost with no tokens — a run may know only what it was billed", () => {
    expect(normalizeUsage({ costUsd: 1.25 })).toMatchObject({ tokens: 0, costUsd: 1.25 });
  });

  it("ignores negative and non-numeric figures rather than storing nonsense", () => {
    expect(normalizeUsage({ tokens: -5 })).toBeNull();
    expect(normalizeUsage({ tokens: "many" })).toBeNull();
    expect(normalizeUsage({ tokens: "55000" })?.tokens).toBe(55_000);
  });
});

describe("parseUsageMarkers", () => {
  it("finds a marker anywhere in a line of output", () => {
    const log = `building…\n[12:03] ${USAGE_MARKER} {"tokens": 4200, "model": "claude-opus-5"}\ndone\n`;
    expect(parseUsageMarkers(log)).toMatchObject({ tokens: 4_200, model: "claude-opus-5" });
  });

  it("accepts a colon after the marker", () => {
    expect(parseUsageMarkers(`${USAGE_MARKER}: {"tokens": 7}`)).toMatchObject({ tokens: 7 });
  });

  it("takes the last marker, so one final total wins over interim ones", () => {
    const log = [`${USAGE_MARKER} {"tokens": 100}`, `${USAGE_MARKER} {"tokens": 900}`].join("\n");
    expect(parseUsageMarkers(log)?.tokens).toBe(900);
  });

  it("ignores a truncated or non-JSON marker instead of failing the run", () => {
    expect(parseUsageMarkers(`${USAGE_MARKER} {"tokens": 12`)).toBeNull();
    expect(parseUsageMarkers(`${USAGE_MARKER} not json`)).toBeNull();
    expect(parseUsageMarkers("no marker here")).toBeNull();
    // A bad marker must not shadow a good earlier one being absent…
    expect(parseUsageMarkers(`${USAGE_MARKER} {"tokens": 5}\n${USAGE_MARKER} {oops`)?.tokens).toBe(5);
  });

  it("handles CRLF output from a Windows runner", () => {
    expect(parseUsageMarkers(`step\r\n${USAGE_MARKER} {"tokens": 33}\r\n`)?.tokens).toBe(33);
  });
});

describe("readUsageFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptd-cli-usage-"));

  it("reads a JSON usage report", () => {
    const path = join(dir, "usage.json");
    writeFileSync(path, JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 }, model: "claude-sonnet-5" }));
    expect(readUsageFile(path)).toMatchObject({ tokens: 15, model: "claude-sonnet-5" });
  });

  it("treats a missing or broken file as no report, not as a failure", () => {
    expect(readUsageFile(join(dir, "nope.json"))).toBeNull();
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{oops");
    expect(readUsageFile(broken)).toBeNull();
  });
});

describe("githubEvidence", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "danimoya/ptd",
    GITHUB_WORKFLOW: "nightly",
    GITHUB_JOB: "triage",
    GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: "deadbeef",
    GITHUB_REF_NAME: "main",
    GITHUB_ACTOR: "danimoya",
  } as NodeJS.ProcessEnv;

  it("names the run, the commit and the actor, and links to the run", () => {
    const evidence = githubEvidence(env);
    expect(evidence).toMatchObject({ repository: "danimoya/ptd", workflow: "nightly", job: "triage", runId: "123456", runAttempt: "2", sha: "deadbeef", actor: "danimoya" });
    expect(evidence.runUrl).toBe("https://github.com/danimoya/ptd/actions/runs/123456");
  });

  it("honours a GitHub Enterprise server URL", () => {
    const evidence = githubEvidence({ ...env, GITHUB_SERVER_URL: "https://github.acme.test/" });
    expect(evidence.runUrl).toBe("https://github.acme.test/danimoya/ptd/actions/runs/123456");
  });

  it("omits what the environment does not say, rather than inventing it", () => {
    expect(githubEvidence({})).toEqual({});
    expect(githubEvidence({ GITHUB_REPOSITORY: "a/b" } as NodeJS.ProcessEnv)).toEqual({ repository: "a/b" });
  });

  it("detects Actions and generic CI", () => {
    expect(isGithubActions(env)).toBe(true);
    expect(isGithubActions({ GITHUB_RUN_ID: "1", GITHUB_REPOSITORY: "a/b" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isGithubActions({})).toBe(false);
    expect(isCi({ CI: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isCi({})).toBe(false);
  });
});

describe("evidenceFrom", () => {
  it("carries the split and the model so the server can price it the same way", () => {
    const report = normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, model: "claude-opus-5", turns: 4 })!;
    expect(evidenceFrom(report, { runner: "ptd agent-run" })).toEqual({
      runner: "ptd agent-run",
      model: "claude-opus-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 90,
      turns: 4,
    });
  });

  it("lets the caller's context win over the report's own extras", () => {
    const report = normalizeUsage({ tokens: 1, runner: "theirs" })!;
    expect(evidenceFrom(report, { runner: "ours" }).runner).toBe("ours");
  });

  it("returns just the context when nothing was reported", () => {
    expect(evidenceFrom(null, { exitCode: 3 })).toEqual({ exitCode: 3 });
  });
});
