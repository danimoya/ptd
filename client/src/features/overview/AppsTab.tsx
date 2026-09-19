import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { createApp, fetchApps, updateApp } from "./api";
import { bandTextClass } from "./format";
import type { AppRow } from "./types";

type SortKey = "name" | "key" | "streamCount" | "openTasks" | "critical" | "maxPriority";
const DEFAULT_ORDER: Record<SortKey, "asc" | "desc"> = { name: "asc", key: "asc", streamCount: "desc", openTasks: "desc", critical: "desc", maxPriority: "desc" };

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "name", label: "name" },
  { key: "key", label: "key", className: "w-[120px]" },
  { key: "streamCount", label: "streams", className: "w-[190px] hidden md:table-cell" },
  { key: "openTasks", label: "open", className: "w-[70px]" },
  { key: "critical", label: "critical", className: "w-[80px]" },
  { key: "maxPriority", label: "max P", className: "w-[70px]" },
];

const list = (raw: string): string[] => raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

function AppDialog({ app, open, onOpenChange }: { app: AppRow | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const editing = !!app;
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [urls, setUrls] = useState("");
  const [repo, setRepo] = useState("");
  const [stack, setStack] = useState("");
  const [archived, setArchived] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKey(app?.key ?? "");
    setName(app?.name ?? "");
    setUrls((app?.urls ?? []).join("\n"));
    setRepo(app?.repo ?? "");
    setStack((app?.stack ?? []).join(", "));
    setArchived(app?.archived ?? false);
  }, [open, app]);

  const save = useMutation({
    mutationFn: async () => {
      const payload = { name: name.trim(), urls: list(urls), repo: repo.trim() || undefined, stack: list(stack) };
      if (editing) return updateApp({ appId: app!.id, ...payload, repo: repo.trim() ? repo.trim() : null, archived });
      return createApp({ key: key.trim(), ...payload });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/actions/app.list"] });
      qc.invalidateQueries({ queryKey: ["/api/org/stats"] });
      toast({ title: editing ? "App updated" : "App created" });
      onOpenChange(false);
    },
    onError: (err: Error) => toast({ title: editing ? "Could not update app" : "Could not create app", description: err.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border border-ink/30 rounded-sm sm:max-w-lg" data-testid="app-dialog">
        <DialogHeader>
          <div className="eyebrow text-[9px]">{editing ? `App № ${app!.id}` : "New app"}</div>
          <DialogTitle className="font-display text-2xl font-normal tracking-tight">{editing ? app!.name : "Register an app"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block">
            <span className="eyebrow text-[9px]">key</span>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={editing}
              placeholder="core-api"
              className="draft-input w-full mt-1 font-mono text-sm disabled:opacity-60 focus-ink"
              data-testid="app-key"
            />
            <span className="text-[11px] font-serif italic text-ink-muted">
              {editing ? "The key never changes — external references point at it." : "Lowercase, and unique inside the organization."}
            </span>
          </label>
          <label className="block">
            <span className="eyebrow text-[9px]">name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Core API" className="draft-input w-full mt-1 text-sm focus-ink" data-testid="app-name" />
          </label>
          <label className="block">
            <span className="eyebrow text-[9px]">urls — one per line</span>
            <textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={2} placeholder="https://api.example.com" className="draft-input w-full mt-1 text-sm font-mono focus-ink" data-testid="app-urls" />
          </label>
          <label className="block">
            <span className="eyebrow text-[9px]">repo</span>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="github:acme/api" className="draft-input w-full mt-1 text-sm font-mono focus-ink" data-testid="app-repo" />
          </label>
          <label className="block">
            <span className="eyebrow text-[9px]">stack — comma separated</span>
            <input value={stack} onChange={(e) => setStack(e.target.value)} placeholder="Rust, Postgres" className="draft-input w-full mt-1 text-sm focus-ink" data-testid="app-stack" />
          </label>
          {editing ? (
            <label className="flex items-center gap-2 cursor-pointer pt-1">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className="accent-vermilion" data-testid="app-archived" />
              <span className="eyebrow text-[9px]">archived — hidden from lists and KPIs, history kept</span>
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <button onClick={() => onOpenChange(false)} className="stamp focus-ink px-3 py-1.5">cancel</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !name.trim() || (!editing && !key.trim())}
            className="inline-flex items-center gap-2 px-4 py-2 border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
            data-testid="app-save"
          >
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            <span className="eyebrow text-[10px] !text-current">{editing ? "save" : "create"}</span>
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AppsTab() {
  const [params, setParams] = useSearchParams();
  const [sort, setSort] = useState<SortKey>("maxPriority");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<AppRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const apps = useQuery({ queryKey: ["/api/actions/app.list", showArchived], queryFn: () => fetchApps(showArchived) });

  // A drawer link can deep-link here with ?app=<id>; open that app's editor once.
  const deepLink = params.get("app");
  useEffect(() => {
    if (!deepLink || !apps.data) return;
    const found = apps.data.find((a) => a.id === Number(deepLink));
    if (found) {
      setEditing(found);
      setDialogOpen(true);
    }
    const next = new URLSearchParams(params);
    next.delete("app");
    setParams(next, { replace: true });
  }, [deepLink, apps.data]);

  const rows = useMemo(() => {
    const data = Array.isArray(apps.data) ? [...apps.data] : [];
    const dir = order === "asc" ? 1 : -1;
    return data.sort((a, b) => {
      const x = a[sort];
      const y = b[sort];
      if (typeof x === "string" && typeof y === "string") return dir * x.localeCompare(y);
      return dir * (Number(x) - Number(y)) || a.key.localeCompare(b.key);
    });
  }, [apps.data, sort, order]);

  const onSort = (key: SortKey) => {
    if (sort === key) setOrder((o) => (o === "desc" ? "asc" : "desc"));
    else {
      setSort(key);
      setOrder(DEFAULT_ORDER[key]);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-vermilion" data-testid="apps-show-archived" />
          <span className="eyebrow text-[9px]">show archived</span>
        </label>
        <button
          onClick={() => { setEditing(null); setDialogOpen(true); }}
          className="inline-flex items-center gap-2 px-3 py-1.5 border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink"
          data-testid="apps-new"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="eyebrow text-[10px] !text-current">new app</span>
        </button>
      </div>

      <div className="paper-flat overflow-x-auto nice-scroll">
        <table className="w-full text-sm" data-testid="apps-table">
          <thead>
            <tr className="border-b border-ink/70">
              {COLUMNS.map((c) => (
                <th key={c.key} className={cn("text-left px-3 py-2 font-normal", c.className)}>
                  <button onClick={() => onSort(c.key)} className="eyebrow text-[9px] inline-flex items-center gap-1 hover:text-ink focus-ink rounded-sm" data-testid={`apps-sort-${c.key}`}>
                    {c.label}
                    {sort === c.key ? (order === "desc" ? <ArrowDown className="h-3 w-3 text-vermilion" /> : <ArrowUp className="h-3 w-3 text-vermilion" />) : null}
                  </button>
                </th>
              ))}
              <th className="w-[44px]" />
            </tr>
          </thead>
          <tbody>
            {apps.isLoading ? (
              <tr><td colSpan={7} className="px-3 py-10 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-10 text-center font-serif italic text-ink-muted">No apps registered yet.</td></tr>
            ) : (
              rows.map((a) => (
                <tr key={a.id} className="border-b border-rule last:border-0 hover:bg-parchment-deep/60 align-top" data-testid={`app-row-${a.id}`}>
                  <td className="px-3 py-2">
                    <span className="font-serif">{a.name}</span>
                    {a.archived ? <span className="stamp border-rule text-ink-muted ml-2">archived</span> : null}
                    {a.urls.length > 0 ? (
                      <div className="mt-0.5 flex flex-wrap gap-x-3">
                        {a.urls.filter((u) => /^https?:\/\//i.test(u)).map((u) => (
                          <a key={u} href={u} target="_blank" rel="noreferrer noopener" className="text-[11px] font-mono text-ink-muted hover:text-vermilion focus-ink rounded-sm">
                            {u.replace(/^https?:\/\//, "")}
                          </a>
                        ))}
                      </div>
                    ) : null}
                    {a.stack.length > 0 ? <div className="eyebrow text-[9px] mt-1">{a.stack.join(" · ")}</div> : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{a.key}</td>
                  <td className="px-3 py-2 hidden md:table-cell">
                    {a.streams.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {a.streams.map((s) => (
                          <span key={s.id} className="stamp border-rule normal-case tracking-normal inline-flex items-center gap-1">
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color ?? "hsl(var(--ink-muted))" }} />
                            {s.name}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-ink-muted text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-numeric">{a.openTasks}</td>
                  <td className="px-3 py-2 font-numeric">
                    {a.critical > 0 ? <span className="text-vermilion font-medium">{a.critical}</span> : <span className="text-ink-muted">0</span>}
                  </td>
                  <td className={cn("px-3 py-2 font-numeric font-medium", a.maxPriority > 0 ? bandTextClass(a.maxPriority) : "text-ink-muted")}>{a.maxPriority}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => { setEditing(a); setDialogOpen(true); }} aria-label={`Edit ${a.name}`} className="text-ink-muted hover:text-ink focus-ink rounded-sm p-1" data-testid={`app-edit-${a.id}`}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AppDialog app={editing} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
