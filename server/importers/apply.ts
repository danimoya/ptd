/**
 * Dry-run and commit.
 *
 * One function prepares an import (`prepare`) and two read its result: `preview`
 * describes what would happen, `commit` does it. They share every decision —
 * which source, which mapping, which rows are refused, which external key
 * matches an existing card — so the preview a manager approves is not a
 * separate computation from the one that runs. That is the whole point of
 * having a dry run at all.
 *
 * Invariants carried over from the Plan and Track surfaces:
 *
 *   - `externalKey` is unique per organization, so a re-import UPDATES rather
 *     than duplicating. Every mapper therefore produces a key — from the file
 *     when it has one, otherwise a hash of title + created date.
 *   - `priorityScore` is always derived through db/schema's `priorityScore()`.
 *   - every task write leaves one `task_events` row, `kind` created/updated and
 *     `via: "import"`.
 *   - `entry_source` on an imported time entry comes from the *credential* that
 *     ran the import, never from the file — the rule in server/track/attribution.ts.
 *     A human session imports human time; an agent token imports agent time.
 *
 * Bulk shape: tasks and entries go in as multi-row INSERTs in chunks (HeliosDB
 * Nano 4.40 handles those; `= ANY` is avoided throughout in favour of `IN (…)`,
 * which is what drizzle's `inArray` emits). Task events are written directly
 * rather than through `recordEvent`, because a 500-row import must not fire 500
 * webhooks — one `import.completed` event goes out at the end instead.
 */

import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../../db";
import {
  customers,
  memberships,
  priorityScore,
  streams,
  taskEvents,
  tasks,
  timeEntries,
  users,
  type Task,
} from "../../db/schema";
import { ActionError, type ActionContext } from "../actions/registry";
import { diffTask } from "../plan/taskEvents";
import { attributionFor } from "../track/attribution";
import { dispatchWebhooks } from "../webhooks";
import { detectFile, type SourceScore } from "./detect";
import { mapperFor } from "./mappers";
import { norm } from "./mappers/shared";
import {
  isTaskSource,
  type ImportKind,
  type NormalisedEntry,
  type NormalisedTask,
  type RowResult,
  type Source,
  type SourceArg,
} from "./types";

/* ── Arguments ───────────────────────────────────────────────────────── */

export interface ImportArgs {
  source?: SourceArg;
  csv: string;
  /** `column name → PTD field`, layered over the mapper's defaults. */
  mapping?: Record<string, string>;
  /** Force every row into this stream, whatever the file says. */
  streamId?: number;
  /** Stream for rows whose own stream cell is empty. Created if missing. */
  defaultStreamName?: string;
}

export const PREVIEW_ROWS = 20;
const INSERT_CHUNK = 50;
const EVENT_CHUNK = 100;
const UPDATE_CONCURRENCY = 5;
const MAX_WARNINGS = 60;

/* ── Prepared import ─────────────────────────────────────────────────── */

export interface Prepared {
  source: Source;
  kind: ImportKind;
  label: string;
  confidence: number;
  /** Per-source detection scores, so a client can say why this source won. */
  scores: SourceScore[];
  columns: string[];
  mapping: Record<string, string>;
  taskRows: RowResult<NormalisedTask>[];
  entryRows: RowResult<NormalisedEntry>[];
  warnings: string[];
}

/**
 * Parse, detect, merge the caller's mapping over the default, normalise.
 *
 * A mapping override naming a column the file does not have is a warning rather
 * than an error: the UI round-trips the whole mapping, and a user who edits the
 * CSV between preview and commit should be told, not stopped.
 */
