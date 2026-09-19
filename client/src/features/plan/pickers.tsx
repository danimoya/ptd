import { useState } from "react";
import { format } from "date-fns";
import { Bot, CalendarDays, Check, ChevronsUpDown, Layers, Package, Plus, User as UserIcon, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Calendar } from "@/components/ui/calendar";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import type { MemberRow } from "@/lib/api";
import { laneColor, priorityBand } from "./logic";
import type { PlanApp, PlanStream } from "./types";

/** The shared field chrome: a small caps label over the control. */
export function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="eyebrow">{label}</span>
        {hint && <span className="font-mono text-[10px] text-ink-muted">{hint}</span>}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/* ─────────── stream ─────────── */

export function StreamCombobox({
  value,
  streams,
  onChange,
  onCreate,
}: {
  value: number | null;
  streams: PlanStream[];
  onChange: (streamId: number | null) => void;
  /** Provided by the card dialog; creates the lane server-side and returns its id. */
  onCreate?: (name: string) => Promise<number | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = streams.find((s) => s.id === value) ?? null;
  const filtered = streams.filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()));
  const canCreate = !!onCreate && !!query.trim() && !streams.some((s) => s.name.toLowerCase() === query.trim().toLowerCase());

  const create = async () => {
    if (!onCreate) return;
    const id = await onCreate(query.trim());
    if (id) onChange(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" role="combobox" aria-expanded={open} className={cn("draft-input w-full flex items-center justify-between gap-2 text-left", !selected && "text-ink-muted")}>
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <span className="h-3 w-1 shrink-0" style={{ background: laneColor(selected.id, selected.color) }} />
            ) : (
              <Layers className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            )}
            <span className="truncate">{selected ? selected.name : "No stream"}</span>
          </span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-0 border-rule">
        <Command className="bg-card">
          <div className="px-3 pt-3 pb-2 rule-b">
            <div className="eyebrow mb-1.5">Stream lookup</div>
            <CommandInput placeholder="Search or type to create" value={query} onValueChange={setQuery} className="font-mono text-xs" />
          </div>
          <CommandList className="max-h-64">
            <CommandEmpty>
              {canCreate ? (
                <button type="button" onClick={create} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-parchment-deep">
                  <Plus className="h-3 w-3 text-vermilion" /> Open stream “<span className="font-mono">{query.trim()}</span>”
                </button>
              ) : (
                <div className="py-3 text-center eyebrow">No streams yet</div>
              )}
            </CommandEmpty>
            <CommandGroup heading="Streams">
              <CommandItem value="__none__" onSelect={() => { onChange(null); setOpen(false); }} className="text-sm">
                <Check className={cn("mr-2 h-3 w-3", value === null ? "opacity-100" : "opacity-0")} />
                <span className="text-ink-muted">No stream</span>
              </CommandItem>
              {filtered.map((stream) => (
                <CommandItem key={stream.id} value={stream.name} onSelect={() => { onChange(stream.id); setOpen(false); }} className="text-sm">
                  <Check className={cn("mr-2 h-3 w-3", value === stream.id ? "opacity-100" : "opacity-0")} />
                  <span className="mr-2 h-3 w-1 shrink-0" style={{ background: laneColor(stream.id, stream.color) }} />
                  <span className="truncate">{stream.name}</span>
                  {stream.archived && <span className="ml-auto eyebrow">archived</span>}
                </CommandItem>
              ))}
            </CommandGroup>
            {canCreate && filtered.length > 0 && (
              <CommandGroup heading="Create">
                <CommandItem value={`create-${query}`} onSelect={create} className="text-sm">
                  <Plus className="mr-2 h-3 w-3 text-vermilion" /> Open stream “<span className="font-mono">{query.trim()}</span>”
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/* ─────────── app ─────────── */

/**
 * The app list is deliberately narrowed to the apps attached to the card's
 * stream — the server rejects any other combination, so offering them would be
 * offering an error.
 */
export function AppPicker({
  value,
  streamId,
  apps,
  streams,
  onChange,
}: {
  value: number | null;
  streamId: number | null;
  apps: PlanApp[];
  streams: PlanStream[];
  onChange: (appId: number | null) => void;
}) {
  const stream = streams.find((s) => s.id === streamId) ?? null;
  const onStream = streamId === null ? apps : apps.filter((a) => a.streamIds.includes(streamId));
  // Archived apps stay visible only while a card is still filed against one.
  const allowed = onStream.filter((a) => !a.archived || a.id === value);
  const selected = apps.find((a) => a.id === value) ?? null;

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn("border px-2 py-1 text-xs transition-colors focus-ink", value === null ? "border-ink bg-ink text-parchment" : "border-rule text-ink-muted hover:border-ink hover:text-ink")}
        >
          None
        </button>
        {allowed.map((app) => (
          <button
            key={app.id}
            type="button"
            onClick={() => onChange(app.id)}
            title={app.key}
            className={cn("border px-2 py-1 text-xs transition-colors focus-ink", value === app.id ? "border-ink bg-ink text-parchment" : "border-rule hover:border-ink")}
          >
            <Package className="mr-1 -mt-0.5 inline h-3 w-3" />
            {app.name}
          </button>
        ))}
      </div>
      {allowed.length === 0 && (
        <p className="mt-1.5 font-serif text-xs text-ink-muted">
          {stream ? `No app is attached to “${stream.name}” yet — attach one from the Org surface or via stream.attach_app.` : "This org has no apps yet."}
        </p>
      )}
      {selected && streamId !== null && !selected.streamIds.includes(streamId) && (
        <p className="mt-1.5 font-serif text-xs text-vermilion">“{selected.name}” is not attached to this stream — saving will be rejected.</p>
      )}
    </div>
  );
}

