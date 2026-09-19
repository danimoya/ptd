import { useMemo, useState } from "react";
import { format } from "date-fns";
import { AlertTriangle, Bot, ChevronDown, ChevronRight, CornerDownRight, GitBranch, Layers, Package, Play, RotateCcw, User as UserIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MemberRow } from "@/lib/api";
import {
  buildForest,
  dayOf,
  groupAndOrder,
  groupKeyFor,
  laneColor,
  orderTasks,
  pad4,
  priorityBand,
  slackOf,
  slipPreview,
  sourceOf,
  ORDER_LABELS,
  GROUP_LABELS,
  type CascadeNode,
  type SlipRow,
} from "./logic";
import type { CascadeGroup, CascadeOrder, PlanApp, PlanStream, PlanTask } from "./types";

const ORDERS: CascadeOrder[] = ["priority_score", "due_date", "start_date", "float"];
const GROUPS: CascadeGroup[] = ["stream", "app", "assignee", "source"];
const INDENT = 18;

interface CascadeViewProps {
  tasks: PlanTask[];
  streams: PlanStream[];
  apps: PlanApp[];
  members: MemberRow[];
  order: CascadeOrder;
  onOrderChange: (order: CascadeOrder) => void;
  group: CascadeGroup;
  onGroupChange: (group: CascadeGroup) => void;
  onOpen: (task: PlanTask) => void;
}

/**
 * Cascade mode: the plan as a dependency tree instead of a calendar.
 *
 * Roots are the cards with no dependencies; everything that depends on a card is
 * nested under it, and a card with several dependencies appears under each one
 * (marked, so nobody reads it as duplicated work). Order picks what sorts the
 * siblings; Group by slices them inside each parent — "source" meaning whether
 * the assignee is an agent seat or a person.
 *
 * The slip preview runs the SAME cascade function the server runs (copied into
 * features/plan/cascade.ts), so "push this root N days" previews exactly the
 * dates a save would write.
 */
