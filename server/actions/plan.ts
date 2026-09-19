import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { addDays } from "date-fns";
import { db } from "../../db";
import { apps, memberships, streams, tasks, users, TASK_STATUSES, type Task, customers } from "../../db/schema";
import { ActionError, defineAction, type ActionContext } from "./registry";
import { wouldCreateCycle } from "../cascade";
import {
  applyCascade,
  assertAppOnStream,
  assertApp,
  assertAssignee,
  assertDependencies,
  assertStream,
  canComplete,
  computeCriticalPath,
  deriveStatus,
  depsOf,
  endOf,
  fetchOrgTask,
  fetchOrgTasks,
  floatDays,
  isBlocked,
  isoOrNull,
  parseDate,
  requireTask,
  resolvePriority,
  serializeTask,
} from "../plan/taskOps";
import {
  attachApp,
  createStream,
  detachApp,
  listStreams,
  moveTasksBetweenStreams,
  renameStream,
  updateStream,
} from "../plan/streamOps";
import { actorFrom, diffTask, listEventsForTask, recordEvent, summariseChanges } from "../plan/taskEvents";

/**
 * Plan surface actions — the Kanttban tool set, re-cut for PTD's org/stream/app
 * schema. Every one of these is simultaneously an MCP tool and a
 * POST /api/actions/<name> endpoint; the registry applies the role gate, so
 * nothing in this file re-checks it except where the rule is finer-grained
 * than a role (task.complete).
 *
 * Invariants kept in one place on purpose:
 *   - every query is filtered by ctx.orgId, never by an id from the caller;
 *   - every mutation writes one task_events row + one webhook (taskEvents.ts);
 *   - anything that moves a card in time runs the cascade (taskOps.applyCascade);
 *   - priority_score is derived via db/schema's priorityScore() unless the card
 *     is pinned to a manual/ai score.
 */

const taskIdArg = z.number().int().positive().describe("Task id");
const dateArg = z.string().min(4).describe("ISO 8601 date, e.g. 2026-03-01 or 2026-03-01T00:00:00Z");
const score = (label: string) => z.number().int().min(0).max(10).describe(`${label} on a 0–10 scale`);

/* ─────────────────────────── reads (member+) ─────────────────────────── */

defineAction({
  name: "task.list",
  title: "List tasks",
  description:
    "Tasks in the organization, newest-priority first. Filter by status, stream, app or assignee. Completed cards are excluded unless includeCompleted is true.",
  input: z.object({
    status: z.enum(TASK_STATUSES).optional().describe("Exact status filter"),
    streamId: z.number().int().nullable().optional().describe("Stream id, or null for cards with no stream"),
    appId: z.number().int().nullable().optional().describe("App id, or null for cards with no app"),
    assignedTo: z.number().int().nullable().optional().describe("Assignee user id, or null for unassigned cards"),
    includeCompleted: z.boolean().optional().describe("Include completed cards (default false)"),
  }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    let rows = await fetchOrgTasks(ctx.orgId);
    if (!args.includeCompleted) rows = rows.filter((t) => !t.completed);
    if (args.status) rows = rows.filter((t) => t.status === args.status);
    if ("streamId" in args) rows = rows.filter((t) => (t.streamId ?? null) === (args.streamId ?? null));
    if ("appId" in args) rows = rows.filter((t) => (t.appId ?? null) === (args.appId ?? null));
    if ("assignedTo" in args) rows = rows.filter((t) => (t.assignedTo ?? null) === (args.assignedTo ?? null));
    rows.sort((a, b) => b.priorityScore - a.priorityScore || a.id - b.id);
    return { count: rows.length, tasks: rows.map(serializeTask) };
  },
});

defineAction({
  name: "task.get",
  title: "Get one task",
  description:
    "A single card with its stream, app, assignee, expanded dependencies, the cards that depend on it, and whether it is currently blocked.",
  input: z.object({ taskId: taskIdArg }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    const all = await fetchOrgTasks(ctx.orgId);
    const task = all.find((t) => t.id === args.taskId);
    if (!task) throw new ActionError("not_found", `Task ${args.taskId} not found in this organization`);

    const brief = (t: Task) => ({ id: t.id, title: t.title, status: t.status, completed: t.completed, startDate: isoOrNull(t.startDate), end: isoOrNull(endOf(t)) });
    const [stream] = task.streamId
      ? await db.select({ id: streams.id, name: streams.name, color: streams.color }).from(streams).where(and(eq(streams.id, task.streamId), eq(streams.orgId, ctx.orgId))).limit(1)
      : [null];
    const [app] = task.appId
      ? await db.select({ id: apps.id, key: apps.key, name: apps.name }).from(apps).where(and(eq(apps.id, task.appId), eq(apps.orgId, ctx.orgId))).limit(1)
      : [null];
    const [assignee] = task.assignedTo
      ? await db.select({ userId: users.id, displayName: users.displayName, email: users.email, isAgent: users.isAgent }).from(users).where(eq(users.id, task.assignedTo)).limit(1)
      : [null];

    return {
      task: serializeTask(task),
      stream: stream ?? null,
      app: app ?? null,
      assignee: assignee ?? null,
      dependencies: depsOf(task).map((id) => all.find((t) => t.id === id)).filter((t): t is Task => !!t).map(brief),
      dependents: all.filter((t) => depsOf(t).includes(task.id)).map(brief),
      blocked: isBlocked(task, all),
    };
  },
});

