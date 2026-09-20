import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, callAction, getAuthHeader, getMembers, type MemberRow } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import type {
  CriticalPathResponse,
  CustomFieldDef,
  PlanApp,
  PlanTask,
  StreamListResponse,
  TaskAttachment,
  TaskComment,
  TaskHistoryEvent,
  TaskRecurrence,
  TaskTotals,
} from "./types";

/**
 * Data layer for the Plan surface. Everything goes through `callAction` (the
 * same registry endpoint MCP calls) or `api` for the two bespoke plan routes —
 * no bare fetch, so auth and the X-Org-Id header are never forgotten.
 *
 * All query keys start with "plan" so one invalidation after a mutation
 * refreshes the board, the lanes and the app catalogue together.
 */
export const PLAN_KEY = ["plan"] as const;
export const planKeys = {
  tasks: ["plan", "tasks"] as const,
  streams: ["plan", "streams"] as const,
  apps: ["plan", "apps"] as const,
  members: ["plan", "members"] as const,
  criticalPath: ["plan", "criticalPath"] as const,
  history: (taskId: number) => ["plan", "history", taskId] as const,
  totals: (taskId: number) => ["plan", "totals", taskId] as const,
  comments: (taskId: number) => ["plan", "comments", taskId] as const,
  attachments: (taskId: number) => ["plan", "attachments", taskId] as const,
  fields: ["plan", "fields"] as const,
  recurrences: ["plan", "recurrences"] as const,
};

interface TaskListResponse {
  count: number;
  tasks: PlanTask[];
}

/** `app.list` rows carry more than the board needs; only these fields are read. */
type AppListRow = Omit<PlanApp, "streamIds">;

export function usePlanTasks() {
  return useQuery<PlanTask[]>({
    queryKey: planKeys.tasks,
    // The board needs completed cards too — they live in the "done" drawer.
    queryFn: async () => (await callAction<TaskListResponse>("task.list", { includeCompleted: true })).tasks,
  });
}

export function usePlanStreams() {
  return useQuery<StreamListResponse>({
    queryKey: planKeys.streams,
    queryFn: () => callAction<StreamListResponse>("stream.list", {}),
  });
}

/**
 * The org's app catalogue, from the Overview surface's `app.list` (member+).
 * Archived apps are included so a card already filed against one still shows a
 * name; the picker is what hides them from new choices.
 */
export function usePlanApps() {
  return useQuery<PlanApp[]>({
    queryKey: planKeys.apps,
    queryFn: async () => {
      const rows = await callAction<AppListRow[]>("app.list", { includeArchived: true });
      return rows.map((app) => ({ ...app, streams: app.streams ?? [], streamIds: (app.streams ?? []).map((s) => s.id) }));
    },
  });
}

export function usePlanMembers() {
  return useQuery<MemberRow[]>({ queryKey: planKeys.members, queryFn: getMembers });
}

/**
 * The org's critical path and the CPM float of every card, from the server.
 *
 * Deliberately not derived on the client: the Timeline's float numbers, the
 * Cascade graph's red chain and an agent asking `critical_path` over MCP have to
 * be the same numbers. `critical_path` is a manager+ action, so a member gets a
 * 403 — hence `retry: false` and callers that treat "no data" as "no overlay"
 * rather than an error worth shouting about.
 */
export function useCriticalPath(enabled: boolean) {
  return useQuery<CriticalPathResponse>({
    queryKey: planKeys.criticalPath,
    queryFn: () => callAction<CriticalPathResponse>("critical_path", {}),
    enabled,
    retry: false,
    staleTime: 15_000,
  });
}

export function useTaskHistory(taskId: number | null, enabled: boolean) {
  return useQuery<TaskHistoryEvent[]>({
    queryKey: planKeys.history(taskId ?? 0),
    queryFn: async () => (await callAction<{ events: TaskHistoryEvent[] }>("task.history", { taskId, limit: 100 })).events,
    enabled: enabled && !!taskId,
    staleTime: 5_000,
  });
}

/**
 * Logged time for one card. `task.totals` belongs to the Track surface; until
 * that agent lands it the call 404s, which is why the caller renders the error
 * state as "no time logged yet" rather than a failure.
 */
export function useTaskTotals(taskId: number | null, enabled: boolean) {
  return useQuery<TaskTotals>({
    queryKey: planKeys.totals(taskId ?? 0),
    queryFn: () => callAction<TaskTotals>("task.totals", { taskId }),
    enabled: enabled && !!taskId,
    retry: false,
    staleTime: 10_000,
  });
}

/**
 * One mutation per registry action, with the board refreshed and a toast on the
 * way out. `toast` returning null keeps a high-frequency action (bar dragging)
 * quiet.
 */
