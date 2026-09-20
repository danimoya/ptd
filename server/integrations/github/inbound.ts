import { runAction as defaultRunAction } from "../../actions/registry";
import { recordEvent } from "../../plan/taskEvents";
import { serverContextFor, taskByExternalKey } from "../shared/identity";
import { installationToken, readIssue } from "./api";
import { githubAppEnv } from "./config";
import { findMappingForRepo, patchGithubConfig, patchMapping, type GithubRow, type GithubMapping } from "./store";
import { assigneeResolver, externalKeyFor, noAssigneeResolver, upsertIssueTask, type SyncDeps } from "./sync";

/**
 * One webhook delivery → one registry write.
 *
 * Separated from the route so it can be driven by a fixture: everything below takes a
 * parsed body and returns what it did, and the HTTP layer only verifies the signature
 * and hands the JSON over.
 *
 * Two things stop a loop. Deliveries whose sender is the App's own bot are dropped
 * outright (PTD's own `POST /issues` comes back as an `issues opened` delivery), and
 * every write made here carries `via: "github"`, which is what the outbound side
 * (`notify.ts`) refuses to act on.
 */

/** Issue actions worth a write. `assigned`/`labeled` matter because they change fields. */
export const HANDLED_ISSUE_ACTIONS = new Set([
  "opened",
  "edited",
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "milestoned",
  "demilestoned",
  "transferred",
]);

export const MAX_COMMENT_NOTE = 1_000;

export interface Delivery {
  event: string;
  deliveryId: string | null;
  body: Record<string, unknown>;
}

export interface DeliveryOutcome {
  handled: boolean;
  /** Why it was not handled, for the response body and the server log. */
  reason?: string;
  orgId?: number;
  repo?: string;
  taskId?: number;
  action?: string;
  created?: boolean;
  changed?: boolean;
}

const rec = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export interface InboundDeps {
  runAction: typeof defaultRunAction;
  /** Overridden in tests so no token is minted and no profile is fetched. */
  resolveAssignee?: SyncDeps["resolveAssignee"];
}

/** `ptd-app[bot]` — the App's own identity, whose events would otherwise echo back. */
export function isOwnBot(login: string | null, slug = githubAppEnv().slug): boolean {
  if (!login) return false;
  const lowered = login.toLowerCase();
  if (slug && lowered === `${slug.toLowerCase()}[bot]`) return true;
  return false;
}

async function syncDeps(row: GithubRow, deps: InboundDeps): Promise<SyncDeps> {
  if (deps.resolveAssignee) return { runAction: deps.runAction, resolveAssignee: deps.resolveAssignee };
  const token = await installationToken(row.config.installationId);
  return { runAction: deps.runAction, resolveAssignee: token.ok ? assigneeResolver(token.token) : noAssigneeResolver };
}

/** The member an inbound write is attributed to: whoever mapped the repo, else the installer. */
function actingUserId(row: GithubRow, mapping: GithubMapping): number | null {
  return mapping.mappedBy ?? row.config.installedBy ?? row.createdBy ?? null;
}