defineAction({
  name: "task.history",
  title: "Task history",
  description: "Append-only audit log for one card: who changed what, when, and through which surface (web, mcp, slack, api, import). Most recent first.",
  input: z.object({ taskId: taskIdArg, limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)") }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    await requireTask(ctx.orgId, args.taskId);
    const events = await listEventsForTask(args.taskId, ctx.orgId, args.limit ?? 50);
    return { taskId: args.taskId, count: events.length, events };
  },
});

defineAction({
  name: "stream.list",
  title: "List streams",
  description:
    "Every work stream (swim-lane) in the organization with its colour, position, attached apps, agent budget and card counts. Cards with no stream are reported separately as `unstreamed`.",
  input: z.object({ includeArchived: z.boolean().optional().describe("Include archived streams (default true)") }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => listStreams(ctx.orgId, args.includeArchived ?? true),
});

/* ─────────────────────────── member mutations ─────────────────────────── */

defineAction({
  name: "task.complete",
  title: "Mark task complete",
  description:
    "Strike a card off the active board. A member may only complete a card assigned to themselves; manager and above may complete any card in the organization.",
  input: z.object({ taskId: taskIdArg, note: z.string().max(2000).optional().describe("Why / what shipped — stored on the history row") }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    const existing = await requireTask(ctx.orgId, args.taskId);
    if (!canComplete(ctx.role, existing, ctx.userId)) {
      throw new ActionError("forbidden", "Members may only complete tasks assigned to themselves — ask a manager, or assign the task to yourself first");
    }
    if (existing.completed) return { task: serializeTask(existing), changed: false };

    const [updated] = await db
      .update(tasks)
      .set({ completed: true, status: "completed", updatedAt: new Date() })
      .where(and(eq(tasks.id, args.taskId), eq(tasks.orgId, ctx.orgId)))
      .returning();
    const final = updated as Task;
    await recordEvent({
      taskId: args.taskId,
      orgId: ctx.orgId,
      actor: actorFrom(ctx),
      kind: "completed",
      changes: diffTask(existing, final),
      note: args.note ?? "Marked complete",
      payload: { task: serializeTask(final) },
    });
    return { task: serializeTask(final), changed: true };
  },
});

defineAction({
  name: "task.find_or_create",
  title: "Find or create a task by external key",
  description:
    "Idempotent entry point for integrations and agents: returns the card whose externalKey matches inside this organization, or creates it in the backlog. Call it twice with the same externalKey and you get the same card back.",
  input: z.object({
    title: z.string().min(1).max(500).describe("Used only when the card has to be created"),
    externalKey: z.string().min(1).max(128).describe("Stable id from the source system, e.g. JIRA-1234 or a GitHub issue URL"),
    streamId: z.number().int().optional().describe("Stream to file a newly created card under"),
  }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    const all = await fetchOrgTasks(ctx.orgId);
    const existing = all.find((t) => t.externalKey === args.externalKey);
    if (existing) return { task: serializeTask(existing), created: false };

    if (args.streamId !== undefined) await assertStream(ctx.orgId, args.streamId);
    const [created] = await db
      .insert(tasks)
      .values({
        orgId: ctx.orgId,
        title: args.title,
        status: "backlog",
        streamId: args.streamId ?? null,
        externalKey: args.externalKey,
        createdBy: ctx.userId,
      })
      .returning();
    const task = created as Task;
    await recordEvent({
      taskId: task.id,
      orgId: ctx.orgId,
      actor: actorFrom(ctx),
      kind: "created",
      note: `Created from external key ${args.externalKey} · backlog`,
      payload: { task: serializeTask(task), externalKey: args.externalKey },
    });
    return { task: serializeTask(task), created: true };
  },
});

/* ─────────────────────────── manager mutations ─────────────────────────── */

const createInput = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional().describe("HTML from the card editor, or plain text"),
  streamId: z.number().int().optional().describe("Swim-lane the card belongs to"),
  appId: z.number().int().optional().describe("Product/app the work lands in — must be attached to streamId when both are given"),
  externalKey: z.string().max(128).optional().describe("Stable id from the source system; unique per organization"),
  estimatedDuration: z.number().int().min(1).optional().describe("Working length in days — the width of the Gantt bar"),
  startDate: dateArg.optional().describe("Set it and the card lands on the timeline as in-progress; omit it and the card stays in the backlog"),
  dueDate: dateArg.optional().describe("Hard deadline pin, independent of the duration"),
  dependencies: z.array(z.number().int()).optional().describe("Task ids that must finish first"),
  assignedTo: z.number().int().optional().describe("Org member (human or agent) who owns the card"),
  urgency: score("Urgency").optional(),
  impact: score("Impact").optional(),
  effort: score("Effort").optional(),
  tags: z.array(z.string().max(60)).optional(),
  status: z.enum(TASK_STATUSES).optional().describe("Overrides the startDate-derived default"),
});

