/**
 * The one place PTD talks to a large language model.
 *
 * Three rules shape this file:
 *
 *  1. **Off by default.** PTD is open-core and most self-hosters have no key,
 *     so nothing here runs until PTD_AI_PROVIDER *and* PTD_AI_API_KEY are set.
 *     `aiStatus()` is the only function that is safe to call unconfigured.
 *  2. **No SDK.** `fetch` against two documented REST shapes, the same posture
 *     as server/billing/stripe.ts — a self-hoster should not have to audit two
 *     vendor SDKs for a feature they may never switch on. `fetchImpl` is
 *     injectable so tests drive a stub instead of the network.
 *  3. **One narrow job.** Everything goes through `completeJSON`: a system
 *     prompt, a user prompt, a JSON schema, and a validated object back. No
 *     streaming, no multi-turn, no tool loop — a priority suggestion is one
 *     request and one object.
 *
 * Privacy: the prompt carries a card's title and description, so it is only
 * ever logged when PTD_AI_DEBUG is set. The info-level line carries model,
 * tokens, cost and duration — never the text.
 */
import { and, eq } from "drizzle-orm";
import { orgIntegrations } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../crypto";
import {
  DEFAULT_MODELS,
  estimateCostUsd,
  type AiProviderName,
} from "./pricing";
import { currentUsageScope, recordCall, type AiCallRecord } from "./usage";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Every provider call is capped at 30s; a suggestion is not worth a hung request. */
export const AI_TIMEOUT_MS = 30_000;
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_MAX_TOKENS = 1024;

const DEFAULT_BASE_URLS: Record<AiProviderName, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

export const AI_NOT_CONFIGURED =
  "AI provider not configured — set PTD_AI_PROVIDER and PTD_AI_API_KEY";

export class AiNotConfiguredError extends Error {
  constructor(message = AI_NOT_CONFIGURED) {
    super(message);
    this.name = "AiNotConfiguredError";
  }
}

/** A provider answered, but not with something usable. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly provider: AiProviderName,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export interface AiConfig {
  provider: AiProviderName;
  model: string;
  /** Kept out of every log line and every response body. */
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /**
   * Whose key this is: the organization's own (`org`) or the deployment's
   * (`env`). It decides whether the call is metered — see server/billing/metering.ts.
   */
  source?: "org" | "env";
}

export type AiEnv = Record<string, string | undefined>;

function isProvider(value: string | undefined): value is AiProviderName {
  return value === "anthropic" || value === "openai";
}

/** Trailing slashes and a trailing `/v1` are both tolerated on PTD_AI_BASE_URL. */
function normaliseBase(raw: string): string {
  let base = raw.trim().replace(/\/+$/, "");
  if (base.toLowerCase().endsWith("/v1")) base = base.slice(0, -3);
  return base.replace(/\/+$/, "");
}

/**
 * The configuration, or null when this deployment has no AI. Never throws — the
 * status action calls it on every page load.
 */
export function aiConfigFromEnv(env: AiEnv = process.env): AiConfig | null {
  const provider = env.PTD_AI_PROVIDER?.trim().toLowerCase();
  const apiKey = env.PTD_AI_API_KEY?.trim();
  if (!isProvider(provider) || !apiKey) return null;
  const timeout = Number(env.PTD_AI_TIMEOUT_MS ?? "");
  return {
    provider,
    model: env.PTD_AI_MODEL?.trim() || DEFAULT_MODELS[provider],
    apiKey,
    baseUrl: env.PTD_AI_BASE_URL?.trim() ? normaliseBase(env.PTD_AI_BASE_URL) : DEFAULT_BASE_URLS[provider],
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : AI_TIMEOUT_MS,
    source: "env",
  };
}

/* ── an organization's own key ────────────────────────────────────────────── */

/**
 * On the hosted instance an organization may bring its own provider key, and most
 * should: its calls then cost PTD nothing and are metered nowhere. The key is sealed
 * with AES-256-GCM under `PTD_SECRET_KEY` (server/crypto.ts) in `org_integrations`
 * under kind `ai` — the same envelope the Slack and GitHub credentials use — and is
 * never returned by any action. `keyHint` (last four characters) is what the UI
 * shows so an admin can tell two keys apart.
 *
 * `../../db` is imported lazily, exactly as server/ai/usage.ts does it, so the
 * provider tests keep running without a database.
 */