export function prepare(args: ImportArgs): Prepared {
  const requested = args.source && args.source !== "auto" ? (args.source as Source) : undefined;
  const detected = detectFile(args.csv, requested);
  const mapper = mapperFor(detected.source);
  const warnings = [...detected.parsed.warnings];

  const mapping = { ...detected.mapping };
  for (const [column, field] of Object.entries(args.mapping ?? {})) {
    if (!(column in mapping)) {
      warnings.push(`Mapping mentions a column "${column}" that is not in the file — ignored.`);
      continue;
    }
    mapping[column] = field;
  }

  if (detected.parsed.columns.length === 0) throw new ActionError("invalid", "No header row found in the CSV.");
  if (detected.parsed.rows.length === 0) warnings.push("The file has a header but no data rows.");

  const taskRows: RowResult<NormalisedTask>[] = [];
  const entryRows: RowResult<NormalisedEntry>[] = [];
  detected.parsed.rows.forEach((row, i) => {
    const result = mapper.normalise(row, mapping, i + 1);
    if (mapper.kind === "task") taskRows.push(result as RowResult<NormalisedTask>);
    else entryRows.push(result as RowResult<NormalisedEntry>);
  });

  if (mapper.kind === "task" && !Object.values(mapping).includes("title")) {
    throw new ActionError("invalid", "No column is mapped to the title, and a task cannot be created without one.");
  }

  return {
    source: detected.source,
    kind: mapper.kind,
    label: mapper.label,
    confidence: detected.confidence,
    scores: detected.scores,
    columns: detected.parsed.columns,
    mapping,
    taskRows,
    entryRows,
    warnings,
  };
}

/* ── The org, indexed by the names a CSV speaks in ───────────────────── */

interface OrgIndex {
  tasksByKey: Map<string, Task>;
  tasksByTitle: Map<string, Task[]>;
  streamsByName: Map<string, { id: number; name: string }>;
  customersByName: Map<string, { id: number; name: string }>;
  membersByEmail: Map<string, { userId: number; isAgent: boolean; displayName: string }>;
  maxStreamPosition: number;
}

const key = (s: string) => s.trim().toLowerCase();

async function loadOrgIndex(orgId: number): Promise<OrgIndex> {
  const [taskRows, streamRows, customerRows, memberRows] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.orgId, orgId)),
    db.select({ id: streams.id, name: streams.name, position: streams.position }).from(streams).where(eq(streams.orgId, orgId)),
    db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.orgId, orgId)),
    db
      .select({ userId: memberships.userId, email: users.email, isAgent: users.isAgent, displayName: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.orgId, orgId)),
  ]);

  const tasksByKey = new Map<string, Task>();
  const tasksByTitle = new Map<string, Task[]>();
  for (const t of taskRows as Task[]) {
    if (t.externalKey) tasksByKey.set(key(t.externalKey), t);
    const bucket = tasksByTitle.get(key(t.title)) ?? [];
    bucket.push(t);
    tasksByTitle.set(key(t.title), bucket);
  }

  return {
    tasksByKey,
    tasksByTitle,
    streamsByName: new Map(streamRows.map((s) => [key(s.name), { id: s.id, name: s.name }])),
    customersByName: new Map(customerRows.map((c) => [key(c.name), { id: c.id, name: c.name }])),
    membersByEmail: new Map(memberRows.map((m) => [key(m.email), { userId: m.userId, isAgent: m.isAgent, displayName: m.displayName }])),
    maxStreamPosition: streamRows.reduce((max, s) => Math.max(max, s.position), 0),
  };
}

/* ── Results ─────────────────────────────────────────────────────────── */

export interface ImportCounts {
  create: number;
  update: number;
  skip: number;
}

export interface PreviewRow {
  row: number;
  action: "create" | "update" | "skip";
  reason: string | null;
  values: Record<string, unknown>;
  warnings: string[];
}

export interface PreviewResult {
  source: Source;
  kind: ImportKind;
  label: string;
  confidence: number;
  scores: SourceScore[];
  columns: string[];
  mapping: Record<string, string>;
  rows: PreviewRow[];
  totalRows: number;
  counts: ImportCounts;
  /** Streams and customers the commit would create, by name. */
  creates: { streams: string[]; customers: string[] };
  warnings: string[];
}

export interface CommitResult {
  source: Source;
  kind: ImportKind;
  created: number;
  updated: number;
  skipped: number;
  streamsCreated: string[];
  customersCreated: string[];
  tasksLinked?: number;
  errors: string[];
  warnings: string[];
  at: string;
}

/* ── Preview ─────────────────────────────────────────────────────────── */

