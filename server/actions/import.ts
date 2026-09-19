// import actions — registered by importing this module (see ./index.ts).
//
// Bringing existing work into PTD, and putting PTD's dates into a calendar.
// Four actions, all of them ordinary registry actions, so the CSV importer is
// reachable from the web client, from `POST /api/actions/import.commit`, and as
// an MCP tool an agent can call during a migration — same handler, same role
// gate, no adapter-specific path.
//
// Roles: importing writes tasks and time entries across the whole org, which is
// a manager's privilege (`task.create` is manager+ too). `ical.url` is member+,
// because a feed can only ever show the caller what they may already read.

import { z } from "zod";
import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "../../db";
import { apiTokens, taskEvents } from "../../db/schema";
import { defineAction, type ActionContext } from "./registry";
import { commit, preview, runsFor, type ImportArgs } from "../importers/apply";
import { MAPPERS, mapperFor } from "../importers/mappers";
import { SOURCES, TASK_FIELDS, TIME_FIELDS, IGNORE, FIELD_LABELS } from "../importers/types";
import { icalPath } from "../ical";
import { mintToken } from "../tokens";
import { hasRole } from "../types";

/* ── Shared input ────────────────────────────────────────────────────── */

const MAX_CSV = 5 * 1024 * 1024;

const sourceArg = z
  .enum(["auto", ...SOURCES] as [string, ...string[]])
  .describe(`Where the file came from. "auto" detects it from the header row. One of: ${SOURCES.join(", ")}.`);

const importInput = {
  source: sourceArg.optional().default("auto"),
  csv: z.string().min(1).max(MAX_CSV).describe("The CSV file's text, header row included. Up to 5 MB."),
  mapping: z
    .record(z.string())
    .optional()
    .describe(`Overrides for the detected column mapping: {"<column name>": "<PTD field>"}. Use "${IGNORE}" to drop a column.`),
  streamId: z.number().int().positive().optional().describe("File every row under this stream, whatever the source says."),
  defaultStreamName: z.string().min(1).max(255).optional().describe("Stream for rows with no stream of their own; created if it does not exist."),
};

const asArgs = (args: Record<string, unknown>): ImportArgs => ({
  source: args.source as ImportArgs["source"],
  csv: args.csv as string,
  mapping: args.mapping as Record<string, string> | undefined,
  streamId: args.streamId as number | undefined,
  defaultStreamName: args.defaultStreamName as string | undefined,
});

/* ── import.preview ──────────────────────────────────────────────────── */

export const importPreview = defineAction({
  name: "import.preview",
  title: "Preview a CSV import",
  description:
    "Dry run. Detects which tool the CSV came from, shows the column → PTD field mapping it will use, normalises the first rows, " +
    "and counts what a commit would create, update or skip. Writes nothing. Run this first: it is the same code path as import.commit, " +
    "so what it reports is what will happen.",
  input: z.object(importInput),
  requiredRole: "manager",
  surface: "org",
  handler: async (args, ctx) => {
    const result = await preview(asArgs(args), ctx);
    return { ...result, fields: fieldsFor(result.kind) };
  },
});

/* ── import.commit ───────────────────────────────────────────────────── */

export const importCommit = defineAction({
  name: "import.commit",
  title: "Commit a CSV import",
  description:
    "Write the rows. Tasks are matched on externalKey and updated rather than duplicated, so re-running the same file is idempotent; " +
    "streams (and customers, for time sheets) are created by name when missing; every task write leaves a task_events row with via=import. " +
    "Pass dryRun: true to get import.preview's answer instead.",
  input: z.object({
    ...importInput,
    dryRun: z.boolean().optional().default(false).describe("true behaves exactly like import.preview and writes nothing."),
  }),
  requiredRole: "manager",
  surface: "org",
  handler: async (args, ctx) => {
    if (args.dryRun) {
      const result = await preview(asArgs(args), ctx);
      return { dryRun: true, ...result, fields: fieldsFor(result.kind) };
    }
    return commit(asArgs(args), ctx);
  },
});

/* ── import.history ──────────────────────────────────────────────────── */

export const importHistory = defineAction({
  name: "import.history",
  title: "Recent imports",
  description:
    "The imports committed in this organization since the server last started, newest first, plus the all-time count of task rows " +
    "written by an import (task_events with via=import and an import: note), which does survive a restart.",
  input: z.object({}),
  requiredRole: "manager",
  surface: "org",
  handler: async (_args, ctx) => {
    const runs = runsFor(ctx.orgId);
    // The run list is process-local on purpose — an import log is not worth a
    // table — so the durable number comes from the history rows themselves. It
    // matches on the note prefix as well as `via`, because the demo seeder also
    // writes via="import" and those rows are not imports anyone performed.
    const rows = await db
      .select({ id: taskEvents.id })
      .from(taskEvents)
      .where(and(eq(taskEvents.orgId, ctx.orgId), eq(taskEvents.via, "import"), like(taskEvents.note, "import:%")));
    return {
      runs,
      note: runs.length === 0 ? "No imports since this server started." : undefined,
      taskEventsViaImport: rows.length,
      sources: MAPPERS.map((m) => ({ source: m.source, kind: m.kind, label: m.label, hint: m.hint })),
    };
  },
});