export const AI_KIND = "ai";

export interface OrgAiKeyConfig {
  provider: AiProviderName;
  model?: string;
  apiKeySealed: string;
  keyHint: string;
  baseUrl?: string;
  connectedAt: string;
  connectedBy: number | null;
}

/** What an action may say out loud about an organization's key. */
export interface OrgAiKeyView {
  connected: boolean;
  provider: AiProviderName | null;
  model: string | null;
  keyHint: string | null;
  connectedAt: string | null;
  connectedBy: number | null;
}

export const NO_ORG_AI_KEY: OrgAiKeyView = {
  connected: false,
  provider: null,
  model: null,
  keyHint: null,
  connectedAt: null,
  connectedBy: null,
};

async function database() {
  return (await import("../../db")).db;
}

function keyHint(key: string): string {
  const tail = key.trim().slice(-4);
  return tail.length === 4 ? `…${tail}` : "…";
}

function asOrgKeyConfig(raw: unknown): OrgAiKeyConfig | null {
  const c = (raw ?? {}) as Partial<OrgAiKeyConfig>;
  if (!isProvider(c.provider) || typeof c.apiKeySealed !== "string" || c.apiKeySealed === "") return null;
  return {
    provider: c.provider,
    ...(typeof c.model === "string" && c.model ? { model: c.model } : {}),
    apiKeySealed: c.apiKeySealed,
    keyHint: typeof c.keyHint === "string" ? c.keyHint : "…",
    ...(typeof c.baseUrl === "string" && c.baseUrl ? { baseUrl: c.baseUrl } : {}),
    connectedAt: typeof c.connectedAt === "string" ? c.connectedAt : "",
    connectedBy: typeof c.connectedBy === "number" ? c.connectedBy : null,
  };
}

export function orgKeyView(config: OrgAiKeyConfig | null): OrgAiKeyView {
  if (!config) return { ...NO_ORG_AI_KEY };
  return {
    connected: true,
    provider: config.provider,
    model: config.model ?? DEFAULT_MODELS[config.provider],
    keyHint: config.keyHint,
    connectedAt: config.connectedAt || null,
    connectedBy: config.connectedBy,
  };
}

export async function readOrgAiKey(orgId: number): Promise<OrgAiKeyConfig | null> {
  const db = await database();
  const [row] = await db
    .select({ config: orgIntegrations.config, enabled: orgIntegrations.enabled })
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, AI_KIND)))
    .limit(1);
  if (!row || row.enabled === false) return null;
  return asOrgKeyConfig(row.config);
}

/** Seal a key onto the organization, replacing whatever was there. */
export async function connectOrgAiKey(
  orgId: number,
  input: { provider: AiProviderName; apiKey: string; model?: string; baseUrl?: string },
  userId: number | null,
): Promise<OrgAiKeyView> {
  const db = await database();
  const config: OrgAiKeyConfig = {
    provider: input.provider,
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    apiKeySealed: encryptSecret(input.apiKey.trim()),
    keyHint: keyHint(input.apiKey),
    ...(input.baseUrl?.trim() ? { baseUrl: normaliseBase(input.baseUrl) } : {}),
    connectedAt: new Date().toISOString(),
    connectedBy: userId,
  };
  const [existing] = await db
    .select({ id: orgIntegrations.id })
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, AI_KIND)))
    .limit(1);
  if (existing) {
    await db
      .update(orgIntegrations)
      .set({ config: config as unknown as Record<string, unknown>, enabled: true, createdBy: userId })
      .where(eq(orgIntegrations.id, existing.id));
  } else {
    await db
      .insert(orgIntegrations)
      .values({ orgId, kind: AI_KIND, config: config as unknown as Record<string, unknown>, enabled: true, createdBy: userId });
  }
  return orgKeyView(config);
}

