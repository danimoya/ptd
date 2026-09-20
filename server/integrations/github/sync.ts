import type { ActionContext } from "../../actions/registry";
import { runAction as defaultRunAction } from "../../actions/registry";
import { memberByEmail } from "../shared/identity";
import { installationToken, listOpenIssues, userEmail, type GithubIssue } from "./api";
import type { GithubMapping, GithubRow } from "./store";

/**
 * Issue → task.
 *
 * Every write goes through the registry (`task.find_or_create`, `task.update`,
 * `task.complete`) as the member who mapped the repository, with `via: "github"`.
 * Nothing here touches the tasks table directly, which is what makes an imported issue
 * indistinguishable from a card someone typed: same validation, same role gate, same
 * history row, same cascade.
 *
 * Idempotence is the whole design. `externalKey` is `gh:owner/name#N`, unique per
 * organization, so `find_or_create` either returns the existing card or makes it; the
 * follow-up update sends the issue's current state and `diffTask` suppresses the event
 * when nothing actually moved. Replaying a delivery therefore changes nothing — which
 * is also why the webhook needs no replay window.
 */

export interface SyncDeps {
  runAction: typeof defaultRunAction;
  /** GitHub login → PTD user id, or null when it cannot be matched to a seat. */
  resolveAssignee: (orgId: number, login: string) => Promise<number | null>;
}

/** `gh:owner/name#12` — the stable key both directions agree on. */
export function externalKeyFor(repo: string, issueNumber: number): string {
  return `gh:${repo.toLowerCase()}#${issueNumber}`;
}

export function parseExternalKey(key: string | null | undefined): { repo: string; number: number } | null {
  const match = /^gh:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d{1,9})$/.exec((key ?? "").trim());
  if (!match) return null;
  return { repo: match[1].toLowerCase(), number: Number(match[2]) };
}

/** Issue bodies can be enormous; a card's description does not need to be. */
export const MAX_DESCRIPTION = 8_000;

export function descriptionFrom(issue: GithubIssue): string | null {
  const body = (issue.body ?? "").trim();
  if (!body) return null;
  return body.length > MAX_DESCRIPTION ? `${body.slice(0, MAX_DESCRIPTION)}\n\n…truncated — read the rest on GitHub` : body;
}

/** A milestone's due date is the only date GitHub offers, so it becomes the card's. */
export function dueDateFrom(issue: GithubIssue): string | null {
  const due = issue.milestoneDueOn;
  if (!due) return null;
  const parsed = Date.parse(due);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export interface UpsertResult {
  taskId: number;
  externalKey: string;
  created: boolean;
  /** Fields that actually changed on the card, per the registry's own diff. */
  changed: boolean;
  completed: boolean;
  reopened: boolean;
  assignedTo: number | null;
}

/**
 * One issue, one card.
 *
 * `assignedTo` is only ever *set*, never cleared: GitHub's "no assignee" is the
 * default state of most issues, and letting it wipe a PTD assignment would mean the
 * person who picked up the card loses it the next time anyone edits a label.
 */
export async function upsertIssueTask(
  ctx: ActionContext,
  mapping: GithubMapping,
  issue: GithubIssue,
  deps: SyncDeps,
): Promise<UpsertResult> {
  const externalKey = externalKeyFor(mapping.repo, issue.number);
  const found = (await deps.runAction(
    "task.find_or_create",
    { title: issue.title, externalKey, streamId: mapping.streamId },
    ctx,
  )) as { task?: { id?: number; completed?: boolean; streamId?: number | null }; created?: boolean };

  const taskId = found.task?.id;
  if (typeof taskId !== "number") throw new Error(`task.find_or_create returned no task for ${externalKey}`);
  const wasCompleted = found.task?.completed === true;

  const assignedTo = issue.assigneeLogin ? await deps.resolveAssignee(ctx.orgId, issue.assigneeLogin) : null;

  const patch: Record<string, unknown> = {
    taskId,
    title: issue.title,
    description: descriptionFrom(issue),
    tags: issue.labels,
    dueDate: dueDateFrom(issue),
    // find_or_create only files a *new* card under the stream; make sure an existing
    // card that was moved (or created before the mapping) lands in the mapped stream.
    streamId: mapping.streamId,
    ...(assignedTo !== null ? { assignedTo } : {}),
  };

  const reopened = issue.state === "open" && wasCompleted;
  if (reopened) {
    patch.completed = false;
    patch.status = "backlog";
  }

  const updated = (await deps.runAction("task.update", patch, ctx)) as { changed?: boolean };

  let completed = false;
  if (issue.state === "closed" && !wasCompleted) {
    const result = (await deps.runAction("task.complete", { taskId, note: `Closed on GitHub · ${externalKey}` }, ctx)) as {
      changed?: boolean;
    };
    completed = result.changed === true;
  }

  return {
    taskId,
    externalKey,
    created: found.created === true,
    changed: updated.changed === true || completed || reopened,
    completed,
    reopened,
    assignedTo,
  };
}

/* ── initial import ───────────────────────────────────────────────────── */

export interface ImportSummary {
  repo: string;
  streamId: number;
  issues: number;
  created: number;
  updated: number;
  errors: string[];
}

/**
 * `github.sync_now`: every open issue of the mapped repository, upserted.
 *
 * Closed issues are deliberately left out — importing a year of closed issues as
 * completed cards buries the board — so a card only ever learns about a close through
 * a webhook, or through the next sync if it is still open.
 */
export async function importOpenIssues(
  ctx: ActionContext,
  row: GithubRow,
  mapping: GithubMapping,
  deps: SyncDeps,
): Promise<ImportSummary> {
  const summary: ImportSummary = { repo: mapping.repo, streamId: mapping.streamId, issues: 0, created: 0, updated: 0, errors: [] };
  const token = await installationToken(row.config.installationId);
  if (!token.ok) {
    summary.errors.push(`installation_token: ${token.error}`);
    return summary;
  }
  const listed = await listOpenIssues(mapping.repo, token.token);
  if (!listed.ok) {
    summary.errors.push(listed.error);
    return summary;
  }
  summary.issues = listed.issues.length;
  for (const issue of listed.issues) {
    try {
      const result = await upsertIssueTask(ctx, mapping, issue, deps);
      if (result.created) summary.created += 1;
      else if (result.changed) summary.updated += 1;
    } catch (err) {
      summary.errors.push(`#${issue.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}

/* ── assignee matching ────────────────────────────────────────────────── */

/**
 * GitHub login → PTD seat, by email.
 *
 * `tasks` has no `github_login` column and the schema is frozen, so the only honest
 * bridge is the public email on the GitHub profile: if the person publishes one and it
 * matches a member of this organization, the card is assigned; otherwise it stays
 * unassigned rather than guessing from a display name. The lookup is cached for the
 * life of one sync run, because a repository's issues are usually assigned to the same
 * handful of people.
 */
export function assigneeResolver(token: string): SyncDeps["resolveAssignee"] {
  const cache = new Map<string, number | null>();
  return async (orgId: number, login: string): Promise<number | null> => {
    const key = `${orgId}:${login.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let userId: number | null = null;
    try {
      const email = await userEmail(login, token);
      if (email) userId = (await memberByEmail(orgId, email))?.userId ?? null;
    } catch {
      userId = null;
    }
    cache.set(key, userId);
    return userId;
  };
}

/** A resolver that never matches — used when no installation token could be minted. */
export const noAssigneeResolver: SyncDeps["resolveAssignee"] = async () => null;