/* ── ical.url ────────────────────────────────────────────────────────── */

/**
 * The feed's URL contains its own credential, and the server keeps only a scrypt
 * hash of that credential — so a token's secret cannot be read back out of the
 * database to rebuild the URL later. This cache holds the secrets minted in this
 * process so that calling `ical.url` twice returns the *same* subscribable link
 * instead of quietly breaking the calendar the user already added.
 *
 * After a restart the cache is empty, so the next call rotates: the old token is
 * revoked and a new link issued. The result says so (`rotated`), because a user
 * whose subscription just stopped updating deserves to be told why.
 */
const mintedIcalSecrets = new Map<string, string>();
const icalCacheKey = (userId: number, orgId: number) => `${userId}:${orgId}`;

export const ICAL_TOKEN_NAME = "ical";

export const icalUrl = defineAction({
  name: "ical.url",
  title: "Calendar feed URL",
  description:
    "The .ics subscription URL for this organization's scheduled cards. Calendar apps cannot send an Authorization header, so the " +
    "credential is in the path: treat the URL as a secret, and revoke the 'ical' token in Org → Tokens to kill the feed. " +
    "scope 'me' (default) shows the cards assigned to you; scope 'org' shows every scheduled card and needs the manager role.",
  input: z.object({
    scope: z.enum(["me", "org"]).optional().default("me").describe("'me' = your cards; 'org' = every scheduled card (manager+)."),
  }),
  requiredRole: "member",
  surface: "org",
  handler: async (args, ctx) => {
    if (args.scope === "org" && !hasRole(ctx.role, "manager")) {
      // Mirrors the route's own check, so the UI cannot offer a link that 403s.
      return {
        error: "forbidden_scope",
        message: `The organization-wide feed needs the manager role (you are ${ctx.role}).`,
      };
    }

    const cacheKey = icalCacheKey(ctx.userId, ctx.orgId);
    const existing = await db
      .select({ id: apiTokens.id, prefix: apiTokens.prefix, expiresAt: apiTokens.expiresAt })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, ctx.userId), eq(apiTokens.orgId, ctx.orgId), eq(apiTokens.name, ICAL_TOKEN_NAME), isNull(apiTokens.revokedAt)));
    const live = existing.filter((t) => !t.expiresAt || t.expiresAt > new Date());

    const cached = mintedIcalSecrets.get(cacheKey);
    if (cached && live.some((t) => cached.includes(t.prefix))) {
      return describeFeed(cached, args.scope, { reused: true, rotated: 0 });
    }

    for (const stale of live) {
      await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, stale.id));
    }
    const minted = await mintToken(ctx.userId, ctx.orgId, ICAL_TOKEN_NAME);
    mintedIcalSecrets.set(cacheKey, minted.secret);
    return describeFeed(minted.secret, args.scope, { reused: false, rotated: live.length });
  },
});

function describeFeed(secret: string, scope: "me" | "org", state: { reused: boolean; rotated: number }) {
  const path = icalPath(secret, scope);
  // PTD_PUBLIC_URL is the deployment's own address; without it the client is the
  // only party that knows it, so it composes the absolute URL from the path.
  const base = (process.env.PTD_PUBLIC_URL || process.env.PTD_BASE_URL || "").replace(/\/+$/, "");
  return {
    scope,
    path,
    url: base ? `${base}${path}` : null,
    tokenName: ICAL_TOKEN_NAME,
    ...state,
    note: state.rotated > 0
      ? `${state.rotated} earlier calendar token${state.rotated === 1 ? " was" : "s were"} revoked — re-subscribe with this URL.`
      : undefined,
    instructions: {
      google: "Google Calendar → Other calendars + → From URL → paste → Add calendar. Google refreshes roughly every 8–24 h; it ignores the 5-minute hint.",
      apple: "Calendar → File → New Calendar Subscription → paste → set Auto-refresh to every 5 minutes.",
      outlook: "Outlook on the web → Add calendar → Subscribe from web → paste → Import.",
    },
  };
}

/* ── Field catalogue for the mapping UI ──────────────────────────────── */

function fieldsFor(kind: "task" | "time") {
  const fields = kind === "task" ? TASK_FIELDS : TIME_FIELDS;
  return [
    { field: IGNORE, label: FIELD_LABELS[IGNORE] },
    ...fields.map((f) => ({ field: f, label: FIELD_LABELS[f] ?? f })),
  ];
}

/** Re-exported so a caller can enumerate the templates without the mapper index. */
export { mapperFor };