defineAction({
  name: "task.create",
  title: "Create task",
  description:
    "Draft a new card. Without a startDate it goes to the backlog; with one it is scheduled as in-progress and its dependents cascade forward. priorityScore is derived from urgency×impact/effort.",
  input: createInput,
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const all = await fetchOrgTasks(ctx.orgId);
    if (args.externalKey && all.some((t) => t.externalKey === args.externalKey)) {
      throw new ActionError("conflict", `externalKey "${args.externalKey}" is already used in this organization — use task.find_or_create for idempotent creation`);
    }
    if (args.streamId !== undefined) await assertStream(ctx.orgId, args.streamId);
    if (args.appId !== undefined) {
      if (args.streamId !== undefined) await assertAppOnStream(ctx.orgId, args.streamId, args.appId);
      else await assertApp(ctx.orgId, args.appId);
    }
    if (args.assignedTo !== undefined) await assertAssignee(ctx.orgId, args.assignedTo);
    const dependencies = assertDependencies(null, args.dependencies ?? [], all);

    const startDate = args.startDate ? parseDate(args.startDate, "startDate") : null;
    const dueDate = args.dueDate ? parseDate(args.dueDate, "dueDate") : null;
    const priority = resolvePriority(
      { urgency: 5, impact: 5, effort: 5, priorityScore: 5, prioritySource: "formula" },
      { urgency: args.urgency, impact: args.impact, effort: args.effort },
      { force: true }
    );

    const [row] = await db
      .insert(tasks)
      .values({
        orgId: ctx.orgId,
        title: args.title,
        description: args.description ?? null,
        // Kanttban's rule: a card with a start date belongs on the timeline.
        status: args.status ?? (startDate ? "in-progress" : "backlog"),
        streamId: args.streamId ?? null,
        appId: args.appId ?? null,
        assignedTo: args.assignedTo ?? null,
        startDate,
        dueDate,
        estimatedDuration: args.estimatedDuration ?? null,
        dependencies,
        externalKey: args.externalKey ?? null,
        urgency: priority.urgency,
        impact: priority.impact,
        effort: priority.effort,
        priorityScore: priority.priorityScore,
        prioritySource: priority.prioritySource,
        tags: args.tags ?? [],
        createdBy: ctx.userId,
      })
      .returning();
    const created = row as Task;

    const actor = actorFrom(ctx);
    let cascade = { shifted: 0, ids: [] as number[] };
    if (created.startDate) cascade = await applyCascade(ctx.orgId, created.id, actor);

    const final = (await fetchOrgTask(ctx.orgId, created.id)) ?? created;
    await recordEvent({
      taskId: created.id,
      orgId: ctx.orgId,
      actor,
      kind: "created",
      note: `Created${created.startDate ? " · scheduled" : " · backlog"}${cascade.shifted ? ` · ${cascade.shifted} dependent(s) shifted` : ""}`,
      payload: { task: serializeTask(final) },
    });
    return { task: serializeTask(final), cascaded: cascade.ids };
  },
});