export async function handleGithubDelivery(
  delivery: Delivery,
  overrides: Partial<InboundDeps> = {},
): Promise<DeliveryOutcome> {
  const deps: InboundDeps = { runAction: defaultRunAction, ...overrides };
  const body = delivery.body;
  const action = str(body.action) ?? "";
  const sender = str(rec(body.sender).login);
  const repo = str(rec(body.repository).full_name)?.toLowerCase() ?? null;
  const installationId = int(rec(body.installation).id) ?? undefined;

  if (delivery.event === "ping") return { handled: true, reason: "ping", action };
  if (isOwnBot(sender)) return { handled: false, reason: "own_bot", action };

  if (delivery.event === "installation" && (action === "deleted" || action === "suspend")) {
    return disableInstallation(installationId, action);
  }

  if (!repo) return { handled: false, reason: "no_repository", action };
  const found = await findMappingForRepo(repo, installationId);
  if (!found) return { handled: false, reason: "repo_not_mapped", repo, action };
  const { row, mapping } = found;
  if (mapping.direction === "out") return { handled: false, reason: "direction_out_only", repo, orgId: row.orgId, action };

  const userId = actingUserId(row, mapping);
  const ctx = await serverContextFor(row.orgId, userId, "github", "manager");
  if (!ctx) {
    await patchMapping(row.orgId, mapping.streamId, { lastError: "no_member_with_manager_role" }).catch(() => null);
    return { handled: false, reason: "no_acting_member", repo, orgId: row.orgId, action };
  }

  try {
    if (delivery.event === "issues") {
      if (!HANDLED_ISSUE_ACTIONS.has(action)) return { handled: false, reason: `issues_${action || "unknown"}_ignored`, repo, orgId: row.orgId, action };
      const issue = readIssue(body.issue);
      if (!issue) return { handled: false, reason: "not_an_issue", repo, orgId: row.orgId, action };
      const result = await upsertIssueTask(ctx, mapping, issue, await syncDeps(row, deps));
      await patchMapping(row.orgId, mapping.streamId, { lastSyncAt: new Date().toISOString(), lastError: null }).catch(() => null);
      await patchGithubConfig(row.orgId, { lastEventAt: new Date().toISOString(), lastError: null }).catch(() => null);
      return {
        handled: true,
        repo,
        orgId: row.orgId,
        action,
        taskId: result.taskId,
        created: result.created,
        changed: result.changed,
      };
    }

    if (delivery.event === "issue_comment") {
      if (action !== "created") return { handled: false, reason: `issue_comment_${action || "unknown"}_ignored`, repo, orgId: row.orgId, action };
      return await recordComment(row, mapping, body, ctx.userId, ctx.displayName);
    }

    return { handled: false, reason: `event_${delivery.event}_ignored`, repo, orgId: row.orgId, action };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[github] delivery ${delivery.deliveryId ?? "?"} (${delivery.event}.${action}) failed:`, message);
    await patchMapping(row.orgId, mapping.streamId, { lastError: message }).catch(() => null);
    await patchGithubConfig(row.orgId, { lastError: message }).catch(() => null);
    return { handled: false, reason: `error: ${message}`, repo, orgId: row.orgId, action };
  }
}

/**
 * A comment is not a field, so it becomes history rather than a card edit: one
 * `task_events` row of kind `updated`, carrying the comment as its note. The card's
 * History panel then reads as the conversation it is.
 */
async function recordComment(
  row: GithubRow,
  mapping: GithubMapping,
  body: Record<string, unknown>,
  userId: number,
  displayName: string,
): Promise<DeliveryOutcome> {
  const issue = readIssue(body.issue);
  if (!issue) return { handled: false, reason: "not_an_issue", repo: mapping.repo, orgId: row.orgId, action: "created" };
  const comment = rec(body.comment);
  const login = str(rec(comment.user).login) ?? "someone";
  const text = (str(comment.body) ?? "").replace(/\s+/g, " ").trim();
  const task = await taskByExternalKey(row.orgId, externalKeyFor(mapping.repo, issue.number));
  if (!task) return { handled: false, reason: "no_task_for_issue", repo: mapping.repo, orgId: row.orgId, action: "created" };

  const note = `GitHub comment by @${login}: ${text.slice(0, MAX_COMMENT_NOTE)}${text.length > MAX_COMMENT_NOTE ? "…" : ""}`;
  await recordEvent({
    taskId: task.id,
    orgId: row.orgId,
    actor: { userId, label: `${displayName} (via GitHub)`, isAgent: false, via: "github" },
    kind: "updated",
    note,
  });
  await patchGithubConfig(row.orgId, { lastEventAt: new Date().toISOString() }).catch(() => null);
  return { handled: true, repo: mapping.repo, orgId: row.orgId, action: "created", taskId: task.id, changed: true };
}

/** The App was uninstalled or suspended: stop trying, but keep the mappings. */
async function disableInstallation(installationId: number | undefined, action: string): Promise<DeliveryOutcome> {
  if (installationId === undefined) return { handled: false, reason: "no_installation_id", action };
  const { githubRowsForInstallation } = await import("./store");
  const rows = await githubRowsForInstallation(installationId);
  for (const row of rows) {
    await patchGithubConfig(row.orgId, { lastError: `installation_${action}` }).catch(() => null);
  }
  return { handled: true, reason: `installation_${action}`, action, orgId: rows[0]?.orgId };
}
