import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, Bot, Loader2, Search, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { fetchApps, fetchNextTask, fetchStreams, fetchTasks } from "./api";
import { bandChipClass, bandTextClass, formatDay, isOverdue, STATUS_LABEL, statusChipClass } from "./format";
import TaskDrawer from "./TaskDrawer";
import type { NextTaskResult, TaskFilters, TaskRow, TaskSort } from "./types";
import { TASK_STATUSES } from "../../../../db/schema";

const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_ORDER: Record<TaskSort, "asc" | "desc"> = { priority: "desc", updated: "desc", due: "asc", title: "asc" };

const COLUMNS: { key: TaskSort | null; label: string; className?: string }[] = [
  { key: "priority", label: "P", className: "w-[54px]" },
  { key: null, label: "status", className: "w-[104px] hidden sm:table-cell" },
  { key: "title", label: "title" },
  { key: null, label: "stream", className: "w-[150px] hidden md:table-cell" },
  { key: null, label: "app", className: "w-[86px] hidden lg:table-cell" },
  { key: null, label: "assignee", className: "w-[150px] hidden lg:table-cell" },
  { key: "due", label: "due", className: "w-[86px]" },
];

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A plain <select> dressed as a ledger field — no popover, so the filter bar stays one row. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="eyebrow text-[9px]">{label}</span>
      {children}
    </label>
  );
}

const selectClass = "draft-input h-9 py-0 text-sm w-full appearance-none bg-parchment pr-6 focus-ink";