const updateInput = z.object({
  taskId: taskIdArg,
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  streamId: z.number().int().nullable().optional().describe("null detaches the card from its stream"),
  appId: z.number().int().nullable().optional().describe("Must be attached to the card's stream; null clears it"),
  externalKey: z.string().max(128).nullable().optional(),
  estimatedDuration: z.number().int().min(1).nullable().optional(),
  startDate: dateArg.nullable().optional().describe("null unschedules the card back to the backlog"),
  dueDate: dateArg.nullable().optional(),
  dependencies: z.array(z.number().int()).optional().describe("Replaces the list; cycles are rejected"),
  assignedTo: z.number().int().nullable().optional(),
  urgency: score("Urgency").optional(),
  impact: score("Impact").optional(),
  effort: score("Effort").optional(),
  tags: z.array(z.string().max(60)).optional(),
  completed: z.boolean().optional(),
});

defineAction({
  name: "task.update",
  title: "Update task",
  description:
    "Patch any subset of a card's fields. Cascades every dependent forward when startDate, estimatedDuration, dueDate or dependencies change; rejects dependency cycles; keeps a manual/ai priority score unless you go through task.set_priority.",
  input: updateInput,
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const all = await fetchOrgTasks(ctx.orgId);
    const existing = all.find((t) => t.id === args.taskId);
    if (!existing) throw new ActionError("not_found", `Task ${args.taskId} not found in this organization`);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if ("title" in args) update.title = args.title;
    if ("description" in args) update.description = args.description ?? null;
    if ("externalKey" in args) {
      if (args.externalKey && all.some((t) => t.id !== args.taskId && t.externalKey === args.externalKey)) {
        throw new ActionError("conflict", `externalKey "${args.externalKey}" is already used by another card in this organization`);
      }
      update.externalKey = args.externalKey ?? null;
    }
    if ("estimatedDuration" in args) update.estimatedDuration = args.estimatedDuration ?? null;
    if ("tags" in args) update.tags = args.tags ?? [];
    if ("completed" in args) {
      update.completed = args.completed;
      if (args.completed && !("status" in args)) update.status = "completed";
    }

    // The stream/app pair has to be legal AFTER the patch, not just within it.
    const nextStreamId = "streamId" in args ? args.streamId ?? null : existing.streamId;
    const nextAppId = "appId" in args ? args.appId ?? null : existing.appId;
    if ("streamId" in args && args.streamId != null) await assertStream(ctx.orgId, args.streamId);
    if (nextAppId != null) {
      if (nextStreamId != null) await assertAppOnStream(ctx.orgId, nextStreamId, nextAppId);
      else await assertApp(ctx.orgId, nextAppId);
    }
    if ("streamId" in args) update.streamId = nextStreamId;
    if ("appId" in args) update.appId = nextAppId;

    if ("assignedTo" in args) {
      if (args.assignedTo != null) await assertAssignee(ctx.orgId, args.assignedTo);
      update.assignedTo = args.assignedTo ?? null;
    }

    const startDate = "startDate" in args ? (args.startDate ? parseDate(args.startDate, "startDate") : null) : undefined;
    if (startDate !== undefined) update.startDate = startDate;
    if ("dueDate" in args) update.dueDate = args.dueDate ? parseDate(args.dueDate, "dueDate") : null;

    let depsChanged = false;
    if ("dependencies" in args && args.dependencies) {
      const dependencies = assertDependencies(args.taskId, args.dependencies, all);
      if (wouldCreateCycle(all, args.taskId, dependencies)) {
        throw new ActionError("invalid", "Cycle detected — a task cannot depend on itself, directly or transitively");
      }
      update.dependencies = dependencies;
      depsChanged = true;
    }

    if ("urgency" in args || "impact" in args || "effort" in args) {
      const priority = resolvePriority(existing, { urgency: args.urgency, impact: args.impact, effort: args.effort });
      update.urgency = priority.urgency;
      update.impact = priority.impact;
      update.effort = priority.effort;
      update.priorityScore = priority.priorityScore;
      update.prioritySource = priority.prioritySource;
    }

    // Auto-promote/demote across the backlog↔timeline boundary.
    if (startDate !== undefined) {
      const derived = deriveStatus(existing, startDate, args.status);
      if (derived) update.status = derived;
    } else if ("status" in args) {
      update.status = args.status;
    }

    const [row] = await db
      .update(tasks)
      .set(update)
      .where(and(eq(tasks.id, args.taskId), eq(tasks.orgId, ctx.orgId)))
      .returning();
    const updated = row as Task;

    const timeChanged =
      isoOrNull(existing.startDate) !== isoOrNull(updated.startDate) ||
      isoOrNull(existing.dueDate) !== isoOrNull(updated.dueDate) ||
      existing.estimatedDuration !== updated.estimatedDuration;

    const actor = actorFrom(ctx);
    let cascade = { shifted: 0, ids: [] as number[] };
    if (timeChanged || depsChanged) cascade = await applyCascade(ctx.orgId, args.taskId, actor);

    // Refetch so the response and the diff reflect any shift the cascade wrote
    // onto this same row.
    const final = (await fetchOrgTask(ctx.orgId, args.taskId)) ?? updated;
    const changes = diffTask(existing, final);
    let kind: "updated" | "completed" | "scheduled" | "unscheduled" = "updated";
    if (args.completed === true) kind = "completed";
    else if (startDate !== undefined) {
      if (existing.startDate && !final.startDate) kind = "unscheduled";
      else if (!existing.startDate && final.startDate) kind = "scheduled";
    }
    if (changes) {
      await recordEvent({
        taskId: args.taskId,
        orgId: ctx.orgId,
        actor,
        kind,
        changes,
        note: summariseChanges(changes) + (cascade.shifted ? ` · ${cascade.shifted} dependent(s) shifted` : ""),
        payload: { task: serializeTask(final) },
      });
    }
    return { task: serializeTask(final), cascaded: cascade.ids, changed: !!changes };
  },
});

