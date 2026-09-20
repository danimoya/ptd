/**
 * Task references.
 *
 * Every sugar command takes a `<KEY|id>`. A bare number is an id; anything else
 * is looked up as a task's `externalKey` through `task.list`, which is the only
 * lookup the server offers for it — the list already carries every card in the
 * organization, so one call answers both the exact and the case-insensitive match.
 */
import { callAction, type Client } from "./api.ts";
import { CliError } from "./errors.ts";

export interface TaskBrief {
  id: number;
  title?: string;
  externalKey?: string | null;
  status?: string;
  priorityScore?: number;
  [key: string]: unknown;
}

type Caller = (client: Client, name: string, args?: unknown) => Promise<unknown>;

export function isTaskId(ref: string): boolean {
  return /^\d+$/.test(ref);
}

/** The full card, resolved from an id or an external key. */
export async function resolveTask(client: Client, ref: string, call: Caller = callAction): Promise<TaskBrief> {
  if (ref === undefined || ref === "") throw new CliError("Name a task by its key (SEC-3) or id (3).");
  const tasks = await listTasks(client, call);

  if (isTaskId(ref)) {
    const id = Number(ref);
    const byId = tasks.find((t) => t.id === id);
    if (byId) return byId;
    // The id may be real but outside what task.list returns; let the action itself say so.
    return { id };
  }

  const exact = tasks.filter((t) => t.externalKey === ref);
  if (exact.length === 1) return exact[0];
  const lower = ref.toLowerCase();
  const loose = tasks.filter((t) => (t.externalKey ?? "").toLowerCase() === lower);
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) {
    throw new CliError(`"${ref}" matches ${loose.length} tasks (ids ${loose.map((t) => t.id).join(", ")}) — use the id.`);
  }

  const known = tasks
    .map((t) => t.externalKey)
    .filter((k): k is string => typeof k === "string" && k !== "")
    .slice(0, 8);
  const hint = known.length ? ` Known keys include: ${known.join(", ")}.` : "";
  throw new CliError(`No task with external key "${ref}" in this organization.${hint}`);
}

export async function resolveTaskId(client: Client, ref: string, call: Caller = callAction): Promise<number> {
  return (await resolveTask(client, ref, call)).id;
}

/** `task.list` including completed cards, so `ptd done` and `ptd log` can name one. */
export async function listTasks(client: Client, call: Caller = callAction, args: Record<string, unknown> = {}): Promise<TaskBrief[]> {
  const result = (await call(client, "task.list", { includeCompleted: true, ...args })) as { tasks?: unknown } | null;
  const tasks = result && Array.isArray(result.tasks) ? result.tasks : [];
  return tasks.filter((t): t is TaskBrief => Boolean(t) && typeof t === "object" && typeof (t as TaskBrief).id === "number");
}

/** `SEC-3 · Add CSRF tokens` — how a card is named in one line of output. */
export function label(task: TaskBrief | null | undefined): string {
  if (!task) return "(no task)";
  const key = task.externalKey ? `${task.externalKey} · ` : "";
  return `${key}#${task.id}${task.title ? ` ${task.title}` : ""}`;
}