export async function preview(args: ImportArgs, ctx: ActionContext): Promise<PreviewResult> {
  const prepared = prepare(args);
  const index = await loadOrgIndex(ctx.orgId);
  const warnings = [...prepared.warnings];
  const counts: ImportCounts = { create: 0, update: 0, skip: 0 };
  const newStreams = new Set<string>();
  const newCustomers = new Set<string>();
  const rows: PreviewRow[] = [];

  const forcedStream = args.streamId !== undefined ? requireStream(index, args.streamId) : null;

  if (prepared.kind === "task") {
    let synthesised = 0;
    for (const result of prepared.taskRows) {
      collect(warnings, result);
      if (!result.value) {
        counts.skip += 1;
        if (rows.length < PREVIEW_ROWS) rows.push({ row: result.index, action: "skip", reason: result.skip, values: {}, warnings: result.warnings });
        continue;
      }
      const task = result.value;
      if (task.keySynthesised) synthesised += 1;
      const streamName = forcedStream?.name ?? task.streamName ?? args.defaultStreamName ?? null;
      if (streamName && !index.streamsByName.has(key(streamName)) && !forcedStream) newStreams.add(streamName);
      const existing = index.tasksByKey.get(key(task.externalKey));
      if (existing) counts.update += 1;
      else counts.create += 1;
      if (rows.length < PREVIEW_ROWS) {
        rows.push({
          row: result.index,
          action: existing ? "update" : "create",
          reason: existing ? `matches task #${existing.id} by external key` : null,
          values: taskPreviewValues(task, streamName, index),
          warnings: result.warnings,
        });
      }
    }
    if (synthesised > 0) {
      warnings.push(
        `${synthesised} row${synthesised === 1 ? "" : "s"} had no id column, so the external key was derived from the title and created date. ` +
          `Re-importing the same file stays idempotent; editing a title first will create a second card.`
      );
    }
  } else {
    const existingIntervals = await loadIntervalKeys(ctx.orgId, prepared.entryRows);
    const seen = new Set<string>();
    for (const result of prepared.entryRows) {
      collect(warnings, result);
      if (!result.value) {
        counts.skip += 1;
        if (rows.length < PREVIEW_ROWS) rows.push({ row: result.index, action: "skip", reason: result.skip, values: {}, warnings: result.warnings });
        continue;
      }
      const entry = result.value;
      const resolved = resolveEntry(entry, args, index, ctx);
      // A row whose member could not be resolved lands on the importer's own
      // ledger, which is exactly the kind of thing a dry run exists to reveal.
      if (resolved.warning) {
        result.warnings.push(resolved.warning);
        warnings.push(`row ${result.index}: ${resolved.warning}`);
      }
      const dedupeKey = intervalKey(resolved.userId, entry.checkIn, entry.checkOut);
      const duplicate = existingIntervals.has(dedupeKey) || seen.has(dedupeKey);
      seen.add(dedupeKey);
      if (duplicate) counts.skip += 1;
      else counts.create += 1;
      if (resolved.streamName && !index.streamsByName.has(key(resolved.streamName))) newStreams.add(resolved.streamName);
      if (entry.customerName && !index.customersByName.has(key(entry.customerName))) newCustomers.add(entry.customerName);
      if (rows.length < PREVIEW_ROWS) {
        rows.push({
          row: result.index,
          action: duplicate ? "skip" : "create",
          reason: duplicate ? "an entry for this member already covers exactly this interval" : null,
          values: entryPreviewValues(entry, resolved),
          warnings: result.warnings,
        });
      }
    }
  }

  return {
    source: prepared.source,
    kind: prepared.kind,
    label: prepared.label,
    confidence: prepared.confidence,
    scores: prepared.scores,
    columns: prepared.columns,
    mapping: prepared.mapping,
    rows,
    totalRows: prepared.kind === "task" ? prepared.taskRows.length : prepared.entryRows.length,
    counts,
    creates: { streams: [...newStreams], customers: [...newCustomers] },
    warnings: warnings.slice(0, MAX_WARNINGS).concat(warnings.length > MAX_WARNINGS ? [`…and ${warnings.length - MAX_WARNINGS} more.`] : []),
  };
}

/* ── Commit ──────────────────────────────────────────────────────────── */