defineAction({
  name: "task.schedule",
  title: "Schedule task",
  description: "Put a card on the timeline at a start date (optionally setting its duration), promote it out of the backlog, and cascade its dependents forward.",
  input: z.object({
    taskId: taskIdArg,
    startDate: dateArg,
    estimatedDuration: z.number().int().min(1).optional().describe("Days — sets the bar width at the same time"),
  }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const existing = await requireTask(ctx.orgId, args.taskId);
    const startDate = parseDate(args.startDate, "startDate");
    const update: Record<string, unknown> = { startDate, updatedAt: new Date() };
    if (args.estimatedDuration !== undefined) update.estimatedDuration = args.estimatedDuration;
    if (!existing.completed && existing.status !== "in-progress") update.status = "in-progress";

    await db.update(tasks).set(update).where(and(eq(tasks.id, args.taskId), eq(tasks.orgId, ctx.orgId)));
    const actor = actorFrom(ctx);
    const cascade = await applyCascade(ctx.orgId, args.taskId, actor);
    const final = (await fetchOrgTask(ctx.orgId, args.taskId))!;

    await recordEvent({
      taskId: args.taskId,
      orgId: ctx.orgId,
      actor,
      kind: "scheduled",
      changes: diffTask(existing, final),
      note: `Scheduled for ${startDate.toISOString().slice(0, 10)}${cascade.shifted ? ` · ${cascade.shifted} dependent(s) shifted` : ""}`,
      payload: { task: serializeTask(final) },
    });
    return { task: serializeTask(final), cascaded: cascade.ids };
  },
});

defineAction({
  name: "task.unschedule",
  title: "Unschedule task",
  description: "Take a card off the timeline and back into the backlog. Its due date, if any, is kept — only the start date is cleared.",
  input: z.object({ taskId: taskIdArg }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const existing = await requireTask(ctx.orgId, args.taskId);
    if (!existing.startDate) return { task: serializeTask(existing), changed: false, cascaded: [] as number[] };

    const update: Record<string, unknown> = { startDate: null, updatedAt: new Date() };
    if (!existing.completed && existing.status === "in-progress") update.status = "backlog";
    await db.update(tasks).set(update).where(and(eq(tasks.id, args.taskId), eq(tasks.orgId, ctx.orgId)));

    const actor = actorFrom(ctx);
    // Dependents are never pulled backwards (cascade only pushes forward), but
    // the graph is re-settled so a dependent still sitting behind another
    // dependency's end gets corrected.
    const cascade = await applyCascade(ctx.orgId, args.taskId, actor);
    const final = (await fetchOrgTask(ctx.orgId, args.taskId))!;
    await recordEvent({
      taskId: args.taskId,
      orgId: ctx.orgId,
      actor,
      kind: "unscheduled",
      changes: diffTask(existing, final),
      note: "Returned to the backlog",
      payload: { task: serializeTask(final) },
    });
    return { task: serializeTask(final), changed: true, cascaded: cascade.ids };
  },
});

