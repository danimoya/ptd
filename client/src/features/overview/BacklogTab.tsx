import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, Bot, Check, Columns3, Loader2, Search, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { callAction } from "@/lib/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { fetchApps, fetchNextTask, fetchStreams, fetchTasks } from "./api";
import { bandChipClass, bandTextClass, formatDay, isOverdue, prioritySourceChipClass, prioritySourceLabel, prioritySourceTitle, STATUS_LABEL, statusChipClass } from "./format";
import TaskDrawer from "./TaskDrawer";
import AiBatchDialog from "./ai/AiBatchDialog";
import type { NextTaskResult, TaskFilters, TaskRow, TaskSort } from "./types";
// The Plan surface owns custom fields; the Backlog table only reads them.
import type { CustomFieldDef } from "../plan/types";
import { TASK_STATUSES } from "../../../../db/schema";

const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_ORDER: Record<TaskSort, "asc" | "desc"> = { priority: "desc", updated: "desc", due: "asc", title: "asc" };

/**
 * The table's columns.
 *
 * `priority` and `title` are fixed — a ledger row with neither is not a row —
 * and everything else, including one column per custom field, can be toggled in
 * the column picker. The choice is remembered per browser.
 */
type ColumnId = "priority" | "status" | "title" | "stream" | "app" | "assignee" | "due";

interface BaseColumn {
  id: ColumnId;
  label: string;
  sort: TaskSort | null;
  /** Width and breakpoint on the header cell. */
  headClass?: string;
  /** The same breakpoint on the body cell — both halves of a column hide together. */
  cellClass?: string;
  fixed?: boolean;
}

const BASE_COLUMNS: BaseColumn[] = [
  { id: "priority", label: "P", sort: "priority", headClass: "w-[54px]", fixed: true },
  { id: "status", label: "status", sort: null, headClass: "w-[104px] hidden sm:table-cell", cellClass: "hidden sm:table-cell" },
  { id: "title", label: "title", sort: "title", fixed: true },
  { id: "stream", label: "stream", sort: null, headClass: "w-[150px] hidden md:table-cell", cellClass: "hidden md:table-cell" },
  { id: "app", label: "app", sort: null, headClass: "w-[86px] hidden lg:table-cell", cellClass: "hidden lg:table-cell" },
  { id: "assignee", label: "assignee", sort: null, headClass: "w-[150px] hidden lg:table-cell", cellClass: "hidden lg:table-cell" },
  { id: "due", label: "due", sort: "due", headClass: "w-[86px]" },
];

const DEFAULT_VISIBLE: string[] = BASE_COLUMNS.map((c) => c.id);
const COLUMNS_STORAGE_KEY = "ptd.overview.backlog.columns";
/** A custom field's column id: `cf:severity`. */
const customColumnId = (key: string) => `cf:${key}`;

/**
 * Remembered column choice. Stored as one comma-joined string and read back
 * defensively: localStorage throws in a private window and is stubbed in tests,
 * and a column preference is never worth taking the table down for.
 */