export async function disconnectOrgAiKey(orgId: number): Promise<{ disconnected: boolean }> {
  const db = await database();
  const rows = await db
    .delete(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, AI_KIND)))
    .returning({ id: orgIntegrations.id });
  return { disconnected: rows.length > 0 };
}

/** The organization's own configuration, opened for one call. */
export function configFromOrgKey(config: OrgAiKeyConfig, env: AiEnv = process.env): AiConfig {
  const timeout = Number(env.PTD_AI_TIMEOUT_MS ?? "");
  let apiKey: string;
  try {
    apiKey = decryptSecret(config.apiKeySealed);
  } catch {
    // Tolerate a plaintext value seeded by an operator's script, the way
    // server/usage/store.ts does.
    apiKey = config.apiKeySealed;
  }
  return {
    provider: config.provider,
    model: config.model || DEFAULT_MODELS[config.provider],
    apiKey,
    baseUrl: config.baseUrl ? normaliseBase(config.baseUrl) : DEFAULT_BASE_URLS[config.provider],
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : AI_TIMEOUT_MS,
    source: "org",
  };
}

export interface ResolvedAi {
  config: AiConfig | null;
  source: "org" | "env" | null;
  /** Whether the organization brought its own key. */
  orgKey: OrgAiKeyView;
  /** Whether this deployment has a key of its own to fall back on. */
  serverConfigured: boolean;
}

/**
 * Which key answers for this organization: its own first, the deployment's second.
 *
 * The order is deliberate. An organization that has connected a key has said "bill
 * me directly"; falling back to PTD's key would quietly start charging it cost + 20%
 * for calls it is already paying for.
 */
export async function resolveAiConfig(orgId: number, env: AiEnv = process.env): Promise<ResolvedAi> {
  const fromEnv = aiConfigFromEnv(env);
  let stored: OrgAiKeyConfig | null = null;
  try {
    stored = await readOrgAiKey(orgId);
  } catch (err) {
    // A missing row is null; a broken read must not take the whole action down.
    console.warn("[ai] could not read the organization's key:", err instanceof Error ? err.message : err);
  }
  if (stored) {
    return { config: configFromOrgKey(stored, env), source: "org", orgKey: orgKeyView(stored), serverConfigured: Boolean(fromEnv) };
  }
  return { config: fromEnv, source: fromEnv ? "env" : null, orgKey: { ...NO_ORG_AI_KEY }, serverConfigured: Boolean(fromEnv) };
}

/* ── metering hook ────────────────────────────────────────────────────────── */

export interface AiMeterCall {
  orgId: number;
  userId: number | null;
  provider: AiProviderName;
  model: string;
  label: string;
  at: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Whose key paid. Only `env` — PTD's own — is ever billed on. */
  source: "org" | "env";
}

export type AiMeterHook = (call: AiMeterCall) => void;

let meterHook: AiMeterHook | null = null;

/**
 * Installed by server/actions/ai.ts at import time, so a provider call made on the
 * hosted instance with PTD's key lands on the `ptd_ai_usage_cents` meter. The
 * provider layer knows the cost and the key's origin; only the billing layer knows
 * what to do with them — which is why this is a hook and not an import.
 */
export function setAiMeterHook(hook: AiMeterHook | null): void {
  meterHook = hook;
}

export interface AiStatus {
  configured: boolean;
  provider: AiProviderName | null;
  model: string | null;
}

/** What `ai.status` returns. Safe unconfigured; never carries the key. */
export function aiStatus(env: AiEnv = process.env): AiStatus {
  const config = aiConfigFromEnv(env);
  return config
    ? { configured: true, provider: config.provider, model: config.model }
    : { configured: false, provider: null, model: null };
}

export function requireAiConfig(env: AiEnv = process.env): AiConfig {
  const config = aiConfigFromEnv(env);
  if (!config) throw new AiNotConfiguredError();
  return config;
}

/**
 * A JSON contract: the schema the provider is held to, plus the validator that
 * turns its answer into a typed object. `parse` throws on anything invalid,
 * which is what triggers the single retry.
 */