export function CascadeView({ tasks, streams, apps, members, order, onOrderChange, group, onGroupChange, onOpen }: CascadeViewProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [slipRoot, setSlipRoot] = useState<number | null>(null);
  const [slipDays, setSlipDays] = useState("5");

  const open = tasks.filter((t) => !t.completed);
  const ctx = useMemo(() => ({ streams, apps, members }), [streams, apps, members]);
  const forest = useMemo(() => buildForest(open), [open]);
  const rootGroups = useMemo(
    () => groupAndOrder(forest.map((n) => n.task), group, order, ctx),
    [forest, group, order, ctx]
  );
  const nodeByTaskId = useMemo(() => new Map(forest.map((n) => [n.task.id, n])), [forest]);

  const days = parseInt(slipDays, 10);
  const slip = useMemo<Map<number, SlipRow>>(() => {
    if (slipRoot === null || !Number.isFinite(days) || days === 0) return new Map();
    return new Map(slipPreview(open, slipRoot, days).map((row) => [row.taskId, row]));
  }, [open, slipRoot, days]);

  const schedulable = useMemo(() => orderTasks(open.filter((t) => !!t.startDate), "start_date"), [open]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      {/* ─────────── controls ─────────── */}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 px-4 py-3 rule-b">
        <Segmented label="Order by" options={ORDERS} value={order} labels={ORDER_LABELS} onChange={onOrderChange} />
        <Segmented label="Group by" options={GROUPS} value={group} labels={GROUP_LABELS} onChange={onGroupChange} />

        <div className="ml-auto flex items-end gap-2">
          <div>
            <div className="eyebrow mb-1.5">Slip preview</div>
            <select
              value={slipRoot ?? ""}
              onChange={(e) => setSlipRoot(e.target.value ? parseInt(e.target.value, 10) : null)}
              className="draft-input max-w-[210px] font-mono text-xs"
              aria-label="Card to push"
            >
              <option value="">Pick a scheduled card…</option>
              {schedulable.map((task) => (
                <option key={task.id} value={task.id}>
                  №{pad4(task.id)} · {task.title.slice(0, 32)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="eyebrow mb-1.5">Days</div>
            <input
              type="number"
              value={slipDays}
              onChange={(e) => setSlipDays(e.target.value)}
              className="draft-input w-20 font-mono tabular-nums"
              aria-label="Days to slip"
            />
          </div>
          <button
            type="button"
            onClick={() => setSlipRoot(slipRoot)}
            disabled={slipRoot === null}
            title="Preview is live — pick a card and a number of days"
            className="flex items-center gap-1.5 border border-rule px-3 py-2 transition-colors hover:border-ink focus-ink disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            <span className="eyebrow !text-current">{slip.size ? `${slip.size} move` : "Preview"}</span>
          </button>
          {slipRoot !== null && (
            <button type="button" onClick={() => setSlipRoot(null)} title="Clear preview" className="flex items-center gap-1.5 border border-rule px-3 py-2 transition-colors hover:border-ink focus-ink">
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* ─────────── column header ─────────── */}
      <div className="grid grid-cols-[1fr_92px_92px_64px_52px] items-baseline gap-2 bg-parchment-deep/50 px-4 py-1.5 rule-b">
        <span className="eyebrow">Card</span>
        <span className="eyebrow text-right">Start</span>
        <span className="eyebrow text-right">{slip.size ? "If slipped" : "End"}</span>
        <span className="eyebrow text-right">Float</span>
        <span className="eyebrow text-right">Score</span>
      </div>

      {/* ─────────── tree ─────────── */}
      <div className="nice-scroll flex-1 overflow-auto">
        {open.length === 0 && (
          <div className="px-6 py-12 text-center">
            <GitBranch className="mx-auto mb-3 h-7 w-7 text-ink-muted/60" />
            <div className="font-display text-xl tracking-tight">No open cards to chain.</div>
            <p className="mt-1 font-serif text-sm text-ink-muted">Draft a card and give it a dependency to see the cascade.</p>
          </div>
        )}
        {rootGroups.map((rootGroup) => (
          <section key={rootGroup.key}>
            <header className="sticky top-0 z-10 flex items-baseline justify-between gap-2 border-y border-rule bg-card px-4 py-1.5">
              <span className="font-display text-sm tracking-tight">{rootGroup.label}</span>
              <span className="font-mono text-[10px] tabular-nums text-ink-muted">{rootGroup.tasks.length} root{rootGroup.tasks.length === 1 ? "" : "s"}</span>
            </header>
            {rootGroup.tasks.map((task) => {
              const node = nodeByTaskId.get(task.id);
              if (!node) return null;
              return (
                <NodeRows
                  key={node.path}
                  node={node}
                  collapsed={collapsed}
                  toggle={toggle}
                  order={order}
                  group={group}
                  ctx={ctx}
                  slip={slip}
                  onOpen={onOpen}
                />
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

function NodeRows({
  node,
  collapsed,
  toggle,
  order,
  group,
  ctx,
  slip,
  onOpen,
}: {
  node: CascadeNode;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  order: CascadeOrder;
  group: CascadeGroup;
  ctx: { streams: PlanStream[]; apps: PlanApp[]; members: MemberRow[] };
  slip: Map<number, SlipRow>;
  onOpen: (task: PlanTask) => void;
}) {
  const isCollapsed = collapsed.has(node.path);
  // Children are grouped first, then ordered inside each group — the
  // "sub-order / group by" control.
  const childGroups = groupAndOrder(node.children.map((c) => c.task), group, order, ctx);
  const childByTaskId = new Map(node.children.map((c) => [c.task.id, c]));

  return (
    <>
      <CascadeRow node={node} collapsed={isCollapsed} onToggle={() => toggle(node.path)} group={group} ctx={ctx} slip={slip.get(node.task.id)} slipActive={slip.size > 0} onOpen={onOpen} />
      {!isCollapsed &&
        childGroups.map((childGroup) =>
          childGroup.tasks.map((task) => {
            const child = childByTaskId.get(task.id);
            if (!child) return null;
            return <NodeRows key={child.path} node={child} collapsed={collapsed} toggle={toggle} order={order} group={group} ctx={ctx} slip={slip} onOpen={onOpen} />;
          })
        )}
    </>
  );
}

function CascadeRow({
  node,
  collapsed,
  onToggle,
  group,
  ctx,
  slip,
  slipActive,
  onOpen,
}: {
  node: CascadeNode;
  collapsed: boolean;
  onToggle: () => void;
  group: CascadeGroup;
  ctx: { streams: PlanStream[]; apps: PlanApp[]; members: MemberRow[] };
  slip?: SlipRow;
  /** A preview is running, so the muted column means "unchanged" rather than "end". */
  slipActive: boolean;
  onOpen: (task: PlanTask) => void;
}) {
  const task = node.task;
  const band = priorityBand(task.priorityScore);
  const start = dayOf(task.startDate);
  const end = dayOf(task.end);
  const float = slackOf(task);
  const groupBadge = groupKeyFor(task, group, ctx);
  const stream = ctx.streams.find((s) => s.id === task.streamId) ?? null;
  const source = sourceOf(task, ctx.members);

  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_92px_92px_64px_52px] items-center gap-2 px-4 py-1.5 transition-colors rule-b hover:bg-parchment-deep/40",
        slip && "bg-vermilion/[0.07]"
      )}
    >
      <div className="flex min-w-0 items-center" style={{ paddingLeft: node.depth * INDENT }}>
        {node.depth > 0 && <CornerDownRight className="mr-1 h-3 w-3 shrink-0 text-ink-muted/60" />}
        {node.children.length > 0 ? (
          <button type="button" onClick={onToggle} aria-label={collapsed ? "Expand" : "Collapse"} aria-expanded={!collapsed} className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center text-ink-muted hover:text-ink focus-ink">
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="mr-1 h-4 w-4 shrink-0" />
        )}
        {stream && <span className="mr-2 h-3 w-1 shrink-0" style={{ background: laneColor(stream.id, stream.color) }} />}
        <span className="mr-2 shrink-0 font-mono text-[10px] tabular-nums text-ink-muted">№{pad4(task.id)}</span>
        <button type="button" onClick={() => onOpen(task)} className="truncate text-left font-serif text-sm hover:text-vermilion focus-ink" title={task.title}>
          {task.title}
        </button>
        {node.children.length > 0 && <span className="ml-2 shrink-0 font-mono text-[10px] text-ink-muted">{node.children.length}↓</span>}
        {node.duplicate && (
          <span className="ml-2 shrink-0 eyebrow" title={`Also shown under ${node.parentIds.map((id) => `№${pad4(id)}`).join(", ")}`}>
            multi-dep
          </span>
        )}
        {node.orphan && (
          <span className="ml-2 inline-flex shrink-0 items-center gap-1 eyebrow !text-vermilion" title="Only reachable through a dependency loop">
            <AlertTriangle className="h-3 w-3" /> loop
          </span>
        )}
        <span className="ml-2 hidden shrink-0 items-center gap-1 eyebrow lg:inline-flex" title={GROUP_LABELS[group]}>
          {group === "stream" && <Layers className="h-3 w-3" />}
          {group === "app" && <Package className="h-3 w-3" />}
          {group === "assignee" && <UserIcon className="h-3 w-3" />}
          {group === "source" && (source === "agent" ? <Bot className="h-3 w-3" /> : <UserIcon className="h-3 w-3" />)}
          {groupBadge.label}
        </span>
      </div>

      <span className="text-right font-mono text-[11px] tabular-nums text-ink-muted">{start ? format(start, "dd MMM") : "—"}</span>

      {slip ? (
        <span className="text-right font-mono text-[11px] tabular-nums text-vermilion" title={slip.root ? "The card you pushed" : "Shifted by the cascade"}>
          {format(dayOf(slip.startDate)!, "dd MMM")}
          {slip.root ? " ·" : ""}
        </span>
      ) : (
        <span
          className="text-right font-mono text-[11px] tabular-nums text-ink-muted/80"
          title={slipActive ? "Unchanged by the preview — this is the card's own end" : "End of the card"}
        >
          {end ? format(end, "dd MMM") : "—"}
        </span>
      )}

      <span className={cn("text-right font-mono text-[11px] tabular-nums", float !== null && float < 0 ? "text-vermilion" : "text-ink-muted")}>
        {float === null ? "—" : `${float > 0 ? "+" : ""}${float}d`}
      </span>

      <span className={cn("text-right font-mono text-xs font-semibold tabular-nums", band.text)} title={`${band.label} · ${task.prioritySource}`}>
        {task.priorityScore}
      </span>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  labels,
  onChange,
}: {
  label: string;
  options: T[];
  value: T;
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <div className="eyebrow mb-1.5">{label}</div>
      <div className="flex items-center border border-rule">
        {options.map((option, index) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={cn(
              "eyebrow h-7 px-2.5 transition-colors focus-ink",
              index > 0 && "border-l border-rule",
              value === option ? "bg-ink !text-parchment" : "hover:bg-parchment-deep"
            )}
          >
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  );
}
