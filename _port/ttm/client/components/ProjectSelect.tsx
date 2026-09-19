import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Plus, Folder } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  createProject,
  deleteProject,
  getCustomers,
  getProjects,
  type Project,
} from "@/lib/api";

interface Customer {
  id: number;
  name: string;
}

interface ProjectSelectProps {
  /** Selected project (if any) */
  selectedProjectId?: string;
  /** Optional customer filter — when set, lists only projects of that customer */
  filterCustomerId?: string;
  /** Callback: (projectId, project) — project is the full row so the caller can stamp its customerId */
  onProjectChange: (projectId: string | undefined, project?: Project) => void;
}

const PALETTE = ["#B8451A", "#1A1510", "#405C3F", "#7A6F5D", "#8C6D31", "#5B7B8F", "#AE5A7D"];

export function ProjectSelect({
  selectedProjectId,
  filterCustomerId,
  onProjectChange,
}: ProjectSelectProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    queryFn: () => getProjects(),
  });
  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
    queryFn: getCustomers,
  });

  // Filter to active projects; if a customer is set in the picker, show only
  // that customer's projects + unassigned (no customer).
  const visible = useMemo(() => {
    return projects.filter((p) => {
      if (p.archived) return false;
      if (!filterCustomerId) return true;
      const cid = filterCustomerId ? parseInt(filterCustomerId, 10) : undefined;
      return p.customerId === cid || p.customerId == null;
    });
  }, [projects, filterCustomerId]);

  const [draft, setDraft] = useState<{ name: string; customerId: string; color: string }>(
    { name: "", customerId: "__none", color: PALETTE[0] }
  );

  const createMutation = useMutation({
    mutationFn: () =>
      createProject({
        name: draft.name,
        customerId: draft.customerId && draft.customerId !== "__none" ? parseInt(draft.customerId) : null,
        color: draft.color,
      }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["/api/projects"] });
      setDraft({ name: "", customerId: "__none", color: PALETTE[0] });
      onProjectChange(p.id.toString(), p);
      toast({ title: `Project "${p.name}" opened` });
    },
    onError: () => toast({ title: "Could not create project", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["/api/projects"] });
      if (selectedProjectId === String(id)) onProjectChange(undefined);
      toast({ title: "Project removed" });
    },
  });

  const selected = visible.find((p) => p.id.toString() === selectedProjectId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="w-full h-12 justify-between rounded-sm border-ink/30 bg-transparent font-serif text-base px-4 hover:bg-parchment-deep hover:border-ink/60"
        >
          <span className="flex items-center gap-2 min-w-0">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: selected?.color || "hsl(var(--ink) / 0.2)" }}
              aria-hidden
            />
            <span className={selected ? "text-ink italic truncate" : "text-ink-muted italic truncate"}>
              {selected ? selected.name : "Attach a project (optional)…"}
            </span>
          </span>
          <span className="eyebrow text-[10px] shrink-0">Select</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="paper w-[95vw] max-w-[520px] max-h-[90vh] overflow-y-auto rounded-sm border-ink/20">
        <DialogTitle className="font-display font-normal italic text-2xl">
          Choose a project
        </DialogTitle>
        <DialogDescription className="font-serif">
          Projects group sessions under a heading — optionally tied to a client.
        </DialogDescription>

        {/* Create new project */}
        <div className="mt-4 border border-rule rounded-sm p-4 space-y-3">
          <div className="eyebrow">Open a new project</div>
          <Input
            placeholder="Project name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="h-11 rounded-sm border-ink/30 font-serif"
          />
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Select
              value={draft.customerId}
              onValueChange={(v) => setDraft({ ...draft, customerId: v })}
            >
              <SelectTrigger className="h-11 rounded-sm border-ink/30 font-serif">
                <SelectValue placeholder="Client (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">No client</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id.toString()}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-1 items-center">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setDraft({ ...draft, color: c })}
                  aria-label={`Color ${c}`}
                  className="w-5 h-5 rounded-full border"
                  style={{
                    background: c,
                    borderColor: draft.color === c ? "hsl(var(--ink))" : "hsl(var(--rule))",
                    outlineOffset: 2,
                    outline: draft.color === c ? "1px solid hsl(var(--ink))" : "none",
                  }}
                />
              ))}
            </div>
          </div>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!draft.name || createMutation.isPending}
            className="w-full h-10 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight text-sm"
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Open project
          </Button>
        </div>

        {/* Existing projects list */}
        <ScrollArea className="max-h-[280px] mt-3">
          <div className="grid gap-1">
            <Button
              variant="ghost"
              className="w-full justify-start font-serif italic rounded-none px-2"
              onClick={() => {
                onProjectChange(undefined);
                setOpen(false);
              }}
            >
              <Folder className="h-3.5 w-3.5 mr-2 opacity-60" />
              <span className="text-ink-muted">No project</span>
            </Button>
            {visible.length === 0 ? (
              <div className="py-6 text-center">
                <div className="fleuron max-w-[200px] mx-auto">❧</div>
                <p className="font-display italic text-ink-muted text-sm mt-2">
                  No projects yet. Open one above.
                </p>
              </div>
            ) : (
              visible.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-1 border border-rule rounded-sm px-2 py-1 hover:bg-parchment-deep"
                >
                  <button
                    onClick={() => {
                      onProjectChange(p.id.toString(), p);
                      setOpen(false);
                    }}
                    className="flex items-center gap-2 flex-1 min-w-0 py-1 text-left"
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: p.color || "hsl(var(--ink) / 0.35)" }}
                    />
                    <div className="min-w-0">
                      <div className="font-serif italic truncate">{p.name}</div>
                      {p.customerName && (
                        <div className="eyebrow text-[10px] mt-0.5 truncate">
                          for {p.customerName}
                        </div>
                      )}
                    </div>
                  </button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-ink-muted hover:text-vermilion hover:bg-transparent"
                        aria-label="Remove project"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="paper rounded-sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="font-display italic font-normal">
                          Remove "{p.name}"?
                        </AlertDialogTitle>
                        <AlertDialogDescription className="font-serif">
                          Existing time entries remain but lose their project tag.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => deleteMutation.mutate(p.id)}
                          className="bg-vermilion hover:bg-ink text-parchment"
                        >
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export default ProjectSelect;