defineAction({
  name: "task.set_dependencies",
  title: "Set task dependencies",
  description: "Replace a card's dependency list. Every id must be a task in this organization, cycles are rejected, and dependents cascade forward afterwards.",
  input: z.object({ taskId: taskIdArg, dependencies: z.array(z.number().int()).describe("Complete replacement list — pass [] to clear") }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const all = await fetchOrgTasks(ctx.orgId);
    const existing = all.find((t) => t.id === args.taskId);
    if (!existing) throw new ActionError("not_found", `Task ${args.taskId} not found in this organization`);

    const dependencies = assertDependencies(args.taskId, args.dependencies, all);
    if (wouldCreateCycle(all, args.taskId, dependencies)) {
      throw new ActionError("invalid", "Cycle detected — a task cannot depend on itself, directly or transitively");
    }
    await db
      .update(tasks)
      .set({ dependencies, updatedAt: new Date() })
      .where(and(eq(tasks.id, args.taskId), eq(tasks.orgId, ctx.orgId)));

    const actor = actorFrom(ctx);
    const cascade = await applyCascade(ctx.orgId, args.taskId, actor);
    const final = (await fetchOrgTask(ctx.orgId, args.taskId))!;
    await recordEvent({
      taskId: args.taskId,
      orgId: ctx.orgId,
      actor,
      kind: "updated",
      changes: { dependencies: { old: depsOf(existing).slice().sort(), new: dependencies.slice().sort() } },
      note: `Dependencies replaced (${dependencies.length})${cascade.shifted ? ` · ${cascade.shifted} dependent(s) shifted` : ""}`,
      payload: { task: serializeTask(final) },
    });
    return { task: serializeTask(final), cascaded: cascade.ids };
  },
});

defineAction({
  name: "task.set_assignee",
  title: "Set task assignee",
  description:
    "Give a card to an org member — human or agent — or pass userId: null to unassign. The target must hold a membership in this organization; call org.members for valid ids.",
  input: z.object({ taskId: taskIdArg, userId: z.number().int().nullable().describe("Member user id, or null to unassign") }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const existing = await requireTask(ctx.orgId, args.taskId);
    const member = args.userId === null ? null : await assertAssignee(ctx.orgId, args.userId);
    const previous = existing.assignedTo ?? null;
    if (previous === args.userId) return { task: serializeTask(existing), changed: false, assignee: member };

    const [row] = await db
      .update(tasks)
      .set({ assignedTo: args.userId, updatedAt: new Date() })
      .where(and(eq(tasks.id, args.taskId), eq(tasks.orgId, ctx.orgId)))
      .returning();
    const final = row as Task;
    await recordEvent({
      taskId: args.taskId,
      orgId: ctx.orgId,
      actor: actorFrom(ctx),
      kind: "assigned",
      changes: { assignedTo: { old: previous, new: args.userId } },
      note: member ? `Assigned to ${member.displayName}${member.isAgent ? " (agent)" : ""}` : "Unassigned",
      payload: { task: serializeTask(final), assignee: member },
    });
    return { task: serializeTask(final), changed: true, assignee: member };
  },
});

defineAction({
  name: "task.set_priority",
  title: "Set task priority",
  description:
    "Re-score a card. Passing manualScore pins priorityScore and flips prioritySource to 'manual'; otherwise the score is recomputed as urgency×impact/effort (clamped 0–100) with prioritySource 'formula'.",
  input: z.object({
    taskId: taskIdArg,
    urgency: score("Urgency").optional(),
    impact: score("Impact").optional(),
    effort: score("Effort").optional(),
    manualScore: z.number().int().min(0).max(100).nullable().optional().describe("Override the formula; null drops an existing override"),
    note: z.string().max(2000).optional().describe("Why this priority — stored on the card as priorityNote"),
  }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const existing = await requireTask(ctx.orgId, args.taskId);
    const priority = resolvePriority(
      existing,
      { urgency: args.urgency, impact: args.impact, effort: args.effort, manualScore: "manualScore" in args ? args.manualScore : undefined },
      { force: true }
    );
    const update: Record<string, unknown> = { ...priority, updatedAt: new Date() };
    if ("note" in args) update.priorityNote = args.note ?? null;

    const [row] = await db
      .update(tasks)
      .set(update)
      .where(and(eq(tasks.id, args.taskId), eq(tasks.orgId, ctx.orgId)))
      .returning();
    const final = row as Task;
    const changes = diffTask(existing, final);
    if (changes) {
      await recordEvent({
        taskId: args.taskId,
        orgId: ctx.orgId,
        actor: actorFrom(ctx),
        kind: "priority_changed",
        changes,
        note: `Priority ${existing.priorityScore} → ${final.priorityScore} (${final.prioritySource})`,
        payload: { task: serializeTask(final) },
      });
    }
    return { task: serializeTask(final), changed: !!changes };
  },
});