export async function commit(args: ImportArgs, ctx: ActionContext): Promise<CommitResult> {
  const prepared = prepare(args);
  const index = await loadOrgIndex(ctx.orgId);
  const result: CommitResult = {
    source: prepared.source,
    kind: prepared.kind,
    created: 0,
    updated: 0,
    skipped: 0,
    streamsCreated: [],
    customersCreated: [],
    errors: [],
    warnings: prepared.warnings.slice(0, MAX_WARNINGS),
    at: new Date().toISOString(),
  };

  if (prepared.kind === "task") await commitTasks(prepared, args, ctx, index, result);
  else await commitEntries(prepared, args, ctx, index, result);

  recordRun(ctx, result);
  try {
    await dispatchWebhooks(ctx.orgId, {
      kind: "import.completed",
      actor: { userId: ctx.userId, label: ctx.displayName, isAgent: ctx.authType === "agent" },
      payload: { source: result.source, kind: result.kind, created: result.created, updated: result.updated, skipped: result.skipped },
    });
  } catch (error) {
    console.error("[import] dispatchWebhooks failed:", error);
  }
  return result;
}

async function commitTasks(
  prepared: Prepared,
  args: ImportArgs,
  ctx: ActionContext,
  index: OrgIndex,
  result: CommitResult
): Promise<void> {
  const forcedStream = args.streamId !== undefined ? requireStream(index, args.streamId) : null;
  const inserts: { values: typeof tasks.$inferInsert; row: number }[] = [];
  const updates: { id: number; before: Task; values: Partial<typeof tasks.$inferInsert>; row: number }[] = [];
  const events: typeof taskEvents.$inferInsert[] = [];

  for (const row of prepared.taskRows) {
    if (!row.value) {
      result.skipped += 1;
      continue;
    }
    const task = row.value;
    const streamName = forcedStream?.name ?? task.streamName ?? args.defaultStreamName ?? null;
    let streamId: number | null = forcedStream?.id ?? null;
    if (streamId === null && streamName) {
      const resolved = await ensureStream(ctx.orgId, streamName, index, result);
      streamId = resolved;
    }
    const assignee = task.assigneeEmail ? index.membersByEmail.get(key(task.assigneeEmail)) : undefined;
    if (task.assigneeEmail && !assignee) {
      pushWarning(result, `row ${row.index}: "${task.assigneeEmail}" is not a member of this organization — left unassigned`);
    }

    const values: typeof tasks.$inferInsert = {
      orgId: ctx.orgId,
      title: task.title,
      description: descriptionToStore(task.description),
      status: task.status,
      streamId,
      assignedTo: assignee?.userId ?? null,
      startDate: task.startDate,
      dueDate: task.dueDate,
      estimatedDuration: task.estimatedDuration,
      externalKey: task.externalKey,
      urgency: task.urgency,
      impact: task.impact,
      effort: task.effort,
      priorityScore: priorityScore(task.urgency, task.impact, task.effort),
      tags: task.tags,
      completed: task.status === "completed",
      createdBy: ctx.userId,
    };

    const existing = index.tasksByKey.get(key(task.externalKey));
    if (existing) updates.push({ id: existing.id, before: existing, values: { ...values, updatedAt: new Date() }, row: row.index });
    else inserts.push({ values, row: row.index });
  }

  // INSERTs: multi-row, chunked, and the returned ids feed the event rows.
  for (const chunk of chunks(inserts, INSERT_CHUNK)) {
    try {
      const written = (await db
        .insert(tasks)
        .values(chunk.map((c) => c.values))
        .returning({ id: tasks.id, externalKey: tasks.externalKey })) as { id: number; externalKey: string | null }[];
      result.created += written.length;
      written.forEach((w, i) => {
        events.push({
          taskId: w.id,
          orgId: ctx.orgId,
          actorUserId: ctx.userId,
          actorLabel: actorLabel(ctx),
          kind: "created",
          changes: null,
          note: `import: ${prepared.source} · row ${chunk[i]?.row ?? "?"} · key ${w.externalKey ?? "—"}`,
          via: "import",
        });
      });
    } catch (error) {
      result.errors.push(`rows ${chunk[0]?.row}–${chunk[chunk.length - 1]?.row}: ${message(error)}`);
      result.skipped += chunk.length;
    }
  }

  // UPDATEs: one statement each (the values differ per row), a few at a time.
  for (const chunk of chunks(updates, UPDATE_CONCURRENCY)) {
    await Promise.all(
      chunk.map(async (u) => {
        try {
          await db.update(tasks).set(u.values).where(and(eq(tasks.id, u.id), eq(tasks.orgId, ctx.orgId)));
          result.updated += 1;
          const changes = diffTask(u.before, { ...u.before, ...u.values } as Partial<Task>);
          events.push({
            taskId: u.id,
            orgId: ctx.orgId,
            actorUserId: ctx.userId,
            actorLabel: actorLabel(ctx),
            kind: "updated",
            changes,
            note: `import: ${prepared.source} · row ${u.row} · re-imported by external key`,
            via: "import",
          });
        } catch (error) {
          result.errors.push(`row ${u.row}: ${message(error)}`);
          result.skipped += 1;
        }
      })
    );
  }

  for (const chunk of chunks(events, EVENT_CHUNK)) {
    try {
      await db.insert(taskEvents).values(chunk);
    } catch (error) {
      // History is not worth failing an import over; say so and carry on.
      console.error("[import] task_events insert failed:", error);
      pushWarning(result, `history rows could not be written: ${message(error)}`);
    }
  }
}