export interface JsonSpec<T> {
  /** Tool name (Anthropic) / schema name (OpenAI). Lowercase snake_case. */
  name: string;
  description: string;
  /** JSON Schema for an object, with `required` and additionalProperties:false. */
  schema: Record<string, unknown>;
  parse: (value: unknown) => T;
}

export interface AiUsage {
  provider: AiProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
  /** HTTP round-trips, including the retry for an unusable answer. */
  attempts: number;
  durationMs: number;
}

export interface CompleteJSONResult<T> {
  data: T;
  usage: AiUsage;
}

export interface CompleteJSONArgs<T> {
  system: string;
  user: string;
  schema: JsonSpec<T>;
  maxTokens?: number;
  /** Which action asked, for the usage ledger. */
  label?: string;
}

export interface CompleteJSONOptions {
  config?: AiConfig;
  fetchImpl?: FetchLike;
  env?: AiEnv;
}

interface RawAnswer {
  /** The object the provider produced, when it came back as structured output. */
  value?: unknown;
  /** The text it produced instead, to be mined for JSON by the parse stage. */
  text?: string;
  inputTokens: number;
  outputTokens: number;
}

const debugLog = (...args: unknown[]) => {
  if (process.env.PTD_AI_DEBUG) console.debug("[ai]", ...args);
};

/**
 * One request, one validated object, at most one retry.
 *
 * The retry is not a second chance at a better answer — it is the answer to
 * "the model wrapped its JSON in prose" or "it sent 7.5 for an integer field".
 * It re-asks with the parse error quoted, which fixes both without a
 * conversation to replay.
 */
