import { runAction as defaultRunAction, type ActionContext } from "../../actions/registry";
import type { OutboundEvent } from "../../webhooks";
import { serverContextFor } from "../shared/identity";
import { createIssue, installationToken, patchIssue } from "./api";
import { getGithubForOrg, patchMapping, type GithubMapping, type GithubRow } from "./store";
import { externalKeyFor, parseExternalKey } from "./sync";

/**
 * PTD → GitHub.
 *
 * Called from the same fan-out the webhooks and the Slack adapter use, so a mapped
 * repository sees the task events its organization already publishes: a new card in a
 * mapped stream opens an issue, completing it closes the issue, and retitling or
 * rewriting it edits the issue.
 *
 * Nothing in here throws and nothing is awaited by the caller — a GitHub outage must
 * never fail a task mutation. Every failure is a console warning plus `lastError` on
 * the mapping, and nothing else.
 *
 * The loop guard is `via`. Anything PTD wrote *because of* a GitHub delivery carries
 * `via: "github"` on its event, and is ignored here; anything this module writes back
 * (stamping the new `externalKey` onto the card) also carries `via: "github"`, so the
 * `task.updated` it produces does not come straight back as an issue edit.
 */

const RELEVANT = new Set(["task.created", "task.completed", "task.updated"]);

function warn(message: string, detail?: unknown): void {
  console.warn(`[github] ${message}`, detail instanceof Error ? detail.message : detail ?? "");
}

const rec = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** True when this event is PTD reacting to GitHub — the one case we must not answer. */
export function cameFromGithub(event: OutboundEvent): boolean {
  const payload = rec(event.payload);
  if (str(payload.via) === "github") return true;
  const actor = event.actor as { via?: unknown } | undefined;
  return str(actor?.via) === "github";
}

export interface OutboundDeps {
  runAction: typeof defaultRunAction;
}

export interface NotifyOutcome {
  acted: boolean;
  reason?: string;
  repo?: string;
  issue?: number;
  taskId?: number;
}

function outboundAllowed(mapping: GithubMapping): boolean {
  return mapping.direction === "both" || mapping.direction === "out";
}

/** The mapping for a stream, when outbound is allowed for it. */
function mappingForStream(row: GithubRow, streamId: number | null): GithubMapping | null {
  if (streamId === null) return null;
  const mapping = row.config.mappings.find((m) => m.streamId === streamId);
  return mapping && outboundAllowed(mapping) ? mapping : null;
}

/** The mapping for a repo named by an existing `externalKey`. */
function mappingForRepo(row: GithubRow, repo: string): GithubMapping | null {
  const mapping = row.config.mappings.find((m) => m.repo === repo);
  return mapping && outboundAllowed(mapping) ? mapping : null;
}

async function tokenFor(row: GithubRow): Promise<string | null> {
  const token = await installationToken(row.config.installationId);
  if (!token.ok) {
    warn(`no installation token for org ${row.orgId}: ${token.error}`);
    return null;
  }
  return token.token;
}

async function contextFor(row: GithubRow, mapping: GithubMapping): Promise<ActionContext | null> {
  return serverContextFor(row.orgId, mapping.mappedBy ?? row.config.installedBy ?? row.createdBy ?? null, "github", "manager");
}

/**
 * One event from the Plan surface. Wired into `dispatchWebhooks`, so anything that
 * writes a task event reaches a mapped repository too.
 */
export async function notifyGithub(orgId: number, event: OutboundEvent, overrides: Partial<OutboundDeps> = {}): Promise<NotifyOutcome> {
  const deps: OutboundDeps = { runAction: defaultRunAction, ...overrides };
  try {
    if (!RELEVANT.has(event.kind)) return { acted: false, reason: "irrelevant_kind" };
    if (cameFromGithub(event)) return { acted: false, reason: "loop_guard" };

    const row = await getGithubForOrg(orgId);
    if (!row || !row.enabled) return { acted: false, reason: "not_connected" };

    const task = rec(rec(event.payload).task);
    const taskId = int(task.id) ?? event.taskId ?? null;
    if (taskId === null) return { acted: false, reason: "no_task" };
    const externalKey = str(task.externalKey);

    if (event.kind === "task.created" && !externalKey) return openIssue(row, event, taskId, task, deps);
    if (!externalKey) return { acted: false, reason: "no_external_key" };
    const parsed = parseExternalKey(externalKey);
    if (!parsed) return { acted: false, reason: "external_key_not_github" };
    const mapping = mappingForRepo(row, parsed.repo);
    if (!mapping) return { acted: false, reason: "repo_not_mapped_outbound", repo: parsed.repo };

    if (event.kind === "task.completed") return closeIssue(row, mapping, parsed, taskId);
    return editIssue(row, mapping, parsed, event, task, taskId);
  } catch (err) {
    warn(`notify for ${event.kind} skipped:`, err);
    return { acted: false, reason: "error" };
  }
}