export function usePlanAction<A extends Record<string, unknown>, R = unknown>(
  name: string,
  opts: { toast?: (result: R, args: A) => string | null; description?: (result: R, args: A) => string | undefined } = {}
) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<R, Error, A>({
    mutationFn: (args: A) => callAction<R>(name, args),
    onSuccess: (result, args) => {
      queryClient.invalidateQueries({ queryKey: PLAN_KEY });
      const title = opts.toast ? opts.toast(result, args) : null;
      if (title) toast({ title, description: opts.description?.(result, args) });
    },
    onError: (error) => {
      toast({ title: `${name} failed`, description: error.message, variant: "destructive" });
    },
  });
}

export interface TaskMutationResult {
  task: PlanTask;
  cascaded?: number[];
  changed?: boolean;
}

/** The handful of task mutations every view needs, wired once. */
export function useTaskMutations() {
  const cascadeNote = (result: TaskMutationResult) =>
    result.cascaded && result.cascaded.length ? `${result.cascaded.length} dependent card(s) shifted` : undefined;
  return {
    create: usePlanAction<Record<string, unknown>, TaskMutationResult>("task.create", {
      toast: () => "Card drafted",
      description: cascadeNote,
    }),
    update: usePlanAction<Record<string, unknown>, TaskMutationResult>("task.update", {
      toast: () => "Saved",
      description: cascadeNote,
    }),
    schedule: usePlanAction<Record<string, unknown>, TaskMutationResult>("task.schedule", {
      toast: () => "Scheduled",
      description: cascadeNote,
    }),
    unschedule: usePlanAction<Record<string, unknown>, TaskMutationResult>("task.unschedule", {
      toast: () => "Back in the backlog",
    }),
    complete: usePlanAction<Record<string, unknown>, TaskMutationResult>("task.complete", {
      toast: () => "Struck off the board",
    }),
    remove: usePlanAction<Record<string, unknown>, { deleted: number }>("task.delete", { toast: () => "Card deleted" }),
    setPriority: usePlanAction<Record<string, unknown>, TaskMutationResult>("task.set_priority", { toast: () => "Priority updated" }),
    /** Silent: the timeline drag already shows the outcome, a toast per drag is noise. */
    drag: usePlanAction<Record<string, unknown>, TaskMutationResult>("task.update", { toast: () => null }),
  };
}

export function useStreamMutations() {
  return {
    create: usePlanAction<Record<string, unknown>, unknown>("stream.create", { toast: () => "Stream opened" }),
    rename: usePlanAction<Record<string, unknown>, unknown>("stream.rename", { toast: () => "Stream renamed" }),
    update: usePlanAction<Record<string, unknown>, unknown>("stream.update", { toast: () => "Stream updated" }),
    moveTasks: usePlanAction<Record<string, unknown>, unknown>("stream.move_tasks", { toast: () => "Cards moved" }),
  };
}

/* ───────────────────── workflow depth: comments, files, fields, recurrence ───────────────────── */

/** A card's discussion, oldest first. */
export function useTaskComments(taskId: number | null, enabled: boolean) {
  return useQuery<TaskComment[]>({
    queryKey: planKeys.comments(taskId ?? 0),
    queryFn: async () => (await callAction<{ comments: TaskComment[] }>("task.comment_list", { taskId })).comments,
    enabled: enabled && !!taskId,
    staleTime: 5_000,
  });
}

/**
 * Comment writes invalidate the card's comments AND its history, because
 * `task.comment_add` also writes an `updated` history row noted "commented".
 */
export function useCommentMutations(taskId: number | null) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = () => {
    if (taskId) {
      queryClient.invalidateQueries({ queryKey: planKeys.comments(taskId) });
      queryClient.invalidateQueries({ queryKey: planKeys.history(taskId) });
    }
  };
  const onError = (error: Error, what: string) => toast({ title: `Could not ${what}`, description: error.message, variant: "destructive" });
  return {
    add: useMutation<{ comment: TaskComment }, Error, { body: string }>({
      mutationFn: (args) => callAction("task.comment_add", { taskId, body: args.body }),
      onSuccess: invalidate,
      onError: (error) => onError(error, "post the comment"),
    }),
    remove: useMutation<{ deleted: number }, Error, { commentId: number }>({
      mutationFn: (args) => callAction("task.comment_delete", args),
      onSuccess: invalidate,
      onError: (error) => onError(error, "delete the comment"),
    }),
  };
}

export function useTaskAttachments(taskId: number | null, enabled: boolean) {
  return useQuery<TaskAttachment[]>({
    queryKey: planKeys.attachments(taskId ?? 0),
    queryFn: async () => (await callAction<{ attachments: TaskAttachment[] }>("task.attachment_list", { taskId })).attachments,
    enabled: enabled && !!taskId,
    staleTime: 5_000,
  });
}

/**
 * Upload one file. Not `api()`: the body is raw bytes, so the JSON Content-Type
 * that helper sets would be a lie — and `express.json` upstream would eat a
 * `.json` file before the route saw it, which is why the request always declares
 * `application/octet-stream` and lets the server read the type from the name.
 */
