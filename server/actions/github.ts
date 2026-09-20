// github actions — registered by importing this module (see ./index.ts).
//
// The GitHub adapter's own control surface: mapping a stream to a repository, running
// the initial import, and disconnecting. They are registry actions rather than bespoke
// endpoints so the Org UI, MCP and REST all reach them the same way, under the same
// role gate — and so an agent can map a repository without a browser.

import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { streams } from "../../db/schema";
import { ActionError, defineAction, runAction } from "./registry";
import { hasRole } from "../types";
import { assertStream } from "../plan/taskOps";
import {
  GITHUB_EVENTS,
  GITHUB_PERMISSIONS,
  githubAppEnv,
  githubWebhookUrl,
  isGithubAppConfigured,
  missingGithubEnv,
  normaliseRepo,
} from "../integrations/github/config";
import { installationToken } from "../integrations/github/api";
import {
  getGithubForOrg,
  patchMapping,
  putMapping,
  removeGithubForOrg,
  removeMapping,
  type GithubMapping,
} from "../integrations/github/store";
import { assigneeResolver, importOpenIssues, noAssigneeResolver } from "../integrations/github/sync";

const DIRECTIONS = ["both", "in", "out"] as const;

async function requireInstall(orgId: number) {
  const row = await getGithubForOrg(orgId);
  if (!row) {
    throw new ActionError("not_found", "GitHub is not connected to this organization yet — an admin has to install the PTD app first.");
  }
  return row;
}