async function commitEntries(
  prepared: Prepared,
  args: ImportArgs,
  ctx: ActionContext,
  index: OrgIndex,
  result: CommitResult
): Promise<void> {
  const attribution = attributionFor({ authType: ctx.authType, displayName: ctx.displayName });
  const existingIntervals = await loadIntervalKeys(ctx.orgId, prepared.entryRows);
  const seen = new Set<string>(existingIntervals);
  const inserts: { values: typeof timeEntries.$inferInsert; row: number }[] = [];
  let linked = 0;

  for (const row of prepared.entryRows) {
    if (!row.value) {
      result.skipped += 1;
      continue;
    }
    const entry = row.value;
    const resolved = resolveEntry(entry, args, index, ctx);
    if (resolved.warning) pushWarning(result, `row ${row.index}: ${resolved.warning}`);

    let streamId: number | null = resolved.streamId;
    if (streamId === null && resolved.streamName) streamId = await ensureStream(ctx.orgId, resolved.streamName, index, result);
    let customerId: number | null = null;
    if (entry.customerName) customerId = await ensureCustomer(ctx.orgId, entry.customerName, index, result);

    const taskId = linkTask(entry, streamId, index);
    if (taskId) linked += 1;

    const dedupeKey = intervalKey(resolved.userId, entry.checkIn, entry.checkOut);
    if (seen.has(dedupeKey)) {
      result.skipped += 1;
      continue;
    }
    seen.add(dedupeKey);

    inserts.push({
      row: row.index,
      values: {
        userId: resolved.userId,
        orgId: ctx.orgId,
        customerId,
        streamId,
        taskId,
        checkIn: entry.checkIn,
        checkOut: entry.checkOut,
        isBreak: false,
        notes: entry.notes,
        entrySource: attribution.entrySource,
        agentLabel: attribution.agentLabel,
      },
    });
  }

  for (const chunk of chunks(inserts, INSERT_CHUNK)) {
    try {
      const written = await db
        .insert(timeEntries)
        .values(chunk.map((c) => c.values))
        .returning({ id: timeEntries.id });
      result.created += written.length;
    } catch (error) {
      result.errors.push(`rows ${chunk[0]?.row}–${chunk[chunk.length - 1]?.row}: ${message(error)}`);
      result.skipped += chunk.length;
    }
  }
  result.tasksLinked = linked;
}

/* ── Resolution helpers ──────────────────────────────────────────────── */

function requireStream(index: OrgIndex, streamId: number): { id: number; name: string } {
  for (const stream of index.streamsByName.values()) if (stream.id === streamId) return stream;
  throw new ActionError("not_found", `Stream ${streamId} does not exist in this organization`);
}

async function ensureStream(orgId: number, name: string, index: OrgIndex, result: CommitResult): Promise<number> {
  const existing = index.streamsByName.get(key(name));
  if (existing) return existing.id;
  index.maxStreamPosition += 1;
  const [created] = await db
    .insert(streams)
    .values({ orgId, name: name.slice(0, 255), position: index.maxStreamPosition })
    .returning({ id: streams.id, name: streams.name });
  index.streamsByName.set(key(name), { id: created.id, name: created.name });
  result.streamsCreated.push(created.name);
  return created.id;
}