export async function uploadAttachment(taskId: number, file: File): Promise<{ attachment: TaskAttachment }> {
  const headers = getAuthHeader();
  delete headers["Content-Type"];
  const declared = file.type && !/^(application\/json|application\/x-www-form-urlencoded|multipart\/)/i.test(file.type) ? file.type : "application/octet-stream";
  const res = await fetch(`/api/plan/tasks/${taskId}/attachments?filename=${encodeURIComponent(file.name)}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": declared },
    body: file,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.message || body.error || message;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as { attachment: TaskAttachment };
}

/**
 * Fetch the bytes with the caller's credentials, then hand them to the browser.
 *
 * A plain `<a href>` cannot work: the download route is authenticated by the
 * bearer token in localStorage, not by a cookie, so the link would 401.
 */
export async function openAttachment(attachment: TaskAttachment, mode: "open" | "download" = "download"): Promise<void> {
  const headers = getAuthHeader();
  delete headers["Content-Type"];
  const res = await fetch(attachment.url, { headers });
  if (!res.ok) throw new ApiError(res.status, `Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  try {
    if (mode === "open" && attachment.inline) {
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } finally {
    // Long enough for the navigation/download to start, short enough not to leak.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export function useAttachmentMutations(taskId: number | null) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = () => {
    if (taskId) {
      queryClient.invalidateQueries({ queryKey: planKeys.attachments(taskId) });
      queryClient.invalidateQueries({ queryKey: planKeys.history(taskId) });
    }
  };
  return {
    upload: useMutation<{ attachment: TaskAttachment }, Error, { file: File }>({
      mutationFn: ({ file }) => uploadAttachment(taskId!, file),
      onSuccess: invalidate,
      onError: (error) => toast({ title: "Upload failed", description: error.message, variant: "destructive" }),
    }),
    remove: useMutation<{ deleted: number }, Error, { attachmentId: number }>({
      mutationFn: (args) => callAction("task.attachment_delete", args),
      onSuccess: invalidate,
      onError: (error) => toast({ title: "Could not delete the file", description: error.message, variant: "destructive" }),
    }),
  };
}

/** The org's custom field definitions. `field.list` is member+, so this never 403s. */
export function useCustomFields(enabled = true) {
  return useQuery<CustomFieldDef[]>({
    queryKey: planKeys.fields,
    queryFn: async () => (await callAction<{ fields: CustomFieldDef[] }>("field.list", {})).fields,
    enabled,
    staleTime: 60_000,
  });
}

export function useFieldMutations() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: planKeys.fields });
    queryClient.invalidateQueries({ queryKey: planKeys.tasks });
  };
  return {
    create: useMutation<{ field: CustomFieldDef }, Error, { name: string; kind: string; options?: string[] }>({
      mutationFn: (args) => callAction("field.create", args),
      onSuccess: () => {
        invalidate();
        toast({ title: "Field added" });
      },
      onError: (error) => toast({ title: "Could not add the field", description: error.message, variant: "destructive" }),
    }),
    archive: useMutation<{ field: CustomFieldDef }, Error, { fieldId: number; archived?: boolean }>({
      mutationFn: (args) => callAction("field.archive", args),
      onSuccess: () => {
        invalidate();
        toast({ title: "Field archived" });
      },
      onError: (error) => toast({ title: "Could not archive the field", description: error.message, variant: "destructive" }),
    }),
  };
}

/**
 * Writing custom values refreshes the board: `custom` rides along on `task.list`.
 * The card id is a mutation argument rather than a hook argument because the
 * dialog also uses this right after creating a card, when it did not have one.
 */
export function useSetCustom() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<{ custom: Record<string, unknown> }, Error, { taskId: number; values: Record<string, unknown> }>({
    mutationFn: (args) => callAction("task.set_custom", { taskId: args.taskId, values: args.values }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PLAN_KEY });
    },
    onError: (error) => toast({ title: "Could not save the fields", description: error.message, variant: "destructive" }),
  });
}

/** Every active recurrence in the org; the dialog picks out the one for its card. */
export function useRecurrences(enabled: boolean) {
  return useQuery<TaskRecurrence[]>({
    queryKey: planKeys.recurrences,
    queryFn: async () => (await callAction<{ recurrences: TaskRecurrence[] }>("task.recur_list", {})).recurrences,
    enabled,
    staleTime: 30_000,
  });
}

export function useRecurrenceMutation() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<{ recurrence: TaskRecurrence | null; cleared: boolean }, Error, { taskId: number; rule: string | null }>({
    mutationFn: (args) => callAction("task.recur_set", args),
    onSuccess: (result, args) => {
      queryClient.invalidateQueries({ queryKey: planKeys.recurrences });
      queryClient.invalidateQueries({ queryKey: planKeys.history(args.taskId) });
      toast({
        title: result.cleared ? "Recurrence cleared" : "Recurrence set",
        description: result.cleared ? undefined : result.recurrence?.preview,
      });
    },
    onError: (error) => toast({ title: "Could not set the recurrence", description: error.message, variant: "destructive" }),
  });
}
