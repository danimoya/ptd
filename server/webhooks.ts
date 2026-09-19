import { createHmac, randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { orgIntegrations } from "../db/schema";
import { decryptSecret, encryptSecret } from "./crypto";

// Outgoing webhooks per organization (org_integrations.kind = "webhook").
// The signature below is the contract other modules call — see the Plan surface's
// task-event writer, which fires one of these per task mutation.
export interface OutboundEvent {
  kind: string;
  taskId?: number;
  actor?: { userId: number | null; label: string | null; isAgent?: boolean };
  payload?: unknown;
}

/** Shape stored in org_integrations.config for kind = "webhook". `secret` is sealed at rest. */
export interface WebhookConfig {
  url: string;
  /** AES-256-GCM sealed (server/crypto.ts). Never returned to a client after creation. */
  secret: string;
  /** Event kinds to deliver; `["*"]` (the default) means everything. */
  events: string[];
}

export const WEBHOOK_TIMEOUT_MS = 5_000;
const SIGNATURE_HEADER = "X-PTD-Signature";

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/** `sha256=<hex HMAC-SHA256 of the exact request body>`, keyed with the webhook's plaintext secret. */
export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function isWebhookConfig(config: unknown): config is WebhookConfig {
  const c = config as Partial<WebhookConfig> | null;
  return !!c && typeof c.url === "string" && c.url.length > 0;
}

function matches(events: string[] | undefined, kind: string): boolean {
  if (!events || events.length === 0 || events.includes("*")) return true;
  return events.includes(kind);
}

/** Decrypt a stored secret; tolerate a legacy/hand-written plaintext value. */
export function readSecret(sealed: string | undefined): string {
  if (!sealed) return "";
  try {
    return decryptSecret(sealed);
  } catch {
    return sealed;
  }
}

export function sealSecret(plain: string): string {
  return encryptSecret(plain);
}

/** One delivery. Resolves with the outcome; never throws. */
export async function deliver(
  config: WebhookConfig,
  body: string,
  timeoutMs = WEBHOOK_TIMEOUT_MS,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ptd-webhooks/1",
        [SIGNATURE_HEADER]: signBody(body, readSecret(config.secret)),
      },
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: controller.signal.aborted ? `timeout after ${timeoutMs}ms` : message };
  } finally {
    clearTimeout(timer);
  }
}

/** The JSON envelope every subscriber receives. */
export function buildEnvelope(orgId: number, event: OutboundEvent) {
  return {
    event: event.kind,
    orgId,
    taskId: event.taskId ?? null,
    actor: event.actor ?? null,
    payload: event.payload ?? null,
    ts: new Date().toISOString(),
  };
}

/**
 * Fan an event out to every enabled webhook integration of the org.
 * Fire-and-forget: callers never await delivery and never see a failure —
 * a broken subscriber must not be able to fail a task mutation.
 */
export async function dispatchWebhooks(orgId: number, event: OutboundEvent): Promise<void> {
  try {
    // The Slack adapter listens to the same fan-out; it never throws and is never awaited.
    void import("./integrations/slack/notify").then((slack) => slack.notifySlack(orgId, event)).catch(() => {});
    const rows = await db
      .select({ id: orgIntegrations.id, config: orgIntegrations.config })
      .from(orgIntegrations)
      .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, "webhook"), eq(orgIntegrations.enabled, true)));
    if (rows.length === 0) return;
    const body = JSON.stringify(buildEnvelope(orgId, event));
    for (const row of rows) {
      const config = row.config as unknown;
      if (!isWebhookConfig(config)) continue;
      if (!matches(config.events, event.kind)) continue;
      void deliver(config, body).then((result) => {
        if (!result.ok) {
          console.warn(`[webhook ${row.id}] ${event.kind} → ${config.url} failed: ${result.error ?? `HTTP ${result.status}`}`);
        }
      });
    }
  } catch (err) {
    console.warn("[webhook] dispatch skipped:", err instanceof Error ? err.message : err);
  }
}
