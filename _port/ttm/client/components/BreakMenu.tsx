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
import {
  createEntryTemplate,
  createTimeEntry,
  getEntryTemplates,
  type EntryTemplate,
} from "@/lib/api";
import { Coffee, Plus, Save } from "lucide-react";
import {
  BREAK_ICON_NAMES,
  BUILTIN_BREAKS,
  iconFor,
} from "./break-icons";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface BreakMenuProps {
  disabled?: boolean;
}

export default function BreakMenu({ disabled }: BreakMenuProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [customNote, setCustomNote] = useState("");

  const [saveMode, setSaveMode] = useState(false);
  const [draft, setDraft] = useState<{ name: string; icon: string; note: string }>({
    name: "",
    icon: "coffee",
    note: "",
  });

  const { data: templates = [] } = useQuery<EntryTemplate[]>({
    queryKey: ["/api/entry-templates"],
    queryFn: getEntryTemplates,
  });
  const customBreaks = templates.filter((t) => t.isBreak);

  const start = useMutation({
    mutationFn: (args: { notes?: string }) =>
      createTimeEntry({ isBreak: true, notes: args.notes || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/time-entries"] });
      setOpen(false);
      setCustomNote("");
      toast({ title: "Recess started" });
    },
    onError: () => toast({ title: "Failed to start break", variant: "destructive" }),
  });

  const saveTemplate = useMutation({
    mutationFn: () =>
      createEntryTemplate({
        name: draft.name,
        icon: draft.icon,
        notes: draft.note || draft.name,
        isBreak: true,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/entry-templates"] });
      setDraft({ name: "", icon: "coffee", note: "" });
      setSaveMode(false);
      toast({ title: "Quick type saved" });
    },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });

  const tile = (
    key: string,
    iconName: string,
    label: string,
    onClick: () => void
  ) => {
    const Icon = iconFor(iconName);
    return (
      <button
        key={key}
        onClick={onClick}
        className="paper-flat flex flex-col items-center gap-2 py-4 px-2 hover:border-ink/50 hover:bg-parchment-deep focus-ink transition-colors min-h-[88px]"
      >
        <Icon className="h-6 w-6 text-ink" strokeWidth={1.5} />
        <span className="font-display italic text-sm text-ink text-center leading-tight">
          {label}
        </span>
      </button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="lg"
          variant="outline"
          disabled={disabled}
          className="h-14 rounded-sm border-ink/70 text-ink hover:bg-ink hover:text-parchment px-4"
          aria-label="Start a break"
        >
          <Coffee className="mr-2 h-5 w-5 sm:mr-0" />
          <span className="sm:hidden">Break</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="paper w-[95vw] max-w-[520px] max-h-[90vh] overflow-y-auto rounded-sm border-ink/20">
        <DialogTitle className="font-display font-normal italic text-2xl">
          A pause from work
        </DialogTitle>
        <DialogDescription className="font-serif">
          Pick a kind — or tap <span className="italic">Other…</span> for a custom note.
        </DialogDescription>

        {/* ====== Built-in quick types ====== */}
        <div className="mt-4">
          <div className="eyebrow mb-2">Quick types</div>
          <div className="grid grid-cols-4 gap-2">
            {BUILTIN_BREAKS.map((b) =>
              tile(`bi-${b.icon}`, b.icon, b.name, () =>
                start.mutate({ notes: b.note })
              )
            )}
          </div>
        </div>

        {/* ====== User-saved break templates ====== */}
        {customBreaks.length > 0 && (
          <div className="mt-5">
            <div className="eyebrow mb-2">Your saved types</div>
            <div className="grid grid-cols-4 gap-2">
              {customBreaks.map((t) =>
                tile(`ct-${t.id}`, t.icon ?? "coffee", t.name, () =>
                  start.mutate({ notes: t.notes || t.name })
                )
              )}
            </div>
          </div>
        )}

        {/* ====== Free-form note ====== */}
        <div className="mt-5 border-t border-rule pt-4">
          <div className="eyebrow mb-2">Other… with a note</div>
          <div className="flex gap-2">
            <Input
              placeholder="What's this break about?"
              value={customNote}
              onChange={(e) => setCustomNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customNote.trim())
                  start.mutate({ notes: customNote.trim() });
              }}
              className="h-11 rounded-sm border-ink/30 font-serif"
            />
            <Button
              onClick={() => start.mutate({ notes: customNote.trim() || undefined })}
              disabled={start.isPending}
              className="h-11 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight text-sm"
            >
              Start
            </Button>
          </div>
        </div>

        {/* ====== Save a new quick type ====== */}
        <div className="mt-5 border-t border-rule pt-4">
          {!saveMode ? (
            <button
              onClick={() => setSaveMode(true)}
              className="eyebrow inline-flex items-center gap-1 text-vermilion hover:underline"
            >
              <Plus className="h-3 w-3" /> Add a quick type
            </button>
          ) : (
            <div className="space-y-3">
              <div className="eyebrow">New quick type</div>
              <Input
                placeholder="Name (e.g. School run)"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="h-10 rounded-sm border-ink/30 font-serif"
              />
              <Input
                placeholder="Default note (optional)"
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                className="h-10 rounded-sm border-ink/30 font-serif italic"
              />
              <div>
                <div className="eyebrow mb-2">Pick an icon</div>
                <div className="grid grid-cols-8 gap-1">
                  {BREAK_ICON_NAMES.map((n) => {
                    const Icon = iconFor(n);
                    const active = draft.icon === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setDraft({ ...draft, icon: n })}
                        aria-label={n}
                        className={cn(
                          "aspect-square flex items-center justify-center border rounded-sm transition-colors",
                          active
                            ? "border-ink bg-ink text-parchment"
                            : "border-rule text-ink hover:border-ink/50"
                        )}
                      >
                        <Icon className="h-4 w-4" strokeWidth={1.5} />
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setSaveMode(false)}
                  className="flex-1 h-10 rounded-sm border-ink/30 font-display uppercase tracking-tight text-sm"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => saveTemplate.mutate()}
                  disabled={!draft.name || saveTemplate.isPending}
                  className="flex-1 h-10 rounded-sm bg-ink text-parchment hover:bg-vermilion font-display uppercase tracking-tight text-sm"
                >
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