defineAction({
  name: "task.delete",
  title: "Delete task",
  description:
    "Remove a card for good. Any card that depended on it has the reference stripped from its dependency list, so the graph stays consistent. Prefer task.complete for finished work — this is not reversible.",
  input: z.object({ taskId: taskIdArg }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const all = await fetchOrgTasks(ctx.orgId);
    const existing = all.find((t) => t.id === args.taskId);
    if (!existing) throw new ActionError("not_found", `Task ${args.taskId} not found in this organization`);
    const actor = actorFrom(ctx);

    // Strip the dangling reference from every dependent first — `dependencies`
    // is jsonb, so nothing at the database level would do it for us.
    const dependents = all.filter((t) => t.id !== args.taskId && depsOf(t).includes(args.taskId));
    for (const dependent of dependents) {
      const before = depsOf(dependent);
      const after = before.filter((id) => id !== args.taskId);
      await db
        .update(tasks)
        .set({ dependencies: after, updatedAt: new Date() })
        .where(and(eq(tasks.id, dependent.id), eq(tasks.orgId, ctx.orgId)));
      await recordEvent({
        taskId: dependent.id,
        orgId: ctx.orgId,
        actor,
        kind: "updated",
        changes: { dependencies: { old: before.slice().sort(), new: after.slice().sort() } },
        note: `Dependency on deleted task #${args.taskId} removed`,
      });
    }

    // Recorded before the DELETE so the webhook carries the final snapshot.
    // The history row itself goes with the card — task_events.task_id is
    // ON DELETE CASCADE — so the webhook is the part that outlives it.
    await recordEvent({
      taskId: args.taskId,
      orgId: ctx.orgId,
      actor,
      kind: "deleted",
      changes: null,
      note: `Deleted "${existing.title}"`,
      payload: { task: serializeTask(existing), dependentsUpdated: dependents.map((d) => d.id) },
    });
    await db.delete(tasks).where(and(eq(tasks.id, args.taskId), eq(tasks.orgId, ctx.orgId)));
    return { deleted: args.taskId, dependentsUpdated: dependents.map((d) => d.id) };
  },
});

/* ─────────────────────────── streams (manager+) ─────────────────────────── */

defineAction({
  name: "stream.create",
  title: "Create stream",
  description: "Open a new swim-lane. Optionally attach the apps whose work will be filed under it; a card may only point at an app its stream owns.",
  input: z.object({
    name: z.string().min(1).max(255),
    color: z.string().max(16).nullable().optional().describe("Lane colour, e.g. #8a3324 or an hsl triple"),
    appIds: z.array(z.number().int()).optional().describe("Apps to attach immediately"),
  }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const { stream, apps: attached } = await createStream(ctx.orgId, { name: args.name, color: args.color ?? null, appIds: args.appIds }, actorFrom(ctx));
    return { stream, appIds: attached };
  },
});

defineAction({
  name: "stream.rename",
  title: "Rename stream",
  description: "Rename a swim-lane. Writes one stream_renamed history row per card in the lane so a card's own history explains the new label.",
  input: z.object({ streamId: z.number().int().positive(), name: z.string().min(1).max(255) }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => renameStream(ctx.orgId, args.streamId, args.name, actorFrom(ctx)),
});

defineAction({
  name: "stream.update",
  title: "Update stream",
  description: "Change a lane's colour, archive state, board position or monthly agent budget in USD.",
  input: z.object({
    streamId: z.number().int().positive(),
    color: z.string().max(16).nullable().optional(),
    archived: z.boolean().optional(),
    position: z.number().int().min(0).optional().describe("Lane order on the board, ascending"),
    agentBudgetUsd: z.number().nonnegative().nullable().optional().describe("Spend ceiling for agent work in this lane"),
    customerId: z.number().int().positive().nullable().optional().describe("Customer this lane is billed to (null to unbill)"),
  }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const { streamId, ...patch } = args;
    if (patch.customerId != null) {
      const [c] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, patch.customerId), eq(customers.orgId, ctx.orgId))).limit(1);
      if (!c) throw new ActionError("not_found", `Customer ${patch.customerId} is not in this organization`);
    }
    return updateStream(ctx.orgId, streamId, patch, actorFrom(ctx));
  },
});