function loadColumns(): string[] {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    const list = (raw ?? "").split(",").filter(Boolean);
    return list.length > 0 ? list : DEFAULT_VISIBLE;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

function saveColumns(ids: string[]): void {
  try {
    localStorage.setItem(COLUMNS_STORAGE_KEY, ids.join(","));
  } catch {
    /* preference is best-effort */
  }
}

/** One custom value as a table cell: arrays as a list, booleans as yes/no, nothing as a dash. */
function formatCustom(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  return String(value);
}

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
  const queryClient = useQueryClient();
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
  const [visibleColumns, setVisibleColumns] = useState<string[]>(loadColumns);

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
      streamId: streamId === "none" ? "none" : streamId ? Number(streamId) : undefined,
      appId: appId === "none" ? "none" : appId ? Number(appId) : undefined,
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

  // ── custom fields ──
  // `field.list` is member+, so this never 403s; an org with no fields just gets
  // an empty picker section.
  const fields = useQuery<CustomFieldDef[]>({
    queryKey: ["/api/actions/field.list"],
    queryFn: async () => (await callAction<{ fields: CustomFieldDef[] }>("field.list", {})).fields,
    staleTime: 60_000,
    retry: false,
  });
  const fieldList = useMemo(() => fields.data ?? [], [fields.data]);
  const shownFields = useMemo(() => fieldList.filter((f) => visibleColumns.includes(customColumnId(f.key))), [fieldList, visibleColumns]);
  const pageIds = useMemo(() => (tasks.data?.items ?? []).map((t) => t.id), [tasks.data]);
  /**
   * Values for the rows on screen only, in one request — `tasks.query` belongs to
   * the Overview surface and does not carry them, and `task.get` per row would be
   * one request per card. Filtering the table BY a custom field is out of scope
   * for now: that needs `tasks.query` itself to learn about them.
   */
  const customValues = useQuery<Record<string, Record<string, unknown>>>({
    queryKey: ["/api/actions/task.custom_values", pageIds],
    queryFn: async () =>
      (await callAction<{ values: Record<string, Record<string, unknown>> }>("task.custom_values", { taskIds: pageIds })).values,
    enabled: shownFields.length > 0 && pageIds.length > 0,
    staleTime: 10_000,
    retry: false,
  });

  const toggleColumn = (id: string) => {
    setVisibleColumns((prev) => {
      const next = prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id];
      saveColumns(next);
      return next;
    });
  };

  /** Header + cell for every visible column, base ones in their fixed order then the custom fields. */
  const columns = useMemo(() => {
    const base = BASE_COLUMNS.filter((c) => c.fixed || visibleColumns.includes(c.id)).map((c) => ({
      key: c.id as string,
      label: c.label,
      sort: c.sort,
      headClass: c.headClass,
      cellClass: c.cellClass,
      field: null as CustomFieldDef | null,
    }));
    const custom = shownFields.map((f) => ({
      key: customColumnId(f.key),
      label: f.name,
      sort: null as TaskSort | null,
      headClass: "w-[130px] hidden md:table-cell",
      cellClass: "hidden md:table-cell font-mono text-xs",
      field: f,
    }));
    return [...base, ...custom];
  }, [visibleColumns, shownFields]);

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

  /**
   * An accepted AI suggestion changed the row under us: patch the open drawer so
   * it stops showing the old score, and let the table refetch so the row's
   * position and its "AI" glyph catch up.
   */
  const refreshTasks = () => queryClient.invalidateQueries({ queryKey: ["/api/tasks/query"] });
  const onTaskUpdated = (patch: Partial<TaskRow>) => {
    setSelected((prev) => (prev ? { ...prev, ...patch } : prev));
    void refreshTasks();
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
        streamId: streamId && streamId !== "none" ? Number(streamId) : undefined,
        appId: appId && appId !== "none" ? Number(appId) : undefined,
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
              <option value="none">— no stream —</option>
              {(Array.isArray(streams.data) ? streams.data : []).filter((s) => !s.archived).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="app">
            <select value={appId} onChange={(e) => setAppId(e.target.value)} className={selectClass} data-testid="filter-app">
              <option value="">all apps</option>
              <option value="none">— no app —</option>
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
          <AiBatchDialog
            streams={Array.isArray(streams.data) ? streams.data : []}
            apps={Array.isArray(apps.data) ? apps.data : []}
            defaultStreamId={streamId && streamId !== "none" ? Number(streamId) : undefined}
            defaultAppId={appId && appId !== "none" ? Number(appId) : undefined}
            onApplied={() => {
              void refreshTasks();
              toast({ title: "Priorities updated", description: "The suggestions the batch wrote are on the cards now." });
            }}
          />
          {/* ── column picker: base columns plus one entry per custom field ── */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="inline-flex items-center gap-2 px-3 py-1.5 border border-rule hover:border-ink transition-colors rounded-sm focus-ink"
                data-testid="column-picker"
              >
                <Columns3 className="h-3.5 w-3.5" />
                <span className="eyebrow text-[10px] !text-current">columns</span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0 border-rule">
              <div className="px-3 py-2 border-b border-rule">
                <span className="eyebrow text-[9px]">Table columns</span>
              </div>
              <div className="max-h-72 overflow-auto nice-scroll py-1">
                {BASE_COLUMNS.map((c) => (
                  <ColumnToggle
                    key={c.id}
                    label={c.label}
                    checked={c.fixed || visibleColumns.includes(c.id)}
                    disabled={c.fixed}
                    hint={c.fixed ? "always" : undefined}
                    onToggle={() => toggleColumn(c.id)}
                  />
                ))}
                <div className="mt-1 px-3 pt-2 pb-1 border-t border-rule">
                  <span className="eyebrow text-[9px]">Custom fields</span>
                </div>
                {fieldList.length === 0 ? (
                  <p className="px-3 pb-2 font-serif text-xs italic text-ink-muted">
                    None defined. A manager adds them on a card, in the Plan surface.
                  </p>
                ) : (
                  fieldList.map((f) => (
                    <ColumnToggle
                      key={f.id}
                      label={f.name}
                      hint={f.kind}
                      checked={visibleColumns.includes(customColumnId(f.key))}
                      onToggle={() => toggleColumn(customColumnId(f.key))}
                      testId={`column-toggle-${f.key}`}
                    />
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>
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
              {columns.map((c) => (
                <th key={c.key} className={cn("text-left px-3 py-2 font-normal", c.headClass)}>
                  {c.sort ? (
                    <button onClick={() => onSort(c.sort!)} className="eyebrow text-[9px] inline-flex items-center gap-1 hover:text-ink focus-ink rounded-sm" data-testid={`sort-${c.sort}`}>
                      {c.label}
                      {sort === c.sort ? (order === "desc" ? <ArrowDown className="h-3 w-3 text-vermilion" /> : <ArrowUp className="h-3 w-3 text-vermilion" />) : null}
                    </button>
                  ) : (
                    <span className="eyebrow text-[9px]" title={c.field ? `custom field · ${c.field.key} (${c.field.kind})` : undefined}>
                      {c.label}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.isLoading ? (
              <tr><td colSpan={columns.length} className="px-3 py-10 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></td></tr>
            ) : tasks.error ? (
              <tr><td colSpan={columns.length} className="px-3 py-10 text-center font-serif italic text-vermilion">{(tasks.error as Error).message}</td></tr>
            ) : (tasks.data?.items.length ?? 0) === 0 ? (
              <tr><td colSpan={columns.length} className="px-3 py-10 text-center font-serif italic text-ink-muted">Nothing matches these filters.</td></tr>
            ) : (
              tasks.data!.items.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => openTask(t)}
                  className="border-b border-rule last:border-0 hover:bg-parchment-deep/60 cursor-pointer align-top"
                  data-testid={`task-row-${t.id}`}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        "px-3 py-2",
                        c.cellClass,
                        c.key === "due" && cn("font-numeric text-xs whitespace-nowrap", isOverdue(t.dueDate, t.status) ? "text-vermilion" : "text-ink-muted"),
                      )}
                      data-testid={c.field ? `custom-cell-${c.field.key}-${t.id}` : undefined}
                    >
                      {c.field ? (
                        <span className={cn(formatCustom(customValues.data?.[String(t.id)]?.[c.field.key]) === "—" && "text-ink-muted")}>
                          {formatCustom(customValues.data?.[String(t.id)]?.[c.field.key])}
                        </span>
                      ) : c.key === "priority" ? (
                        <>
                          <span className={cn("font-numeric text-base font-medium", bandTextClass(t.priorityScore))} data-testid={`task-score-${t.id}`}>
                            {t.priorityScore}
                          </span>
                          {prioritySourceLabel(t.prioritySource) ? (
                            <span
                              className={cn("stamp block mt-0.5 w-fit", prioritySourceChipClass(t.prioritySource))}
                              title={prioritySourceTitle(t.prioritySource)}
                              data-testid={`priority-source-${t.id}`}
                            >
                              {prioritySourceLabel(t.prioritySource)}
                            </span>
                          ) : null}
                        </>
                      ) : c.key === "status" ? (
                        <span className={cn("stamp", statusChipClass(t.status))}>{STATUS_LABEL[t.status] ?? t.status}</span>
                      ) : c.key === "title" ? (
                        <>
                          <span className="font-serif">{t.title}</span>
                          <span className="flex flex-wrap items-center gap-1.5 mt-1 sm:hidden">
                            <span className={cn("stamp", statusChipClass(t.status))}>{STATUS_LABEL[t.status] ?? t.status}</span>
                            {t.streamName ? <span className="eyebrow text-[9px]">{t.streamName}</span> : null}
                          </span>
                        </>
                      ) : c.key === "stream" ? (
                        t.streamName ? (
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: t.streamColor ?? "hsl(var(--ink-muted))" }} />
                            <span className="truncate">{t.streamName}</span>
                          </span>
                        ) : (
                          <span className="text-ink-muted text-xs">—</span>
                        )
                      ) : c.key === "app" ? (
                        t.appKey ? <span className="font-mono text-xs">{t.appKey}</span> : <span className="text-ink-muted text-xs">—</span>
                      ) : c.key === "assignee" ? (
                        t.assigneeName ? (
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
                        )
                      ) : c.key === "due" ? (
                        formatDay(t.dueDate) || "—"
                      ) : null}
                    </td>
                  ))}
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

      <TaskDrawer task={selected} why={why} open={drawerOpen} onOpenChange={setDrawerOpen} onTaskUpdated={onTaskUpdated} />
    </div>
  );
}

/** One row of the column picker. A fixed column shows as checked and cannot be turned off. */
function ColumnToggle({
  label,
  checked,
  onToggle,
  disabled,
  hint,
  testId,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  hint?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onToggle}
      disabled={disabled}
      aria-pressed={checked}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
        disabled ? "opacity-50" : "hover:bg-parchment-deep focus-ink"
      )}
      data-testid={testId}
    >
      <span className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center border", checked ? "border-ink bg-ink text-parchment" : "border-rule")}>
        {checked ? <Check className="h-2.5 w-2.5" /> : null}
      </span>
      <span className="flex-1 truncate font-serif">{label}</span>
      {hint ? <span className="font-mono text-[10px] text-ink-muted">{hint}</span> : null}
    </button>
  );
}
