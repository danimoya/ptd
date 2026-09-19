import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { KeyRound, Loader2, Plus, ShieldAlert, Trash2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { createToken, getTokens, revokeToken, type TokenRow } from "@/lib/api";
import CopyBlock from "./CopyBlock";

const day = (v: string | null) => (v ? format(new Date(v), "d MMM yyyy") : "—");
const EXPIRY_CHOICES = [
  { label: "never", value: "" },
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
  { label: "1 year", value: "365" },
] as const;

/**
 * Kanttban's TokenManager on PTD's endpoints. The full secret exists in exactly
 * one response and is never round-tripped from the server again, which is why the
 * reveal panel blocks the form until it is dismissed.
 */
export default function TokensTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<string>("");
  const [minted, setMinted] = useState<{ id: number; name: string; prefix: string; secret: string } | null>(null);

  const tokens = useQuery({ queryKey: ["/api/tokens"], queryFn: getTokens });

  const mint = useMutation({
    mutationFn: () => createToken(name.trim(), expiry ? Number(expiry) : undefined),
    onSuccess: (data) => {
      setMinted(data);
      setName("");
      qc.invalidateQueries({ queryKey: ["/api/tokens"] });
    },
    onError: (err: Error) => toast({ title: "Could not mint token", description: err.message, variant: "destructive" }),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => revokeToken(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tokens"] });
      toast({ title: "Token revoked", description: "Requests using it now fail with 401." });
    },
    onError: (err: Error) => toast({ title: "Could not revoke", description: err.message, variant: "destructive" }),
  });

  const rows = tokens.data ?? [];
  const active = rows.filter((t) => !t.revokedAt && !isExpired(t));
  const inactive = rows.filter((t) => t.revokedAt || isExpired(t));

  return (
    <div className="space-y-5">
      <section className="paper p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="eyebrow text-[9px]">Personal · authentication</div>
            <h3 className="font-display text-xl tracking-tight mt-0.5 flex items-center gap-2">
              <KeyRound className="h-4 w-4" /> API tokens
            </h3>
            <p className="text-sm font-serif text-ink-muted mt-1 max-w-prose">
              Bearer credentials for the REST API and the MCP endpoint. A token carries <b>your</b> membership and role in this organization — it can never do more than you can.
            </p>
          </div>
          <span className="stamp shrink-0 font-numeric">{active.length} active</span>
        </div>
      </section>

      {minted ? (
        <section className="paper p-4 border-vermilion/40" data-testid="token-reveal">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-vermilion" />
            <span className="microcaps text-vermilion">Shown once</span>
          </div>
          <h4 className="font-display text-lg mt-1">
            <span className="italic">{minted.name}</span>
          </h4>
          <p className="text-sm font-serif text-ink-muted mt-1">
            Copy it now. The server keeps only a scrypt hash — if you lose it, revoke and mint another.
          </p>
          <div className="mt-3 space-y-2.5">
            <CopyBlock body={minted.secret} label="token" testId="minted-secret" />
            <CopyBlock body={`Authorization: Bearer ${minted.secret}`} label="request header" testId="minted-header" />
          </div>
          <button onClick={() => setMinted(null)} className="stamp mt-3 px-3 py-1.5 focus-ink" data-testid="token-reveal-done">
            I have stored it
          </button>
        </section>
      ) : (
        <section className="paper-flat">
          <div className="px-3 py-2 border-b border-rule flex items-center gap-2">
            <Plus className="h-3.5 w-3.5" />
            <span className="microcaps">Mint a token</span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) {
                toast({ title: "Name it", description: "A name is how you recognise a token later — and what you look for when revoking one.", variant: "destructive" });
                return;
              }
              mint.mutate();
            }}
            className="p-3 grid gap-2.5 sm:grid-cols-[1fr_130px_auto]"
          >
            <label className="block">
              <span className="eyebrow text-[9px]">name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Local CLI · Cursor MCP · nightly report" className="draft-input w-full mt-1 text-sm focus-ink" data-testid="token-name" />
            </label>
            <label className="block">
              <span className="eyebrow text-[9px]">expires</span>
              <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className="draft-input w-full mt-1 text-sm h-[38px] focus-ink" data-testid="token-expiry">
                {EXPIRY_CHOICES.map((c) => (
                  <option key={c.label} value={c.value}>{c.label}</option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={mint.isPending}
              className="self-end inline-flex items-center justify-center gap-2 px-4 h-[38px] border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
              data-testid="token-mint"
            >
              {mint.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
              <span className="eyebrow text-[10px] !text-current">mint</span>
            </button>
          </form>
        </section>
      )}

      <TokenList title="Active" rows={active} loading={tokens.isLoading} onRevoke={(id) => revoke.mutate(id)} testId="tokens-active" />
      {inactive.length > 0 ? <TokenList title="Revoked and expired" rows={inactive} dim onRevoke={null} testId="tokens-inactive" /> : null}
    </div>
  );
}

function isExpired(t: TokenRow): boolean {
  return !!t.expiresAt && new Date(t.expiresAt).getTime() < Date.now();
}

function TokenList({
  title, rows, loading, dim, onRevoke, testId,
}: {
  title: string;
  rows: TokenRow[];
  loading?: boolean;
  dim?: boolean;
  onRevoke: ((id: number) => void) | null;
  testId: string;
}) {
  return (
    <section className="paper-flat" data-testid={testId}>
      <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
        <span className="microcaps">{title}</span>
        <span className="eyebrow text-[9px] font-numeric">{rows.length}</span>
      </div>
      {loading ? (
        <div className="py-10 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></div>
      ) : rows.length === 0 ? (
        <p className="px-3 py-8 text-center font-serif italic text-ink-muted text-sm">No tokens here.</p>
      ) : (
        <ul className={cn("divide-y divide-rule", dim && "opacity-60")}>
          {rows.map((t) => (
            <li key={t.id} className="px-3 py-2.5 flex flex-wrap items-center gap-2" data-testid={`token-${t.id}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-serif truncate">{t.name}</span>
                  <span className="stamp border-rule font-mono normal-case tracking-normal shrink-0">ptd_{t.prefix}…</span>
                  {isExpired(t) && !t.revokedAt ? <span className="stamp border-vermilion/70 text-vermilion shrink-0">expired</span> : null}
                  {t.revokedAt ? <span className="stamp border-rule text-ink-muted shrink-0">revoked</span> : null}
                </div>
                <div className="eyebrow text-[9px] mt-0.5 font-numeric">
                  created {day(t.createdAt)}
                  <span className="mx-1.5">·</span>
                  last used {t.lastUsedAt ? day(t.lastUsedAt) : "never"}
                  <span className="mx-1.5">·</span>
                  expires {day(t.expiresAt)}
                  <span className="mx-1.5">·</span>
                  {t.scopes}
                </div>
              </div>
              {onRevoke ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button aria-label={`Revoke ${t.name}`} className="text-ink-muted hover:text-vermilion focus-ink rounded-sm p-1.5" data-testid={`token-revoke-${t.id}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="bg-card border border-ink/30 rounded-sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle className="font-display text-xl font-normal">Revoke “{t.name}”?</AlertDialogTitle>
                      <AlertDialogDescription className="font-serif">
                        Anything still using this token starts failing immediately. This cannot be undone — mint a replacement instead.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => onRevoke(t.id)} className="rounded-sm bg-vermilion text-parchment hover:bg-vermilion/90">Revoke</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