defineAction({
  name: "stream.move_tasks",
  title: "Move every card between two streams",
  description:
    "Move all cards from one lane to another — this is also how you merge two lanes. Pass null on either side to mean 'the cards with no stream'. A card whose app is not attached to the target lane has its appId cleared and that is reported back.",
  input: z.object({
    fromStreamId: z.number().int().nullable().describe("Source lane, or null for unstreamed cards"),
    toStreamId: z.number().int().nullable().describe("Target lane, or null to unfile the cards"),
  }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => moveTasksBetweenStreams(ctx.orgId, args.fromStreamId, args.toStreamId, actorFrom(ctx)),
});

defineAction({
  name: "stream.attach_app",
  title: "Attach an app to a stream",
  description: "Allow cards in this lane to be filed against the given app. Idempotent.",
  input: z.object({ streamId: z.number().int().positive(), appId: z.number().int().positive() }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => attachApp(ctx.orgId, args.streamId, args.appId, actorFrom(ctx)),
});

defineAction({
  name: "stream.detach_app",
  title: "Detach an app from a stream",
  description: "Stop filing this lane's cards against the app. Any card in the lane still pointing at it has its appId cleared.",
  input: z.object({ streamId: z.number().int().positive(), appId: z.number().int().positive() }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => detachApp(ctx.orgId, args.streamId, args.appId, actorFrom(ctx)),
});

/* ─────────────────────────── analysis (manager+) ─────────────────────────── */

defineAction({
  name: "critical_path",
  title: "Critical path",
  description:
    "The longest dependency chain in the organization weighted by estimated duration. Its length is the earliest the whole plan can finish; shortening anything else does not help.",
  input: z.object({}),
  requiredRole: "manager",
  surface: "plan",
  handler: async (_args, ctx) => {
    const all = await fetchOrgTasks(ctx.orgId);
    const { length, path } = computeCriticalPath(all);
    return { totalDays: length, taskCount: path.length, tasks: path.map(serializeTask) };
  },
});

defineAction({
  name: "blocked_tasks",
  title: "Blocked tasks",
  description: "Cards waiting on at least one dependency that is neither complete nor already finished — the work that cannot legitimately start yet.",
  input: z.object({}),
  requiredRole: "manager",
  surface: "plan",
  handler: async (_args, ctx) => {
    const all = await fetchOrgTasks(ctx.orgId);
    const blocked = all.filter((t) => !t.completed && isBlocked(t, all));
    return {
      count: blocked.length,
      tasks: blocked.map((t) => ({
        ...serializeTask(t),
        blockedBy: depsOf(t)
          .map((id) => all.find((d) => d.id === id))
          .filter((d): d is Task => !!d && !d.completed)
          .map((d) => ({ id: d.id, title: d.title, end: isoOrNull(endOf(d)) })),
      })),
    };
  },
});

defineAction({
  name: "tasks_by_assignee",
  title: "Tasks grouped by assignee",
  description: "Roster view: every member of the organization — humans and agents alike — with the cards they currently own, plus the unassigned pile.",
  input: z.object({}),
  requiredRole: "manager",
  surface: "plan",
  handler: async (_args, ctx) => {
    const [all, members] = await Promise.all([
      fetchOrgTasks(ctx.orgId),
      db
        .select({ userId: memberships.userId, displayName: users.displayName, email: users.email, isAgent: users.isAgent, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.orgId, ctx.orgId))
        .orderBy(memberships.createdAt),
    ]);
    const open = (list: Task[]) => list.filter((t) => !t.completed);
    const assignees = members.map((m) => {
      const own = all.filter((t) => t.assignedTo === m.userId);
      return {
        ...m,
        total: own.length,
        open: open(own).length,
        blocked: open(own).filter((t) => isBlocked(t, all)).length,
        tasks: own.map(serializeTask),
      };
    });
    const loose = all.filter((t) => !t.assignedTo);
    return {
      assignees,
      unassigned: { total: loose.length, open: open(loose).length, tasks: loose.map(serializeTask) },
    };
  },
});

defineAction({
  name: "upcoming_due",
  title: "Upcoming deadlines",
  description: "Open cards whose due date — or computed end (startDate + duration) — falls within the next N days. Defaults to a week. Overdue cards are included and flagged.",
  input: z.object({ days: z.number().int().min(1).max(365).optional().describe("Horizon in days (default 7)") }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const days = args.days ?? 7;
    const now = new Date();
    const horizon = addDays(now, days);
    const all = await fetchOrgTasks(ctx.orgId);
    const rows = all
      .filter((t) => !t.completed)
      .map((t) => ({ task: t, end: endOf(t) }))
      .filter((x): x is { task: Task; end: Date } => !!x.end && x.end <= horizon)
      .sort((a, b) => a.end.getTime() - b.end.getTime())
      .map((x) => ({ ...serializeTask(x.task), end: x.end.toISOString(), overdue: x.end < now, slackDays: floatDays(x.task) }));
    return { withinDays: days, count: rows.length, overdue: rows.filter((r) => r.overdue).length, tasks: rows };
  },
});
