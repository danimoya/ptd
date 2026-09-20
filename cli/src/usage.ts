/**
 * Reading a token figure out of something that is not PTD.
 *
 * `ptd agent-run` wraps an arbitrary command and `ptd ci-report` runs after one,
 * so neither can ask the model how much it spent — the wrapped program has to
 * say. Two channels, in this order of precedence:
 *
 *   1. a JSON file named by `PTD_TOKENS_FILE` (or `--usage-file`)
 *   2. a `PTD_USAGE {…}` line on the command's stdout
 *
 * Both accept the same loose shape, because the things that write them are the
 * Anthropic SDK's `usage` block, a jq one-liner, and somebody's bash script, and
 * insisting on one spelling would just mean the figure goes unreported. Every
 * key is read in camelCase and snake_case, a nested `usage` object is unwrapped,
 * and the total is summed from the split when no total is given.
 *
 * Pure: no filesystem except `readUsageFile`, no clock, no network.
 */

import { readFileSync } from "node:fs";

/** The line prefix a wrapped command prints to report its own usage. */
export const USAGE_MARKER = "PTD_USAGE";

export interface UsageReport {
  /** Total tokens — summed from the split when the source gave no total. */
  tokens: number;
  costUsd?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  turns?: number;
  /** Everything else the source said, carried into the attestation's evidence. */
  extra: Record<string, unknown>;
}

const NUMBER_KEYS: Record<keyof Omit<UsageReport, "tokens" | "extra" | "model" | "costUsd">, string[]> = {
  inputTokens: ["inputTokens", "input_tokens", "uncachedInputTokens", "uncached_input_tokens", "promptTokens", "prompt_tokens"],
  outputTokens: ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"],
  cacheReadTokens: ["cacheReadTokens", "cache_read_input_tokens", "cacheReadInputTokens", "cachedTokens", "input_cached_tokens"],
  cacheCreationTokens: ["cacheCreationTokens", "cache_creation_input_tokens", "cacheCreationInputTokens"],
  turns: ["turns", "requests", "num_model_requests", "calls"],
};

const TOTAL_KEYS = ["tokens", "tokensUsed", "tokens_used", "totalTokens", "total_tokens"];
const COST_KEYS = ["costUsd", "cost_usd", "apiCostUsd", "api_cost_usd", "cost", "totalCostUsd", "total_cost_usd"];
const MODEL_KEYS = ["model", "modelId", "model_id"];

const CONSUMED = new Set([...TOTAL_KEYS, ...COST_KEYS, ...MODEL_KEYS, ...Object.values(NUMBER_KEYS).flat(), "usage"]);

function numberAt(source: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const raw = source[name];
    if (raw === undefined || raw === null) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function stringAt(source: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const raw = source[name];
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  }
  return undefined;
}

/**
 * Turn a parsed JSON value into a UsageReport, or null when it carries no usable
 * number at all. A nested `usage` object is merged under the outer keys, so both
 * `{tokens: 9}` and `{usage: {input_tokens: 9}}` work.
 */
export function normalizeUsage(raw: unknown): UsageReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const outer = raw as Record<string, unknown>;
  const nested = outer.usage && typeof outer.usage === "object" && !Array.isArray(outer.usage) ? (outer.usage as Record<string, unknown>) : {};
  const source = { ...nested, ...outer };

  const report: UsageReport = { tokens: 0, extra: {} };
  for (const [field, names] of Object.entries(NUMBER_KEYS) as [keyof typeof NUMBER_KEYS, string[]][]) {
    const value = numberAt(source, names);
    if (value !== undefined) report[field] = Math.round(value);
  }
  const cost = numberAt(source, COST_KEYS);
  if (cost !== undefined) report.costUsd = cost;
  const model = stringAt(source, MODEL_KEYS);
  if (model !== undefined) report.model = model;

  const total = numberAt(source, TOTAL_KEYS);
  const split = (report.inputTokens ?? 0) + (report.outputTokens ?? 0) + (report.cacheReadTokens ?? 0) + (report.cacheCreationTokens ?? 0);
  report.tokens = Math.round(total ?? split);

  for (const [key, value] of Object.entries(source)) {
    if (CONSUMED.has(key)) continue;
    report.extra[key] = value;
  }

  if (report.tokens <= 0 && report.costUsd === undefined) return null;
  return report;
}

/**
 * The last `PTD_USAGE {…}` line in a stream of output.
 *
 * Last wins rather than summing: a program that wants a total prints one marker
 * at the end, and a program that prints one per phase would otherwise have its
 * figures added to a running total nobody asked for.
 */
export function parseUsageMarkers(text: string): UsageReport | null {
  let found: UsageReport | null = null;
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(USAGE_MARKER);
    if (at === -1) continue;
    const rest = line.slice(at + USAGE_MARKER.length).trim();
    const body = rest.startsWith(":") ? rest.slice(1).trim() : rest;
    if (!body.startsWith("{")) continue;
    try {
      const report = normalizeUsage(JSON.parse(body));
      if (report) found = report;
    } catch {
      /* a half-written marker in a truncated log is not an error */
    }
  }
  return found;
}

/** Read a usage JSON file. A missing or unparseable file is "no report", not a failure. */
export function readUsageFile(path: string): UsageReport | null {
  try {
    return normalizeUsage(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** True when this process is running inside GitHub Actions. */
export function isGithubActions(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_ACTIONS === "true" || (Boolean(env.GITHUB_RUN_ID) && Boolean(env.GITHUB_REPOSITORY));
}

/** True when this process is running inside some CI system. */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return isGithubActions(env) || env.CI === "true" || env.CI === "1";
}

const GITHUB_FIELDS: Record<string, string> = {
  repository: "GITHUB_REPOSITORY",
  workflow: "GITHUB_WORKFLOW",
  job: "GITHUB_JOB",
  runId: "GITHUB_RUN_ID",
  runNumber: "GITHUB_RUN_NUMBER",
  runAttempt: "GITHUB_RUN_ATTEMPT",
  sha: "GITHUB_SHA",
  ref: "GITHUB_REF",
  refName: "GITHUB_REF_NAME",
  actor: "GITHUB_ACTOR",
  eventName: "GITHUB_EVENT_NAME",
  serverUrl: "GITHUB_SERVER_URL",
};

/**
 * Evidence for a CI attestation: which run, which commit, which workflow. This
 * is what makes `source: "ci"` checkable — a reader can open the run and see the
 * job that reported the figure.
 */
export function githubEvidence(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, name] of Object.entries(GITHUB_FIELDS)) {
    const value = env[name];
    if (value) out[field] = value;
  }
  if (out.repository && out.runId) {
    const base = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
    out.runUrl = `${base}/${out.repository}/actions/runs/${out.runId}`;
  }
  return out;
}

/** The evidence object an attestation carries: the split, the model, plus context. */
export function evidenceFrom(report: UsageReport | null, context: Record<string, unknown> = {}): Record<string, unknown> {
  const evidence: Record<string, unknown> = { ...context };
  if (!report) return evidence;
  if (report.model) evidence.model = report.model;
  if (report.inputTokens !== undefined) evidence.inputTokens = report.inputTokens;
  if (report.outputTokens !== undefined) evidence.outputTokens = report.outputTokens;
  if (report.cacheReadTokens !== undefined) evidence.cacheReadTokens = report.cacheReadTokens;
  if (report.cacheCreationTokens !== undefined) evidence.cacheCreationTokens = report.cacheCreationTokens;
  if (report.turns !== undefined) evidence.turns = report.turns;
  for (const [key, value] of Object.entries(report.extra)) if (!(key in evidence)) evidence[key] = value;
  return evidence;
}