export default function BacklogTab() {
  const { toast } = useToast();
  // Deep links from the Systemic and Apps tabs land here pre-filtered.
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [streamId, setStreamId] = useState<string>(params.get("streamId") ?? "");
  const [appId, setAppId] = useState<string>(params.get("appId") ?? "");
  const [status, setStatus] = useState<string>("");
  const [priorityMin, setPriorityMin] = useState<string>("");
  const [effortMax, setEffortMax] = useState<string>("");
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [sort, setSort] = useState<TaskSort>("priority");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [pageSize, setPageSize] = useState<number>(25);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<TaskRow | null>(null);
  const [why, setWhy] = useState<NextTaskResult["why"]>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pickingNext, setPickingNext] = useState(false);

  const debouncedSearch = useDebounced(search);

  // Consume the deep-link params once so a later filter change is not undone by them.
  useEffect(() => {
    if (params.get("appId") === null && params.get("streamId") === null && params.get("search") === null) return;
    const next = new URLSearchParams(params);
    next.delete("appId");
    next.delete("streamId");
    next.delete("search");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apps = useQuery({ queryKey: ["/api/actions/app.list"], queryFn: () => fetchApps(false) });
  // stream.list belongs to the Plan surface; an empty list just means "all streams".
  const streams = useQuery({ queryKey: ["/api/actions/stream.list"], queryFn: fetchStreams, retry: false });

  const filters: TaskFilters = useMemo(
    () => ({
      search: debouncedSearch.trim() || undefined,
      streamId: streamId ? Number(streamId) : undefined,
      appId: appId ? Number(appId) : undefined,
      status: status ? [status as (typeof TASK_STATUSES)[number]] : undefined,
      priorityMin: priorityMin !== "" ? Number(priorityMin) : undefined,
      effortMax: effortMax !== "" ? Number(effortMax) : undefined,
      includeCompleted: includeCompleted || undefined,
      sort,
      order,
      limit: pageSize,
      offset: page * pageSize,
    }),
    [debouncedSearch, streamId, appId, status, priorityMin, effortMax, includeCompleted, sort, order, pageSize, page],
  );

  const tasks = useQuery({ queryKey: ["/api/tasks/query", filters], queryFn: () => fetchTasks(filters) });

  // Changing any filter invalidates the offset; clamp back rather than show an empty page.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, streamId, appId, status, priorityMin, effortMax, includeCompleted, pageSize, sort, order]);

  const total = tasks.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (page > 0 && page >= pages) setPage(pages - 1);
  }, [page, pages]);

  const onSort = (key: TaskSort) => {
    if (sort === key) setOrder((o) => (o === "desc" ? "asc" : "desc"));
    else {
      setSort(key);
      setOrder(DEFAULT_ORDER[key]);
    }
  };

  const openTask = (t: TaskRow, w: NextTaskResult["why"] = null) => {
    setSelected(t);
    setWhy(w);
    setDrawerOpen(true);
  };

  const pickNext = async () => {
    setPickingNext(true);
    try {
      const res = await fetchNextTask({
        streamId: streamId ? Number(streamId) : undefined,
        appId: appId ? Number(appId) : undefined,
      });
      if (!res.task) toast({ title: "Nothing left to start", description: "No backlog or triaged task matches the current stream/app filter." });
      else openTask(res.task, res.why);
    } catch (err) {
      toast({ title: "Could not pick a task", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setPickingNext(false);
    }
  };

  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="space-y-4">
      {/* ---------- filter bar ---------- */}
      <div className="paper-flat p-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2.5">
          <div className="col-span-2 sm:col-span-3 lg:col-span-2">
            <Field label="search">
              <span className="relative block">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="title or description…"
                  className="draft-input h-9 py-0 text-sm w-full pl-8 focus-ink"
                  data-testid="filter-search"
                />
              </span>
            </Field>
          </div>
          <Field label="stream">
            <select value={streamId} onChange={(e) => setStreamId(e.target.value)} className={selectClass} data-testid="filter-stream">
              <option value="">all streams</option>
              {(Array.isArray(streams.data) ? streams.data : []).filter((s) => !s.archived).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="app">
            <select value={appId} onChange={(e) => setAppId(e.target.value)} className={selectClass} data-testid="filter-app">
              <option value="">all apps</option>
              {(Array.isArray(apps.data) ? apps.data : []).map((a) => (
                <option key={a.id} value={a.id}>{a.key}</option>
              ))}
            </select>
          </Field>
          <Field label="status">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass} data-testid="filter-status">
              <option value="">open only</option>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
              ))}
            </select>
          </Field>
          <Field label="P ≥">
            <input type="number" min={0} max={100} value={priorityMin} onChange={(e) => setPriorityMin(e.target.value)} className="draft-input h-9 py-0 text-sm w-full font-numeric focus-ink" data-testid="filter-pmin" />
          </Field>
          <Field label="effort ≤">
            <input type="number" min={0} max={10} value={effortMax} onChange={(e) => setEffortMax(e.target.value)} className="draft-input h-9 py-0 text-sm w-full font-numeric focus-ink" data-testid="filter-emax" />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 pt-3 border-t border-rule">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={includeCompleted} onChange={(e) => setIncludeCompleted(e.target.checked)} className="accent-vermilion" data-testid="filter-completed" />
            <span className="eyebrow text-[9px]">include completed</span>
          </label>
          <button
            onClick={pickNext}
            disabled={pickingNext}
            className="inline-flex items-center gap-2 px-3 py-1.5 border border-vermilion/60 text-vermilion hover:bg-vermilion hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
            data-testid="next-task-button"
          >
            {pickingNext ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
            <span className="eyebrow text-[10px] !text-current">next task</span>
          </button>
          <span className="eyebrow text-[10px] ml-auto font-numeric" data-testid="result-count">
            {tasks.isFetching ? "…" : `${total} task${total === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>

      {/* ---------- table ---------- */}
      <div className="paper-flat overflow-x-auto nice-scroll">
        <table className="w-full text-sm" data-testid="backlog-table">
          <thead>
            <tr className="border-b border-ink/70">
              {COLUMNS.map((c) => (
                <th key={c.label} className={cn("text-left px-3 py-2 font-normal", c.className)}>
                  {c.key ? (
                    <button onClick={() => onSort(c.key!)} className="eyebrow text-[9px] inline-flex items-center gap-1 hover:text-ink focus-ink rounded-sm" data-testid={`sort-${c.key}`}>
                      {c.label}
                      {sort === c.key ? (order === "desc" ? <ArrowDown className="h-3 w-3 text-vermilion" /> : <ArrowUp className="h-3 w-3 text-vermilion" />) : null}
                    </button>
                  ) : (
                    <span className="eyebrow text-[9px]">{c.label}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.isLoading ? (
              <tr><td colSpan={COLUMNS.length} className="px-3 py-10 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></td></tr>
            ) : tasks.error ? (
              <tr><td colSpan={COLUMNS.length} className="px-3 py-10 text-center font-serif italic text-vermilion">{(tasks.error as Error).message}</td></tr>
            ) : (tasks.data?.items.length ?? 0) === 0 ? (
              <tr><td colSpan={COLUMNS.length} className="px-3 py-10 text-center font-serif italic text-ink-muted">Nothing matches these filters.</td></tr>
            ) : (
              tasks.data!.items.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => openTask(t)}
                  className="border-b border-rule last:border-0 hover:bg-parchment-deep/60 cursor-pointer align-top"
                  data-testid={`task-row-${t.id}`}
                >
                  <td className="px-3 py-2">
                    <span className={cn("font-numeric text-base font-medium", bandTextClass(t.priorityScore))} data-testid={`task-score-${t.id}`}>
                      {t.priorityScore}
                    </span>
                  </td>
                  <td className="px-3 py-2 hidden sm:table-cell">
                    <span className={cn("stamp", statusChipClass(t.status))}>{STATUS_LABEL[t.status] ?? t.status}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-serif">{t.title}</span>
                    <span className="flex flex-wrap items-center gap-1.5 mt-1 sm:hidden">
                      <span className={cn("stamp", statusChipClass(t.status))}>{STATUS_LABEL[t.status] ?? t.status}</span>
                      {t.streamName ? <span className="eyebrow text-[9px]">{t.streamName}</span> : null}
                    </span>
                  </td>
                  <td className="px-3 py-2 hidden md:table-cell">
                    {t.streamName ? (
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: t.streamColor ?? "hsl(var(--ink-muted))" }} />
                        <span className="truncate">{t.streamName}</span>
                      </span>
                    ) : (
                      <span className="text-ink-muted text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 hidden lg:table-cell">
                    {t.appKey ? <span className="font-mono text-xs">{t.appKey}</span> : <span className="text-ink-muted text-xs">—</span>}
                  </td>
                  <td className="px-3 py-2 hidden lg:table-cell">
                    {t.assigneeName ? (
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <span className="truncate">{t.assigneeName}</span>
                        {t.assigneeIsAgent ? (
                          <span className="stamp inline-flex items-center gap-0.5 border-ink/50 shrink-0" data-testid={`agent-badge-${t.id}`}>
                            <Bot className="h-2.5 w-2.5" /> agent
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-ink-muted text-xs">unassigned</span>
                    )}
                  </td>
                  <td className={cn("px-3 py-2 font-numeric text-xs whitespace-nowrap", isOverdue(t.dueDate, t.status) ? "text-vermilion" : "text-ink-muted")}>
                    {formatDay(t.dueDate) || "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ---------- pager ---------- */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <span className="eyebrow text-[10px] font-numeric" data-testid="pager-info">
          {from}–{to} of {total} · page {page + 1}/{pages}
        </span>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setPage(0)} disabled={page <= 0} className="stamp disabled:opacity-40 focus-ink" data-testid="page-first">«</button>
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page <= 0} className="stamp disabled:opacity-40 focus-ink" data-testid="page-prev">prev</button>
          <button onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page + 1 >= pages} className="stamp disabled:opacity-40 focus-ink" data-testid="page-next">next</button>
          <button onClick={() => setPage(pages - 1)} disabled={page + 1 >= pages} className="stamp disabled:opacity-40 focus-ink" data-testid="page-last">»</button>
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="draft-input h-7 py-0 text-xs font-numeric ml-2 focus-ink" data-testid="page-size">
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n} / page</option>
            ))}
          </select>
        </div>
      </div>

      <TaskDrawer task={selected} why={why} open={drawerOpen} onOpenChange={setDrawerOpen} />
    </div>
  );
}