/** Stream names for the mappings table, so the UI never shows a bare id. */
async function streamNames(orgId: number, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: streams.id, name: streams.name })
    .from(streams)
    .where(and(eq(streams.orgId, orgId), inArray(streams.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function describeMappings(orgId: number, mappings: GithubMapping[]) {
  const names = await streamNames(orgId, mappings.map((m) => m.streamId));
  return mappings
    .slice()
    .sort((a, b) => a.repo.localeCompare(b.repo))
    .map((m) => ({
      streamId: m.streamId,
      streamName: names.get(m.streamId) ?? null,
      repo: m.repo,
      url: `https://github.com/${m.repo}`,
      direction: m.direction,
      mappedBy: m.mappedBy,
      mappedAt: m.mappedAt,
      lastSyncAt: m.lastSyncAt ?? null,
      lastError: m.lastError ?? null,
      lastImported: m.lastImported ?? null,
    }));
}

defineAction({
  name: "github.status",
  title: "GitHub status",
  description:
    "Whether this server has a GitHub App configured, whether this organization has installed it, which account it was installed on, and every stream ↔ repository mapping with its last sync. Never returns a token — installation tokens are minted per hour and never stored.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => {
    const appEnv = githubAppEnv();
    const row = await getGithubForOrg(ctx.orgId);
    return {
      appConfigured: isGithubAppConfigured(appEnv),
      missingEnv: missingGithubEnv(appEnv),
      appSlug: appEnv.slug || null,
      connected: !!row && row.enabled,
      canManage: hasRole(ctx.role, "admin"),
      installationId: row?.config.installationId ?? null,
      account: row?.config.account ?? null,
      installedAt: row?.config.installedAt ?? null,
      installedBy: row?.config.installedBy ?? null,
      lastEventAt: row?.config.lastEventAt ?? null,
      lastError: row?.config.lastError ?? null,
      webhookUrl: githubWebhookUrl(),
      permissions: GITHUB_PERMISSIONS,
      events: [...GITHUB_EVENTS],
      mappings: row ? await describeMappings(ctx.orgId, row.config.mappings) : [],
    };
  },
});

defineAction({
  name: "github.list_mappings",
  title: "List GitHub mappings",
  description: "Every stream ↔ repository mapping in this organization, with its direction and the outcome of its last sync.",
  input: z.object({}),
  requiredRole: "member",
  surface: "org",
  handler: async (_args, ctx) => {
    const row = await getGithubForOrg(ctx.orgId);
    return { mappings: row ? await describeMappings(ctx.orgId, row.config.mappings) : [] };
  },
});

defineAction({
  name: "github.map_stream",
  title: "Map a stream to a GitHub repository",
  description:
    "Bind one stream to one repository. `in` imports issues as tasks, `out` opens and closes issues from tasks, `both` does each. A stream maps to at most one repository, so mapping it again replaces the previous mapping. Inbound writes run as you, with your role.",
  input: z.object({
    streamId: z.number().int().positive().describe("Stream to bind"),
    repo: z.string().min(3).max(200).describe('"owner/name", or a github.com URL'),
    direction: z.enum(DIRECTIONS).default("both").describe("both = mirror each way, in = GitHub → PTD only, out = PTD → GitHub only"),
  }),
  requiredRole: "admin",
  audited: true,
  surface: "org",
  handler: async (args, ctx) => {
    const row = await requireInstall(ctx.orgId);
    const stream = await assertStream(ctx.orgId, args.streamId);
    const repo = normaliseRepo(args.repo);
    if (!repo) throw new ActionError("invalid", `"${args.repo}" is not a repository — write it as owner/name, e.g. danimoya/ptd.`);

    const clash = row.config.mappings.find((m) => m.repo === repo && m.streamId !== args.streamId);
    if (clash) {
      throw new ActionError("conflict", `${repo} is already mapped to stream ${clash.streamId} — unmap that one first, or map a different repository.`);
    }

    const previous = row.config.mappings.find((m) => m.streamId === args.streamId);
    const updated = await putMapping(ctx.orgId, {
      streamId: args.streamId,
      repo,
      direction: args.direction,
      mappedBy: ctx.userId,
      mappedAt: new Date().toISOString(),
      lastSyncAt: previous?.repo === repo ? previous.lastSyncAt ?? null : null,
      lastError: null,
      lastImported: previous?.repo === repo ? previous.lastImported ?? null : null,
    });
    return {
      mapped: true,
      streamId: args.streamId,
      streamName: stream.name,
      repo,
      direction: args.direction,
      replaced: previous ? { repo: previous.repo, direction: previous.direction } : null,
      mappings: await describeMappings(ctx.orgId, updated?.config.mappings ?? []),
    };
  },
});

defineAction({
  name: "github.unmap_stream",
  title: "Unmap a stream from GitHub",
  description:
    "Stop syncing one stream. Existing cards keep their `gh:owner/name#N` externalKey and their history; nothing is deleted on either side, and mapping the stream again picks the same cards back up.",
  input: z.object({ streamId: z.number().int().positive() }),
  requiredRole: "admin",
  audited: true,
  surface: "org",
  handler: async (args, ctx) => {
    await requireInstall(ctx.orgId);
    const { row, removed } = await removeMapping(ctx.orgId, args.streamId);
    if (removed === 0) throw new ActionError("not_found", `Stream ${args.streamId} is not mapped to a GitHub repository.`);
    return { unmapped: true, streamId: args.streamId, mappings: await describeMappings(ctx.orgId, row?.config.mappings ?? []) };
  },
});

defineAction({
  name: "github.sync_now",
  title: "Import open issues now",
  description:
    "Pull every open issue of the mapped repository and upsert it as a task keyed on `gh:owner/name#N` — labels become tags, a milestone due date becomes the card's due date, and an assignee whose GitHub profile shows an email that matches a member is assigned. Idempotent: run it twice and nothing changes the second time. Closed issues are left out; a close arrives by webhook.",
  input: z.object({ streamId: z.number().int().positive().describe("The mapped stream to sync") }),
  requiredRole: "admin",
  surface: "org",
  handler: async (args, ctx) => {
    const row = await requireInstall(ctx.orgId);
    const mapping = row.config.mappings.find((m) => m.streamId === args.streamId);
    if (!mapping) throw new ActionError("not_found", `Stream ${args.streamId} is not mapped to a GitHub repository.`);
    if (mapping.direction === "out") {
      throw new ActionError("invalid", `${mapping.repo} is mapped as "out" — PTD writes to it but does not import from it. Remap it as "in" or "both" to import.`);
    }

    // The import is attributed to the caller (an admin), so every created card carries
    // a real author and the registry's own role gate still applies to every write.
    const runAsCtx = { ...ctx, via: "github" as const };
    const token = await installationToken(row.config.installationId);
    const summary = await importOpenIssues(runAsCtx, row, mapping, {
      runAction,
      resolveAssignee: token.ok ? assigneeResolver(token.token) : noAssigneeResolver,
    });
    await patchMapping(ctx.orgId, args.streamId, {
      lastSyncAt: new Date().toISOString(),
      lastImported: summary.issues,
      lastError: summary.errors[0] ?? null,
    });
    return summary;
  },
});

defineAction({
  name: "github.disconnect",
  title: "Disconnect GitHub",
  description:
    "Forget the installation and every mapping. Cards keep their externalKey and history, and the App itself stays installed on GitHub until someone removes it there — this only stops PTD acting on it.",
  input: z.object({}),
  requiredRole: "admin",
  audited: true,
  surface: "org",
  handler: async (_args, ctx) => {
    const row = await getGithubForOrg(ctx.orgId);
    if (!row) throw new ActionError("not_found", "GitHub was not connected to this organization.");
    const removed = await removeGithubForOrg(ctx.orgId);
    return { disconnected: true, removed, mappingsDropped: row.config.mappings.length, account: row.config.account?.login ?? null };
  },
});
