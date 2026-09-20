import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { taskAttachments } from "../../db/schema";
import { ActionError, defineAction } from "./registry";
import { hasRole } from "../types";
import { addComment, deleteComment, listComments } from "../plan/comments";
import { dropBlobIfUnreferenced, fetchAttachment, listAttachments, serializeAttachment } from "../plan/attachments";
import { FIELD_KINDS, createField, customValuesMap, listFieldRows, serializeField, setCustomValues, updateField } from "../plan/customFields";
import { listRecurrences, setRecurrence } from "../plan/recurrences";
import { actorFrom, recordEvent } from "../plan/taskEvents";
import { fetchOrgTasks, requireTask } from "../plan/taskOps";

/**
 * Workflow depth on top of the Plan surface: comments, attachments, recurring
 * cards and per-organization custom fields.
 *
 * They live in their own module rather than in plan.ts because they are four
 * self-contained features with their own storage rules, but they are the same
 * kind of citizen as everything in there — one registry action is simultaneously
 * an MCP tool, a `POST /api/actions/<name>` endpoint and a chat verb, and the
 * registry applies the role gate before the handler runs.
 *
 * Where a rule is finer-grained than a role, it is written out in the handler
 * and named in the description:
 *
 *   task.comment_delete   author, or manager and above
 *   task.attachment_delete uploader, or manager and above
 *   task.set_custom       a member may only write to a card assigned to them
 *
 * Attachment *bytes* do not travel through an action — they go over
 * `PUT /api/plan/tasks/:id/attachments` and come back from
 * `GET /api/plan/attachments/:id` (server/plan/routes.ts), because JSON is the
 * wrong envelope for 25 MB of PDF.
 */

const taskIdArg = z.number().int().positive().describe("Task id");

/* ─────────────────────────── comments ─────────────────────────── */