async function ensureCustomer(orgId: number, name: string, index: OrgIndex, result: CommitResult): Promise<number> {
  const existing = index.customersByName.get(key(name));
  if (existing) return existing.id;
  const [created] = await db
    .insert(customers)
    .values({ orgId, name: name.slice(0, 255) })
    .returning({ id: customers.id, name: customers.name });
  index.customersByName.set(key(name), { id: created.id, name: created.name });
  result.customersCreated.push(created.name);
  return created.id;
}

interface ResolvedEntry {
  userId: number;
  userLabel: string;
  streamId: number | null;
  streamName: string | null;
  warning: string | null;
}

/**
 * Whose ledger the row lands on, and under which stream.
 *
 * An address that matches an org member wins; anything else falls back to the
 * importer, because a time sheet for somebody who is not in the organization
 * cannot be attributed to them. Agent seats are excluded on purpose: Toggl,
 * Clockify and Harvest are human time sheets, and an agent's minutes are
 * supposed to arrive from the agent's own credential.
 */
function resolveEntry(entry: NormalisedEntry, args: ImportArgs, index: OrgIndex, ctx: ActionContext): ResolvedEntry {
  let userId = ctx.userId;
  let userLabel = ctx.displayName;
  let warning: string | null = null;

  if (entry.userEmail) {
    const member = index.membersByEmail.get(key(entry.userEmail));
    if (!member) warning = `"${entry.userEmail}" is not a member of this organization — logged against you`;
    else if (member.isAgent) warning = `"${entry.userEmail}" is an agent seat — logged against you instead`;
    else {
      userId = member.userId;
      userLabel = member.displayName;
    }
  }

  const streamName = args.streamId !== undefined ? requireStream(index, args.streamId).name : entry.streamName ?? args.defaultStreamName ?? null;
  const streamId = args.streamId ?? (streamName ? index.streamsByName.get(key(streamName))?.id ?? null : null);
  return { userId, userLabel, streamId, streamName, warning };
}

const BRACKET_KEY = /^\s*[[(]([A-Za-z][A-Za-z0-9_.-]{0,40}-?\d*)[\])]\s*/;

/**
 * Link an entry to a task: a `[KEY]` prefix on the note first, then an exact
 * title match inside the same stream. Title matching is deliberately narrow —
 * one candidate in one stream — because a wrong link silently misattributes
 * hours, which is worse than leaving the entry on the stream alone.
 */
function linkTask(entry: NormalisedEntry, streamId: number | null, index: OrgIndex): number | null {
  const ref = entry.taskRef?.trim() ?? "";
  if (!ref) return null;

  const bracketed = ref.match(BRACKET_KEY)?.[1];
  if (bracketed) {
    const byKey = index.tasksByKey.get(key(bracketed));
    if (byKey) return byKey.id;
  }
  const bare = ref.replace(BRACKET_KEY, "").trim();
  const candidates = index.tasksByTitle.get(key(bare || ref));
  if (!candidates || candidates.length === 0) return null;
  const inStream = streamId === null ? candidates : candidates.filter((t) => t.streamId === streamId);
  return inStream.length === 1 ? inStream[0].id : null;
}

/** Existing (user, interval) fingerprints in the window the file covers. */
async function loadIntervalKeys(orgId: number, rows: RowResult<NormalisedEntry>[]): Promise<Set<string>> {
  const times = rows.flatMap((r) => (r.value ? [r.value.checkIn.getTime()] : []));
  if (times.length === 0) return new Set();
  const from = new Date(Math.min(...times) - 86_400_000);
  const to = new Date(Math.max(...times) + 2 * 86_400_000);
  const existing = await db
    .select({ userId: timeEntries.userId, checkIn: timeEntries.checkIn, checkOut: timeEntries.checkOut })
    .from(timeEntries)
    .where(and(eq(timeEntries.orgId, orgId), gte(timeEntries.checkIn, from), lte(timeEntries.checkIn, to)));
  return new Set(existing.map((e) => intervalKey(e.userId, e.checkIn, e.checkOut)));
}

