import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bookmark, ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { iconFor } from "@/components/break-icons";
import { createTemplate, deleteTemplate, trackKeys, type StreamPick, type TemplateRow } from "./api";

/** "Stencils": the member's saved entries, started with one tap. */
export function TemplateMenu({
  templates,
  streams,
  onStart,
  disabled,
}: {
  templates: TemplateRow[];
  streams: StreamPick[];
  onStart: (tpl: TemplateRow) => void;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", icon: "", notes: "", streamId: "__none", isBreak: false });

  const create = useMutation({
    mutationFn: () =>
      createTemplate({
        name: draft.name,
        icon: draft.icon || undefined,
        notes: draft.notes || undefined,
        streamId: draft.streamId !== "__none" ? Number(draft.streamId) : undefined,
        isBreak: draft.isBreak,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: trackKeys.templates });
      setDraft({ name: "", icon: "", notes: "", streamId: "__none", isBreak: false });
      setNewOpen(false);
      toast({ title: "Stencil saved" });
    },
    onError: (e: Error) => toast({ title: "Could not save the stencil", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: deleteTemplate,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: trackKeys.templates });
      toast({ title: "Stencil removed" });
    },
    onError: (e: Error) => toast({ title: "Could not remove it", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="h-10 rounded-sm border-ink/30 font-display text-sm tracking-tight hover:bg-parchment-deep">
            <Bookmark className="h-3.5 w-3.5 mr-2" strokeWidth={2} />
            <span className="italic">Stencils</span>
            <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="font-display italic">Start from a stencil</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {templates.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground font-serif">Nothing saved yet.</div>
          ) : (
            templates.map((t) => {
              const Icon = iconFor(t.icon);
              const lane = streams.find((s) => s.id === t.streamId);
              return (
                <DropdownMenuItem
                  key={t.id}
                  disabled={disabled}
                  onSelect={() => onStart(t)}
                  className="flex items-center gap-2"
                >
                  <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                  <span className="truncate font-serif">{t.name}</span>
                  {t.isBreak && <span className="eyebrow text-[9px]">break</span>}
                  {lane && <span className="eyebrow text-[9px] truncate max-w-[70px]">{lane.name}</span>}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 ml-auto shrink-0 text-ink-muted hover:text-vermilion"
                    aria-label={`Delete stencil ${t.name}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      remove.mutate(t.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </DropdownMenuItem>
              );
            })
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setNewOpen(true);
            }}
          >
            <Plus className="h-4 w-4 mr-2" /> New stencil
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="paper w-[95vw] max-w-[420px] rounded-sm border-ink/20">
          <DialogTitle className="font-display font-normal italic text-2xl">New stencil</DialogTitle>
          <DialogDescription className="font-serif">A recurring entry you can start with one tap.</DialogDescription>
          <div className="space-y-3 py-2">
            <Input
              placeholder="Name (e.g. Morning triage)"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="h-10 rounded-sm border-ink/30 font-serif"
            />
            <Input
              placeholder="Icon slug (optional — coffee, call, think…)"
              value={draft.icon}
              onChange={(e) => setDraft({ ...draft, icon: e.target.value.replace(/[^a-z0-9-]/gi, "") })}
              className="h-10 rounded-sm border-ink/30 font-serif"
            />
            <Select value={draft.streamId} onValueChange={(v) => setDraft({ ...draft, streamId: v })}>
              <SelectTrigger className="h-10 rounded-sm border-ink/30 font-serif">
                <SelectValue placeholder="Stream (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">No stream</SelectItem>
                {streams.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              placeholder="Note copied onto every entry (optional)"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              className="rounded-sm border-ink/30 font-serif"
            />
            <label className="flex items-center gap-2 text-sm font-serif">
              <Checkbox checked={draft.isBreak} onCheckedChange={(v) => setDraft({ ...draft, isBreak: Boolean(v) })} />
              This is a break tile
            </label>
            <Button
              className="w-full h-10 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight text-sm"
              disabled={!draft.name || create.isPending}
              onClick={() => create.mutate()}
            >
              Save stencil
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default TemplateMenu;