/* ─────────── assignee ─────────── */

export function AgentBadge() {
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 border border-rule px-1 font-mono text-[9px] uppercase tracking-wider2 text-ink-muted align-middle">
      <Bot className="h-2.5 w-2.5" />
      agent
    </span>
  );
}

export function AssigneePicker({ value, members, onChange }: { value: number | null; members: MemberRow[]; onChange: (userId: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const selected = members.find((m) => m.userId === value) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" role="combobox" aria-expanded={open} className={cn("draft-input w-full flex items-center justify-between gap-2 text-left", !selected && "text-ink-muted")}>
          <span className="flex min-w-0 items-center gap-2">
            {selected?.isAgent ? <Bot className="h-3.5 w-3.5 shrink-0 text-ink-muted" /> : <UserIcon className="h-3.5 w-3.5 shrink-0 text-ink-muted" />}
            <span className="truncate">{selected ? selected.displayName : "Unassigned"}</span>
            {selected?.isAgent && <AgentBadge />}
          </span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-0 border-rule">
        <Command className="bg-card">
          <div className="px-3 pt-3 pb-2 rule-b">
            <div className="eyebrow mb-1.5">Who owns it</div>
            <CommandInput placeholder="Search members" className="font-mono text-xs" />
          </div>
          <CommandList className="max-h-64">
            <CommandEmpty>
              <div className="py-3 text-center eyebrow">No matching member</div>
            </CommandEmpty>
            <CommandGroup heading={`${members.length} members`}>
              <CommandItem value="__unassigned__" onSelect={() => { onChange(null); setOpen(false); }} className="text-sm">
                <Check className={cn("mr-2 h-3 w-3", value === null ? "opacity-100" : "opacity-0")} />
                <span className="text-ink-muted">Unassigned</span>
              </CommandItem>
              {members.map((member) => (
                <CommandItem key={member.userId} value={`${member.displayName} ${member.email}`} onSelect={() => { onChange(member.userId); setOpen(false); }} className="text-sm">
                  <Check className={cn("mr-2 h-3 w-3", value === member.userId ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{member.displayName}</span>
                  {member.isAgent && <AgentBadge />}
                  <span className="ml-auto eyebrow">{member.role}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/* ─────────── dates ─────────── */

export function DatePicker({ value, onChange, placeholder = "Pick a date" }: { value: Date | null; onChange: (d: Date | null) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("draft-input w-full flex items-center justify-between gap-2 text-left", !value && "text-ink-muted")}>
          <span className="flex min-w-0 items-center gap-2">
            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            <span className="truncate font-mono text-sm tabular-nums">{value ? format(value, "EEE · dd MMM yyyy") : placeholder}</span>
          </span>
          {value && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear date"
              onClick={(e) => { e.stopPropagation(); onChange(null); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onChange(null); } }}
              className="text-ink-muted transition-colors hover:text-vermilion"
            >
              <X className="h-3 w-3" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0 border-rule">
        <div className="px-4 py-3 rule-b">
          <div className="eyebrow">Schedule</div>
          <div className="mt-0.5 font-display text-base tracking-tight">{value ? format(value, "MMMM yyyy") : placeholder}</div>
        </div>
        <Calendar
          mode="single"
          selected={value ?? undefined}
          onSelect={(d) => { if (d) { onChange(d); setOpen(false); } }}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}

/* ─────────── priority ─────────── */

export function ScoreSlider({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-xs tabular-nums text-ink">{value}</span>
      </div>
      <Slider className="mt-2" min={0} max={10} step={1} value={[value]} onValueChange={([v]) => onChange(v)} aria-label={label} />
    </div>
  );
}

/** The 0–100 score with its colour band — the same scale the Cascade view uses. */
export function PriorityScore({ score, source, className }: { score: number; source?: string; className?: string }) {
  const band = priorityBand(score);
  return (
    <span className={cn("inline-flex items-baseline gap-1 font-mono tabular-nums", band.text, className)} title={`${band.label}${source ? ` · ${source}` : ""}`}>
      <span className="text-sm font-semibold">{score}</span>
      {source && source !== "formula" && <span className="text-[9px] uppercase tracking-wider2">{source}</span>}
    </span>
  );
}

/* ─────────── tags ─────────── */

export function TagEditor({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const tag = draft.trim();
    if (!tag || value.includes(tag)) return setDraft("");
    onChange([...value, tag]);
    setDraft("");
  };
  return (
    <div>
      <div className="mb-2 flex min-h-[26px] flex-wrap gap-1.5">
        {value.length === 0 && <span className="font-mono text-xs italic text-ink-muted">(no tags)</span>}
        {value.map((tag) => (
          <span key={tag} className="stamp inline-flex items-center gap-1">
            {tag}
            <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))} className="text-ink-muted hover:text-vermilion">
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
          if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
        placeholder="Add a tag and press enter"
        className="draft-input w-full font-mono text-xs"
      />
    </div>
  );
}