/** Minute precision: these exports do not carry seconds reliably. */
function intervalKey(userId: number, checkIn: Date, checkOut: Date | null): string {
  const minute = (d: Date | null) => (d ? Math.floor(d.getTime() / 60_000) : "open");
  return `${userId}|${minute(checkIn)}|${minute(checkOut)}`;
}

/* ── Preview shapes ──────────────────────────────────────────────────── */

function taskPreviewValues(task: NormalisedTask, streamName: string | null, index: OrgIndex): Record<string, unknown> {
  const assignee = task.assigneeEmail ? index.membersByEmail.get(key(task.assigneeEmail)) : undefined;
  return {
    title: task.title,
    status: task.status,
    externalKey: task.externalKey,
    keySynthesised: task.keySynthesised,
    stream: streamName,
    streamExists: streamName ? index.streamsByName.has(key(streamName)) : null,
    startDate: task.startDate?.toISOString() ?? null,
    dueDate: task.dueDate?.toISOString() ?? null,
    estimatedDuration: task.estimatedDuration,
    tags: task.tags,
    assignee: assignee ? assignee.displayName : task.assigneeEmail ? `${task.assigneeEmail} (not a member)` : null,
    urgency: task.urgency,
    impact: task.impact,
    effort: task.effort,
    priorityScore: priorityScore(task.urgency, task.impact, task.effort),
    description: task.description ? task.description.slice(0, 160) : null,
  };
}

function entryPreviewValues(entry: NormalisedEntry, resolved: ResolvedEntry): Record<string, unknown> {
  return {
    member: resolved.userLabel,
    memberEmail: entry.userEmail,
    customer: entry.customerName,
    stream: resolved.streamName,
    checkIn: entry.checkIn.toISOString(),
    checkOut: entry.checkOut.toISOString(),
    minutes: Math.round((entry.checkOut.getTime() - entry.checkIn.getTime()) / 60_000),
    notes: entry.notes,
  };
}

/* ── History (per process, per org) ──────────────────────────────────── */

export interface ImportRun {
  at: string;
  source: Source;
  kind: ImportKind;
  by: string;
  created: number;
  updated: number;
  skipped: number;
  streamsCreated: string[];
  customersCreated: string[];
  errors: number;
}

const HISTORY_LIMIT = 20;
const history = new Map<number, ImportRun[]>();

function recordRun(ctx: ActionContext, result: CommitResult): void {
  const runs = history.get(ctx.orgId) ?? [];
  runs.unshift({
    at: result.at,
    source: result.source,
    kind: result.kind,
    by: actorLabel(ctx),
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    streamsCreated: result.streamsCreated,
    customersCreated: result.customersCreated,
    errors: result.errors.length,
  });
  history.set(ctx.orgId, runs.slice(0, HISTORY_LIMIT));
}

export function runsFor(orgId: number): ImportRun[] {
  return history.get(orgId) ?? [];
}

/** Test seam — the list is process-local by design, so it needs a reset. */
export function clearHistory(): void {
  history.clear();
}

/* ── Small utilities ─────────────────────────────────────────────────── */

function actorLabel(ctx: ActionContext): string {
  return ctx.authType === "agent" ? `${ctx.displayName} (agent)` : ctx.displayName;
}

function collect(warnings: string[], result: RowResult<unknown>): void {
  for (const w of result.warnings) warnings.push(`row ${result.index}: ${w}`);
  if (result.skip) warnings.push(`row ${result.index}: skipped — ${result.skip}`);
}

function pushWarning(result: CommitResult, warning: string): void {
  if (result.warnings.length < MAX_WARNINGS) result.warnings.push(warning);
}

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

/**
 * Card descriptions are rendered as HTML (client/src/features/plan/RichText.tsx
 * sanitises them), so a multi-line plain-text description has to be escaped and
 * given explicit breaks or it collapses onto one line. Single-line text is left
 * exactly as the file had it.
 */
export function descriptionToStore(text: string | null): string | null {
  if (!text) return null;
  if (!/[\r\n]/.test(text)) return text;
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .join("<br>");
}

/** Re-exported so callers do not need the mapper internals. */
export { isTaskSource, norm };