export async function completeJSON<T>(
  args: CompleteJSONArgs<T>,
  opts: CompleteJSONOptions = {},
): Promise<CompleteJSONResult<T>> {
  const config = opts.config ?? requireAiConfig(opts.env);
  const doFetch = opts.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const maxTokens = args.maxTokens ?? DEFAULT_MAX_TOKENS;
  const label = args.label ?? "ai";
  const started = Date.now();

  let inputTokens = 0;
  let outputTokens = 0;
  let attempts = 0;
  let lastError: unknown = null;
  let userText = args.user;
  /**
   * Anthropic's newest tier rejects a forced tool_choice, so the first 400 that
   * blames tool_choice flips us to `auto` + "call the tool" in the prompt.
   */
  let forceTool = true;
  /** Some OpenAI-compatible models want max_completion_tokens instead. */
  let openaiTokenField: "max_tokens" | "max_completion_tokens" = "max_tokens";
  let openaiTemperature = true;

  const finish = (ok: boolean): AiUsage => {
    const { costUsd, priced } = estimateCostUsd(config.provider, config.model, inputTokens, outputTokens);
    const usage: AiUsage = {
      provider: config.provider,
      model: config.model,
      inputTokens,
      outputTokens,
      costUsd,
      priced,
      attempts,
      durationMs: Date.now() - started,
    };
    const record: AiCallRecord = {
      at: new Date().toISOString(),
      provider: usage.provider,
      model: usage.model,
      label,
      inputTokens,
      outputTokens,
      costUsd,
      priced,
      attempts,
      durationMs: usage.durationMs,
      ok,
    };
    recordCall(record);

    // The organization that is paying comes from the usage scope the action set;
    // without one (a unit test, a script) there is nobody to bill.
    const scope = currentUsageScope();
    if (meterHook && scope && ok) {
      try {
        meterHook({
          orgId: scope.orgId,
          userId: scope.userId,
          provider: usage.provider,
          model: usage.model,
          label,
          at: record.at,
          inputTokens,
          outputTokens,
          costUsd,
          source: config.source ?? "env",
        });
      } catch (err) {
        console.warn("[ai] metering hook threw:", err instanceof Error ? err.message : err);
      }
    }
    // Info level: numbers only. The prompt carries card titles and descriptions.
    console.log(
      `[ai] ${label} ${usage.provider}/${usage.model} in=${inputTokens} out=${outputTokens} ` +
        `cost=$${costUsd.toFixed(6)} attempts=${attempts} ${usage.durationMs}ms ${ok ? "ok" : "failed"}`,
    );
    return usage;
  };

  // Two attempts: the honest try, then the one that quotes the parse error.
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts += 1;
    let raw: RawAnswer;
    try {
      debugLog(`attempt ${attempts}`, { provider: config.provider, model: config.model, system: args.system, user: userText });
      raw =
        config.provider === "anthropic"
          ? await callAnthropic(config, args.system, userText, args.schema, maxTokens, doFetch, forceTool)
          : await callOpenAI(config, args.system, userText, args.schema, maxTokens, doFetch, openaiTokenField, openaiTemperature);
      inputTokens += raw.inputTokens;
      outputTokens += raw.outputTokens;
    } catch (error) {
      lastError = error;
      // A parameter the deployment's model does not accept is worth exactly one
      // adjusted retry; anything else is the caller's problem.
      const adjusted = adjustForRejection(error, config.provider, () => {
        forceTool = false;
      }, (field, temp) => {
        openaiTokenField = field;
        openaiTemperature = temp;
      });
      if (adjusted && attempt === 0) continue;
      finish(false);
      throw error;
    }

    try {
      // Both halves live in the same try on purpose: "that is not JSON" and "that
      // is JSON of the wrong shape" are the same class of problem and get the
      // same single retry.
      const candidate = "value" in raw && raw.value !== undefined ? raw.value : extractJson(raw.text ?? "", config.provider);
      const data = args.schema.parse(candidate);
      return { data, usage: finish(true) };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      debugLog("invalid answer", message);
      userText =
        `${args.user}\n\nYour previous reply could not be used: ${message}. ` +
        `Reply again with ONLY a JSON object matching the schema exactly — no prose, no code fence, ` +
        `integers where integers are asked for.`;
    }
  }

  finish(false);
  throw new AiProviderError(
    `${config.provider} returned no usable JSON after 2 attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    502,
    config.provider,
  );
}

/**
 * Detect the two provider rejections worth retrying with a different request
 * shape, and apply the adjustment. Returns true when a retry makes sense.
 */
function adjustForRejection(
  error: unknown,
  provider: AiProviderName,
  dropForcedTool: () => void,
  switchTokenField: (field: "max_tokens" | "max_completion_tokens", temperature: boolean) => void,
): boolean {
  if (!(error instanceof AiProviderError) || error.status !== 400) return false;
  const message = error.message.toLowerCase();
  if (provider === "anthropic" && message.includes("tool_choice")) {
    dropForcedTool();
    return true;
  }
  if (provider === "openai" && (message.includes("max_tokens") || message.includes("temperature"))) {
    switchTokenField("max_completion_tokens", false);
    return true;
  }
  return false;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  doFetch: FetchLike,
  provider: AiProviderName,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AiProviderError(`${provider} did not answer within ${timeoutMs}ms`, 504, provider);
    }
    throw new AiProviderError(
      `${provider} request failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
      provider,
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseEnvelope(provider: AiProviderName, status: number, text: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AiProviderError(
      `${provider} returned ${status} with a non-JSON body: ${text.slice(0, 200)}`,
      status >= 400 ? status : 502,
      provider,
    );
  }
  if (status < 200 || status >= 300) {
    const err = (body as { error?: { message?: string; type?: string } }).error;
    throw new AiProviderError(err?.message ?? `${provider} returned ${status}`, status, provider);
  }
  return body as Record<string, unknown>;
}

/**
 * Anthropic Messages API. The schema is handed over as a single strict tool and
 * the model is forced to call it, which is the documented way to get an object
 * of a known shape back; `strict: true` makes the arguments schema-valid, so
 * only prose-instead-of-a-call needs the text fallback below.
 */
