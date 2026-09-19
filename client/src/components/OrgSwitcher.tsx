import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ChevronDown, Plus, LogOut } from "lucide-react";
import { createOrg, getOrgs, type OrgSummary } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { currentUserEmail, signOut } from "@/lib/auth";

export default function OrgSwitcher() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(localStorage.getItem("orgId"));

  const { data: orgs = [] } = useQuery<OrgSummary[]>({ queryKey: ["/api/orgs"], queryFn: getOrgs });

  useEffect(() => {
    if (!selectedId && orgs.length > 0) {
      const first = orgs[0].id.toString();
      localStorage.setItem("orgId", first);
      setSelectedId(first);
    }
  }, [orgs, selectedId]);

  const createMutation = useMutation({
    mutationFn: createOrg,
    onSuccess: (org) => {
      qc.invalidateQueries({ queryKey: ["/api/orgs"] });
      localStorage.setItem("orgId", org.id.toString());
      setCreateOpen(false);
      setName("");
      toast({ title: `Organization "${org.name}" created` });
      window.location.href = "/";
    },
    onError: () => toast({ title: "Could not create organization", variant: "destructive" }),
  });

  const switchTo = (id: number) => {
    localStorage.setItem("orgId", id.toString());
    window.location.href = "/";
  };

  const active = orgs.find((o) => o.id.toString() === selectedId) || orgs[0];
  const email = currentUserEmail();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-10 px-3 max-w-[180px] sm:max-w-[240px] rounded-sm border border-rule hover:bg-parchment-deep hover:border-ink/40">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="eyebrow text-[9px] hidden sm:inline">{active?.role ?? ""}</span>
              <span className="font-display italic text-sm sm:text-base truncate">{active?.name ?? "Organization"}</span>
            </div>
            <ChevronDown className="h-3 w-3 ml-2 shrink-0 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 rounded-sm border-ink/20 bg-card">
          <DropdownMenuLabel className="eyebrow text-[10px]">Organizations</DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-rule" />
          {orgs.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => switchTo(o.id)} className={`rounded-none font-serif ${o.id.toString() === selectedId ? "bg-vermilion/10" : ""}`}>
              <span className="truncate flex-1 italic">{o.name}</span>
              <span className="eyebrow text-[9px] ml-2">{o.role}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator className="bg-rule" />
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setCreateOpen(true); }} className="rounded-none font-serif">
            <Plus className="h-4 w-4 mr-2" /> New organization
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-rule" />
          {email && (
            <div className="px-2 py-1.5">
              <div className="eyebrow text-[9px]">Signed in as</div>
              <div className="font-serif italic text-sm truncate">{email}</div>
            </div>
          )}
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); signOut(); }} className="rounded-none font-serif text-vermilion focus:text-vermilion focus:bg-vermilion/10">
            <LogOut className="h-4 w-4 mr-2" /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="w-[95vw] max-w-[420px] paper border-ink/20 rounded-sm">
          <DialogTitle className="font-display font-normal italic text-2xl">New organization</DialogTitle>
          <DialogDescription className="font-serif">Each organization has its own members, streams, tasks and ledger. You will be the owner.</DialogDescription>
          <div className="space-y-3 py-2">
            <Input placeholder="Organization name" value={name} onChange={(e) => setName(e.target.value)} className="h-11 rounded-sm border-ink/30 font-serif" />
            <Button className="w-full h-11 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight" disabled={!name || createMutation.isPending} onClick={() => createMutation.mutate(name)}>
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
