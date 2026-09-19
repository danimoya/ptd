import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  createEntryTemplate,
  deleteEntryTemplate,
  getCustomers,
  getEntryTemplates,
  type EntryTemplate,
} from "@/lib/api";
import { ChevronDown, Bookmark, Trash2, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

interface Customer {
  id: number;
  name: string;
}

interface TemplateMenuProps {
  onStartFromTemplate: (tpl: EntryTemplate) => void;
  disabled?: boolean;
}

export default function TemplateMenu({ onStartFromTemplate, disabled }: TemplateMenuProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [manageOpen, setManageOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", customerId: "", notes: "", isBreak: false });

  const { data: templates = [] } = useQuery<EntryTemplate[]>({
    queryKey: ["/api/entry-templates"],
    queryFn: getEntryTemplates,
  });
  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
    queryFn: getCustomers,
  });

  const createMutation = useMutation({
    mutationFn: createEntryTemplate,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/entry-templates"] });
      setDraft({ name: "", customerId: "", notes: "", isBreak: false });
      toast({ title: "Template saved" });
    },
    onError: () => toast({ title: "Failed to save template", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteEntryTemplate,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/entry-templates"] });
      toast({ title: "Template deleted" });
    },
  });

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            disabled={disabled}
            className="h-10 rounded-sm border-ink/30 font-display text-sm tracking-tight hover:bg-parchment-deep"
          >
            <Bookmark className="h-3.5 w-3.5 mr-2" strokeWidth={2} />
            <span className="italic">Stencils</span>
            <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Start from template</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {templates.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">No templates yet</div>
          ) : (
            templates.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => onStartFromTemplate(t)} className="flex justify-between">
                <span className="truncate">{t.name}</span>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 ml-2"
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Delete template"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete template?</AlertDialogTitle>
                      <AlertDialogDescription>Removes "{t.name}" permanently.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => deleteMutation.mutate(t.id)}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setManageOpen(true); }}>
            <Plus className="h-4 w-4 mr-2" /> New template
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="w-[95vw] max-w-[400px]">
          <DialogTitle>New template</DialogTitle>
          <DialogDescription>Save a recurring entry you can start with one tap.</DialogDescription>
          <div className="space-y-3 py-2">
            <Input
              placeholder="Template name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Select
              value={draft.customerId}
              onValueChange={(v) => setDraft({ ...draft, customerId: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Customer (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">No customer</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id.toString()}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              placeholder="Notes (optional)"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.isBreak}
                onCheckedChange={(v) => setDraft({ ...draft, isBreak: Boolean(v) })}
              />
              This is a break template
            </label>
            <Button
              className="w-full"
              disabled={!draft.name || createMutation.isPending}
              onClick={() => {
                createMutation.mutate({
                  name: draft.name,
                  customerId: draft.customerId && draft.customerId !== "__none" ? parseInt(draft.customerId) : null,
                  notes: draft.notes || null,
                  isBreak: draft.isBreak,
                });
                setManageOpen(false);
              }}
            >
              Save template
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