async function callAnthropic<T>(
  config: AiConfig,
  system: string,
  user: string,
  spec: JsonSpec<T>,
  maxTokens: number,
  doFetch: FetchLike,
  forceTool: boolean,
): Promise<RawAnswer> {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    tools: [
      {
        name: spec.name,
        description: spec.description,
        input_schema: spec.schema,
        strict: true,
      },
    ],
    tool_choice: forceTool ? { type: "tool", name: spec.name } : { type: "auto" },
  };

  const { status, text } = await postJson(
    `${config.baseUrl}/v1/messages`,
    { "x-api-key": config.apiKey, "anthropic-version": ANTHROPIC_VERSION },
    body,
    config.timeoutMs,
    doFetch,
    "anthropic",
  );
  const envelope = parseEnvelope("anthropic", status, text);

  // A policy decline arrives as HTTP 200 with stop_reason "refusal".
  if (envelope.stop_reason === "refusal") {
    const details = envelope.stop_details as { category?: string; explanation?: string } | undefined;
    throw new AiProviderError(
      `anthropic declined this request${details?.category ? ` (${details.category})` : ""}`,
      403,
      "anthropic",
    );
  }

  const content = Array.isArray(envelope.content) ? (envelope.content as Record<string, unknown>[]) : [];
  const call = content.find((b) => b.type === "tool_use" && b.name === spec.name);
  const usage = (envelope.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  const tokens = {
    inputTokens: Number(usage.input_tokens ?? 0) || 0,
    outputTokens: Number(usage.output_tokens ?? 0) || 0,
  };
  if (call && call.input && typeof call.input === "object") return { value: call.input, ...tokens };

  // No call: either tool_choice was auto or the model answered in prose. Both
  // are recoverable if the text happens to be the JSON we asked for.
  const said = content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
  if (!said) {
    throw new AiProviderError(
      `anthropic returned neither a ${spec.name} call nor any text (stop_reason ${String(envelope.stop_reason)})`,
      502,
      "anthropic",
    );
  }
  return { text: said, ...tokens };
}

/**
 * OpenAI Chat Completions with `response_format: {type: "json_object"}` — the
 * documented JSON mode. It guarantees syntactically valid JSON, not a
 * schema-valid object, so the spec's validator still does the real work.
 */
async function callOpenAI<T>(
  config: AiConfig,
  system: string,
  user: string,
  spec: JsonSpec<T>,
  maxTokens: number,
  doFetch: FetchLike,
  tokenField: "max_tokens" | "max_completion_tokens",
  withTemperature: boolean,
): Promise<RawAnswer> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      // JSON mode requires the word "json" somewhere in the prompt; the schema
      // block the caller builds always carries it, and so does this line.
      { role: "system", content: `${system}\n\nAnswer with a single JSON object matching this JSON schema:\n${JSON.stringify(spec.schema)}` },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    [tokenField]: maxTokens,
  };
  if (withTemperature) body.temperature = 0;

  const { status, text } = await postJson(
    `${config.baseUrl}/v1/chat/completions`,
    { Authorization: `Bearer ${config.apiKey}` },
    body,
    config.timeoutMs,
    doFetch,
    "openai",
  );
  const envelope = parseEnvelope("openai", status, text);

  const choices = Array.isArray(envelope.choices) ? (envelope.choices as Record<string, unknown>[]) : [];
  const message = (choices[0]?.message ?? {}) as { content?: unknown; refusal?: unknown };
  const usage = (envelope.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
  const tokens = {
    inputTokens: Number(usage.prompt_tokens ?? 0) || 0,
    outputTokens: Number(usage.completion_tokens ?? 0) || 0,
  };
  if (typeof message.refusal === "string" && message.refusal.trim()) {
    throw new AiProviderError(`openai declined this request: ${message.refusal}`, 403, "openai");
  }
  if (typeof message.content !== "string" || !message.content.trim()) {
    const reason = choices[0]?.finish_reason;
    throw new AiProviderError(`openai returned an empty message (finish_reason ${String(reason)})`, 502, "openai");
  }
  return { text: message.content, ...tokens };
}

/**
 * JSON out of a text block: tolerate a ```json fence and any preamble, because
 * an unforced model that decides to explain itself is otherwise a lost call.
 */
export function extractJson(text: string, provider: AiProviderName): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const attempt = (s: string): unknown => JSON.parse(s);
  try {
    return attempt(candidate);
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return attempt(candidate.slice(first, last + 1));
      } catch {
        /* fall through */
      }
    }
  }
  throw new AiProviderError(`${provider} did not return JSON: ${candidate.slice(0, 200)}`, 502, provider);
}