defineAction({
  name: "task.comment_add",
  title: "Comment on a task",
  description:
    "Add a comment to any card in the organization. The body is markdown-lite — **bold**, _italic_, `code` and links — stored as written and sanitised when it is rendered. Writes one `updated` history row noted \"commented\" and fires a `task.commented` webhook.",
  input: z.object({
    taskId: taskIdArg,
    body: z.string().min(1).max(10_000).describe("Markdown-lite text. Bold, italic, inline code, autolinked URLs and [text](url) links are rendered; everything else shows as written"),
  }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => ({ comment: await addComment(ctx, args.taskId, args.body) }),
});

defineAction({
  name: "task.comment_list",
  title: "List task comments",
  description: "Every comment on one card, oldest first, with each author's display name and whether they are an agent.",
  input: z.object({ taskId: taskIdArg }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    await requireTask(ctx.orgId, args.taskId);
    const comments = await listComments(ctx.orgId, args.taskId);
    return { taskId: args.taskId, count: comments.length, comments };
  },
});

defineAction({
  name: "task.comment_delete",
  title: "Delete a comment",
  description: "Remove a comment. Its author may always delete it; manager and above may delete anyone's.",
  input: z.object({ commentId: z.number().int().positive().describe("Comment id, from task.comment_list") }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => deleteComment(ctx, args.commentId),
});

/* ─────────────────────────── attachments ─────────────────────────── */

defineAction({
  name: "task.attachment_list",
  title: "List task attachments",
  description:
    "Files attached to one card: filename, MIME type, size in bytes, sha256, who uploaded it, and the URL to download it from (`/api/plan/attachments/:id`). Upload with `PUT /api/plan/tasks/:id/attachments?filename=…`.",
  input: z.object({ taskId: taskIdArg }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    await requireTask(ctx.orgId, args.taskId);
    const attachments = await listAttachments(ctx.orgId, args.taskId);
    return {
      taskId: args.taskId,
      count: attachments.length,
      totalBytes: attachments.reduce((sum, a) => sum + a.sizeBytes, 0),
      attachments,
    };
  },
});

defineAction({
  name: "task.attachment_delete",
  title: "Delete an attachment",
  description:
    "Detach a file from its card. The uploader may always delete it; manager and above may delete anyone's. The stored bytes are removed once no other card in the organization references the same content.",
  input: z.object({ attachmentId: z.number().int().positive().describe("Attachment id, from task.attachment_list") }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    const row = await fetchAttachment(ctx.orgId, args.attachmentId);
    if (!row) throw new ActionError("not_found", `Attachment ${args.attachmentId} not found in this organization`);
    if (row.userId !== ctx.userId && !hasRole(ctx.role, "manager")) {
      throw new ActionError("forbidden", "You may only delete attachments you uploaded — ask a manager to remove someone else's");
    }
    await db.delete(taskAttachments).where(and(eq(taskAttachments.id, row.id), eq(taskAttachments.orgId, ctx.orgId)));
    const blobDeleted = await dropBlobIfUnreferenced(ctx.orgId, row.sha256, row.storageKey);
    await recordEvent({
      taskId: row.taskId,
      orgId: ctx.orgId,
      actor: actorFrom(ctx),
      kind: "updated",
      note: `attachment removed · ${row.filename}`,
      webhookKind: "task.attachment_deleted",
      payload: { attachmentId: row.id, filename: row.filename, sha256: row.sha256 },
    });
    return { deleted: row.id, taskId: row.taskId, filename: row.filename, blobDeleted };
  },
});

/* ─────────────────────────── recurrence ─────────────────────────── */

defineAction({
  name: "task.recur_set",
  title: "Set a task's recurrence",
  description:
    "Turn a card into a template that clones itself into a new backlog card on a schedule, or pass rule: null to stop it. Grammar: `daily`, `weekdays`, `weekly:mon,wed`, `monthly:15`, `every:3d`, `every:2w`, each optionally with `at:09:00`. Times are UTC. The clone copies title, description, stream, app, assignee, estimate, tags, priority inputs and custom values, and takes the external key `<templateKey>-<yyyymmdd>`.",
  input: z.object({
    taskId: taskIdArg,
    rule: z
      .string()
      .max(120)
      .nullable()
      .describe("A rule such as `weekly:mon,wed at:09:00`, or null to clear the recurrence"),
  }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => setRecurrence(ctx, args.taskId, args.rule),
});

defineAction({
  name: "task.recur_list",
  title: "List recurring tasks",
  description: "Every recurrence in the organization with its rule, a human reading of it, when it next fires and when it last did. Soonest first.",
  input: z.object({ includeInactive: z.boolean().optional().describe("Include cleared recurrences (default false)") }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    const recurrences = await listRecurrences(ctx.orgId, args.includeInactive ?? false);
    return { count: recurrences.length, recurrences };
  },
});

/* ─────────────────────────── custom fields ─────────────────────────── */

const optionsArg = z
  .array(z.string().min(1).max(80))
  .optional()
  .describe("Choices for a select or multiselect field; rejected for every other kind");

defineAction({
  name: "field.create",
  title: "Create a custom field",
  description:
    "Define an extra field on every card in the organization. The key every wire shape uses (`custom: { severity: \"high\" }`) is derived from the name once and then fixed, so renaming the field keeps existing payloads working.",
  input: z.object({
    name: z.string().min(1).max(80).describe("Label shown on the card, e.g. \"Customer severity\""),
    kind: z.enum(FIELD_KINDS).describe("What the field holds"),
    options: optionsArg,
    position: z.number().int().min(0).optional().describe("Order in the card's Fields section, ascending"),
  }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => ({
    field: serializeField(await createField(ctx.orgId, { name: args.name, kind: args.kind, options: args.options, position: args.position })),
  }),
});

defineAction({
  name: "field.update",
  title: "Update a custom field",
  description:
    "Rename a field, reorder it, change a select's options or (un)archive it. `kind` is immutable — the values already on cards were validated against it. An option still used by a card cannot be removed.",
  input: z.object({
    fieldId: z.number().int().positive(),
    name: z.string().min(1).max(80).optional(),
    options: optionsArg,
    position: z.number().int().min(0).optional(),
    archived: z.boolean().optional(),
  }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => {
    const { fieldId, ...patch } = args;
    return { field: serializeField(await updateField(ctx.orgId, fieldId, patch)) };
  },
});

defineAction({
  name: "field.list",
  title: "List custom fields",
  description: "Every custom field defined for the organization, in display order, with its key, kind and options.",
  input: z.object({ includeArchived: z.boolean().optional().describe("Include archived fields (default false)") }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    const rows = await listFieldRows(ctx.orgId, args.includeArchived ?? false);
    return { count: rows.length, fields: rows.map(serializeField) };
  },
});

defineAction({
  name: "field.archive",
  title: "Archive a custom field",
  description:
    "Retire a field without losing what cards already recorded in it: the values stay in the database but stop being offered, returned or writable. Pass archived: false to bring it back.",
  input: z.object({ fieldId: z.number().int().positive(), archived: z.boolean().optional().describe("Default true") }),
  requiredRole: "manager",
  surface: "plan",
  handler: async (args, ctx) => ({
    field: serializeField(await updateField(ctx.orgId, args.fieldId, { archived: args.archived ?? true })),
  }),
});

defineAction({
  name: "task.set_custom",
  title: "Set a task's custom fields",
  description:
    "Write custom field values on one card, keyed by field key. Each value is validated against its field's kind (number, date, select, multiselect, checkbox, url, text); null clears one. A member may only write to a card assigned to them; manager and above may write to any card.",
  input: z.object({
    taskId: taskIdArg,
    values: z
      .record(z.unknown())
      .describe("`{ fieldKey: value }`. A select takes one of its options, a multiselect an array of them, a checkbox true/false, a date an ISO day; null clears the value"),
  }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    const task = await requireTask(ctx.orgId, args.taskId);
    if (!hasRole(ctx.role, "manager") && task.assignedTo !== ctx.userId) {
      throw new ActionError("forbidden", "Members may only set custom fields on tasks assigned to themselves — ask a manager, or assign the task to yourself first");
    }
    if (Object.keys(args.values).length === 0) throw new ActionError("invalid", "values is empty — pass at least one field key");

    const { set, cleared } = await setCustomValues(ctx.orgId, args.taskId, args.values);
    const custom = (await customValuesMap(ctx.orgId, [args.taskId])).get(args.taskId) ?? {};
    const touched = [...Object.keys(set), ...cleared];
    if (touched.length > 0) {
      await recordEvent({
        taskId: args.taskId,
        orgId: ctx.orgId,
        actor: actorFrom(ctx),
        kind: "updated",
        note: `custom fields set · ${touched.join(", ")}`,
        webhookKind: "task.custom_set",
        payload: { set, cleared, custom },
      });
    }
    return { taskId: args.taskId, set, cleared, custom };
  },
});

defineAction({
  name: "task.custom_values",
  title: "Custom field values in bulk",
  description:
    "The `custom` bag for many cards at once, as `{ \"<taskId>\": { key: value } }`. What a table with custom-field columns needs — `task.get` per row would be one request per card. Omit taskIds for every card in the organization.",
  input: z.object({
    taskIds: z.array(z.number().int().positive()).max(500).optional().describe("Cards to read (default: all cards in the organization)"),
  }),
  requiredRole: "member",
  surface: "plan",
  handler: async (args, ctx) => {
    const ids = args.taskIds ?? (await fetchOrgTasks(ctx.orgId)).map((t) => t.id);
    const map = await customValuesMap(ctx.orgId, ids);
    const values: Record<string, Record<string, unknown>> = {};
    for (const id of ids) values[String(id)] = map.get(id) ?? {};
    return { count: ids.length, values };
  },
});

/** Re-exported so server/plan/routes.ts can shape an upload response identically to the action. */
export { serializeAttachment };
