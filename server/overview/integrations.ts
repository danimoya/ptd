import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { orgIntegrations } from "../../db/schema";
import { ActionError } from "../actions/registry";
import {
  buildEnvelope, deliver, generateWebhookSecret, isWebhookConfig, sealSecret, signBody, readSecret,
  type WebhookConfig,
} from "../webhooks";

/** What a client is allowed to see about a webhook: never the secret, only its shape. */
export interface WebhookView {
  id: number;
  url: string;
  events: string[];
  enabled: boolean;
  createdBy: number | null;
  createdAt: Date;
  secretSet: boolean;
  signatureHeader: string;
}

const SIGNATURE_HEADER = "X-PTD-Signature";

function view(row: typeof orgIntegrations.$inferSelect): WebhookView {
  const config = row.config as Partial<WebhookConfig>;
  return {
    id: row.id,
    url: String(config.url ?? ""),
    events: Array.isArray(config.events) && config.events.length > 0 ? config.events : ["*"],
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    secretSet: typeof config.secret === "string" && config.secret.length > 0,
    signatureHeader: SIGNATURE_HEADER,
  };
}

export async function listWebhooks(orgId: number): Promise<WebhookView[]> {
  const rows = await db
    .select()
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, "webhook")))
    .orderBy(orgIntegrations.createdAt);
  return rows.map(view);
}

/** Only http(s), and no credentials smuggled in the URL. */
function assertUrl(raw: string) {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ActionError("invalid", "url must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ActionError("invalid", "url must use http or https");
  }
  if (parsed.username || parsed.password) throw new ActionError("invalid", "url must not embed credentials");
  return parsed.toString();
}

export async function createWebhook(
  orgId: number,
  createdBy: number,
  input: { url: string; secret?: string; events?: string[] },
) {
  const url = assertUrl(input.url);
  // Generated when absent, and handed back exactly once — it is sealed from here on.
  const secret = input.secret?.trim() || generateWebhookSecret();
  const events = input.events && input.events.length > 0 ? input.events : ["*"];
  const config: WebhookConfig = { url, secret: sealSecret(secret), events };
  const [row] = await db
    .insert(orgIntegrations)
    .values({ orgId, kind: "webhook", config: config as unknown as Record<string, unknown>, enabled: true, createdBy })
    .returning();
  return {
    ...view(row),
    secret,
    secretShownOnce: true,
    signature: `${SIGNATURE_HEADER}: ${signBody('{"example":true}', secret)}`,
    note: "Store this secret now — it is encrypted at rest (AES-256-GCM) and never returned again.",
  };
}

export async function deleteWebhook(orgId: number, id: number) {
  const rows = await db
    .delete(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.id, id), eq(orgIntegrations.kind, "webhook")))
    .returning({ id: orgIntegrations.id });
  if (rows.length === 0) throw new ActionError("not_found", `No webhook ${id} in this organization`);
  return { deleted: id };
}

/** Send a `ping` envelope through the real delivery path so signing is exercised too. */
export async function testWebhook(orgId: number, id: number, actorLabel: string) {
  const [row] = await db
    .select()
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.id, id), eq(orgIntegrations.kind, "webhook")))
    .limit(1);
  if (!row) throw new ActionError("not_found", `No webhook ${id} in this organization`);
  const config = row.config as unknown;
  if (!isWebhookConfig(config)) throw new ActionError("invalid", "Webhook has no url configured");

  const body = JSON.stringify(buildEnvelope(orgId, { kind: "ping", actor: { userId: null, label: actorLabel }, payload: { test: true } }));
  const result = await deliver(config, body);
  return {
    id,
    url: config.url,
    delivered: result.ok,
    status: result.status ?? null,
    error: result.error ?? null,
    signature: signBody(body, readSecret(config.secret)),
    body: JSON.parse(body),
  };
}
