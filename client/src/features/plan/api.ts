import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { callAction, getMembers, type MemberRow } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import type { CriticalPathResponse, PlanApp, PlanTask, StreamListResponse, TaskHistoryEvent, TaskTotals } from "./types";

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
