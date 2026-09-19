import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ChevronDown, Plus, Users, LogOut } from "lucide-react";
import { createWorkspace, getWorkspaces, type WorkspaceSummary } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Link } from "react-router-dom";
import { currentUserEmail, secondsUntilExpiry, signOut } from "@/lib/auth";

export default function WorkspaceSwitcher() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    localStorage.getItem("workspaceId")
  );

  const { data: workspaces = [] } = useQuery<WorkspaceSummary[]>({
    queryKey: ["/api/workspaces"],
    queryFn: getWorkspaces,
  });

  useEffect(() => {
    if (!selectedId && workspaces.length > 0) {
      const first = workspaces[0].id.toString();
      localStorage.setItem("workspaceId", first);
      setSelectedId(first);
    }
  }, [workspaces, selectedId]);

  const createMutation = useMutation({
    mutationFn: createWorkspace,
    onSuccess: (ws) => {
      qc.invalidateQueries({ queryKey: ["/api/workspaces"] });
      localStorage.setItem("workspaceId", ws.id.toString());
      setSelectedId(ws.id.toString());
      setCreateOpen(false);
      setName("");
      toast({ title: `Workspace "${ws.name}" opened` });
      window.location.reload();
    },
    onError: () =>
      toast({ title: "Could not open workspace", variant: "destructive" }),
  });

  const switchTo = (id: number) => {
    localStorage.setItem("workspaceId", id.toString());
    setSelectedId(id.toString());
    window.location.reload();
  };

  const active =
    workspaces.find((w) => w.id.toString() === selectedId) || workspaces[0];

  const email = currentUserEmail();
  const secs = secondsUntilExpiry();
  const expiryLabel =
    secs == null
      ? null
      : secs > 86400
      ? `expires in ${Math.floor(secs / 86400)}d`
      : secs > 3600
      ? `expires in ${Math.floor(secs / 3600)}h`
      : secs > 60
      ? `expires in ${Math.floor(secs / 60)}m`
      : secs > 0
      ? `expires in ${secs}s`
      : "expired";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-10 px-3 max-w-[180px] sm:max-w-[220px] rounded-sm border border-rule hover:bg-parchment-deep hover:border-ink/40"
          >
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="eyebrow text-[9px] hidden sm:inline">Vol.</span>
              <span className="font-display italic text-sm sm:text-base truncate">
                {active?.name ?? "Workspace"}
              </span>
            </div>
            <ChevronDown className="h-3 w-3 ml-2 shrink-0 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-64 rounded-sm border-ink/20 bg-card"
        >
          <DropdownMenuLabel className="eyebrow text-[10px]">
            Volumes on the shelf
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-rule" />
          {workspaces.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => switchTo(w.id)}
              className={`rounded-none font-serif ${
                w.id.toString() === selectedId ? "bg-vermilion/10" : ""
              }`}
            >
              <span className="truncate flex-1 italic">{w.name}</span>
              <span className="eyebrow text-[9px] ml-2">{w.role}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator className="bg-rule" />
          <DropdownMenuItem asChild className="rounded-none">
            <Link to="/members" className="flex items-center w-full font-serif">
              <Users className="h-4 w-4 mr-2" /> Manage scribes
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setCreateOpen(true);
            }}
            className="rounded-none font-serif"
          >
            <Plus className="h-4 w-4 mr-2" /> Open new volume
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-rule" />
          {email && (
            <div className="px-2 py-1.5">
              <div className="eyebrow text-[9px]">Signed in as</div>
              <div className="font-serif italic text-sm truncate">{email}</div>
              {expiryLabel && (
                <div className="eyebrow text-[9px] mt-0.5 text-ink-muted">
                  Session {expiryLabel}
                </div>
              )}
            </div>
          )}
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              signOut();
            }}
            className="rounded-none font-serif text-vermilion focus:text-vermilion focus:bg-vermilion/10"
          >
            <LogOut className="h-4 w-4 mr-2" /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="w-[95vw] max-w-[420px] paper border-ink/20 rounded-sm">
          <DialogTitle className="font-display font-normal italic text-2xl">
            Open a new volume
          </DialogTitle>
          <DialogDescription className="font-serif">
            Each volume holds its own customers and entries. You will be the
            keeper.
          </DialogDescription>
          <div className="space-y-3 py-2">
            <Input
              placeholder="Volume title"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-11 rounded-sm border-ink/30 font-serif"
            />
            <Button
              className="w-full h-11 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight"
              disabled={!name || createMutation.isPending}
              onClick={() => createMutation.mutate(name)}
            >
              Open volume
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