/** A new card in a mapped stream becomes an issue, and the card learns its key. */
async function openIssue(
  row: GithubRow,
  event: OutboundEvent,
  taskId: number,
  task: Record<string, unknown>,
  deps: OutboundDeps,
): Promise<NotifyOutcome> {
  const mapping = mappingForStream(row, int(task.streamId));
  if (!mapping) return { acted: false, reason: "stream_not_mapped_outbound", taskId };
  const token = await tokenFor(row);
  if (!token) return { acted: false, reason: "no_token", taskId };

  const title = str(task.title) ?? `PTD task #${taskId}`;
  const description = str(task.description) ?? "";
  const tags = Array.isArray(task.tags) ? (task.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
  const created = await createIssue(mapping.repo, token, {
    title,
    body: description ? description : `Opened from PTD · task #${taskId}`,
    ...(tags.length > 0 ? { labels: tags } : {}),
  });
  const number = created.data?.number;
  if (!created.ok || typeof number !== "number") {
    warn(`could not open an issue in ${mapping.repo}: ${created.error ?? "no issue number"}`);
    await patchMapping(row.orgId, mapping.streamId, { lastError: created.error ?? "create_issue_failed" }).catch(() => null);
    return { acted: false, reason: created.error ?? "create_issue_failed", repo: mapping.repo, taskId };
  }

  const ctx = await contextFor(row, mapping);
  if (ctx) {
    // via: "github" — so the task.updated this produces is ignored by the guard above.
    await deps
      .runAction("task.update", { taskId, externalKey: externalKeyFor(mapping.repo, number) }, ctx)
      .catch((err: unknown) => warn(`could not store the issue key on task ${taskId}:`, err));
  } else {
    warn(`no member with a manager role to stamp the issue key on task ${taskId}`);
  }
  await patchMapping(row.orgId, mapping.streamId, { lastSyncAt: new Date().toISOString(), lastError: null }).catch(() => null);
  return { acted: true, repo: mapping.repo, issue: number, taskId };
}

async function closeIssue(
  row: GithubRow,
  mapping: GithubMapping,
  parsed: { repo: string; number: number },
  taskId: number,
): Promise<NotifyOutcome> {
  const token = await tokenFor(row);
  if (!token) return { acted: false, reason: "no_token", taskId };
  const res = await patchIssue(parsed.repo, parsed.number, token, { state: "closed", state_reason: "completed" });
  if (!res.ok) {
    warn(`could not close ${parsed.repo}#${parsed.number}: ${res.error}`);
    await patchMapping(row.orgId, mapping.streamId, { lastError: res.error ?? "close_issue_failed" }).catch(() => null);
    return { acted: false, reason: res.error ?? "close_issue_failed", repo: parsed.repo, issue: parsed.number, taskId };
  }
  return { acted: true, repo: parsed.repo, issue: parsed.number, taskId };
}

/** Only the two fields an issue actually has in common with a card. */
async function editIssue(
  row: GithubRow,
  mapping: GithubMapping,
  parsed: { repo: string; number: number },
  event: OutboundEvent,
  task: Record<string, unknown>,
  taskId: number,
): Promise<NotifyOutcome> {
  const changes = rec(rec(event.payload).changes);
  const titleChanged = "title" in changes;
  const bodyChanged = "description" in changes;
  if (!titleChanged && !bodyChanged) return { acted: false, reason: "no_mirrored_field_changed", taskId };

  const token = await tokenFor(row);
  if (!token) return { acted: false, reason: "no_token", taskId };
  const res = await patchIssue(parsed.repo, parsed.number, token, {
    ...(titleChanged ? { title: str(task.title) ?? `PTD task #${taskId}` } : {}),
    ...(bodyChanged ? { body: str(task.description) ?? "" } : {}),
  });
  if (!res.ok) {
    warn(`could not edit ${parsed.repo}#${parsed.number}: ${res.error}`);
    await patchMapping(row.orgId, mapping.streamId, { lastError: res.error ?? "edit_issue_failed" }).catch(() => null);
    return { acted: false, reason: res.error ?? "edit_issue_failed", repo: parsed.repo, issue: parsed.number, taskId };
  }
  return { acted: true, repo: parsed.repo, issue: parsed.number, taskId };
}
