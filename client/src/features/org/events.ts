/**
 * The event kinds the Plan surface emits, as published by its task-event writer.
 * Used to populate the webhook subscription field so an admin picks a real kind
 * instead of typing one that will never match. Kept as a hint, not a validator:
 * the server accepts any string, so a kind added later still works before this
 * list catches up.
 */

export interface EventGroup { label: string; note: string; kinds: string[] }

export const TASK_EVENTS = [
  "task.created",
  "task.updated",
  "task.completed",
  "task.assigned",
  "task.priority_changed",
  "task.scheduled",
  "task.unscheduled",
  "task.cascade_shifted",
  "task.stream_moved",
  "task.deleted",
] as const;

export const STREAM_EVENTS = [
  "stream.created",
  "stream.updated",
  "stream.renamed",
  "stream.tasks_moved",
  "stream.app_attached",
  "stream.app_detached",
] as const;

export const EVENT_GROUPS: EventGroup[] = [
  {
    label: "Task",
    note: "Carries taskId plus a per-field {old,new} diff in payload.changes. task.deleted fires before the row is removed, so the delivery is the only surviving record of it.",
    kinds: [...TASK_EVENTS],
  },
  {
    label: "Stream",
    note: "No taskId — these describe the lane itself, not a task in it.",
    kinds: [...STREAM_EVENTS],
  },
  {
    label: "Other",
    note: "ping is what the Test button sends.",
    kinds: ["ping"],
  },
];

export const ALL_EVENT_KINDS: string[] = EVENT_GROUPS.flatMap((g) => g.kinds);

/** Split the comma-separated field into kinds, trimmed and de-duplicated in order. */
export function parseEvents(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const kind = part.trim();
    if (kind) seen.add(kind);
  }
  return [...seen];
}

/** Kinds a user typed that no surface is known to emit — worth warning about, not blocking. */
export function unknownEvents(raw: string): string[] {
  return parseEvents(raw).filter((k) => k !== "*" && !ALL_EVENT_KINDS.includes(k));
}
