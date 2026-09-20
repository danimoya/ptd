import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Link2, Link2Off, Loader2, MessagesSquare, ShieldCheck, TriangleAlert, Unplug } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import CopyBlock from "../CopyBlock";
import { Hint } from "../Hint";
import {
  TEAMS_COMMANDS, TEAMS_STATUS_KEY, connectTeams, disconnectTeams, getTeamsStatus,
  mintTeamsLinkCode, unlinkTeams, type TeamsLinkCode,
} from "./api";

/**
 * Microsoft Teams — an Outgoing Webhook, not a Bot Framework app.
 *
 * The secret Teams shows once at creation is the whole credential: it verifies every
 * delivery and identifies the organization. So the card's job is to take that secret,
 * hand back the callback URL Teams needs, and explain the four clicks in between.
 */
export default function TeamsCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [secret, setSecret] = useState("");
  const [teamName, setTeamName] = useState("");
  const [code, setCode] = useState<TeamsLinkCode | null>(null);

  const status = useQuery({ queryKey: TEAMS_STATUS_KEY, queryFn: getTeamsStatus });
  const invalidate = () => qc.invalidateQueries({ queryKey: TEAMS_STATUS_KEY });

  const connect = useMutation({
    mutationFn: () => connectTeams({ secret: secret.trim(), ...(teamName.trim() ? { teamName: teamName.trim() } : {}) }),
    onSuccess: (data) => {
      setSecret("");
      setTeamName("");
      invalidate();
      toast({ title: "Teams connected", description: data.next });
    },
    onError: (err: Error) => toast({ title: "Could not connect Teams", description: err.message, variant: "destructive" }),
  });

  const mint = useMutation({
    mutationFn: mintTeamsLinkCode,
    onSuccess: (data) => setCode(data),
    onError: (err: Error) => toast({ title: "Could not mint a code", description: err.message, variant: "destructive" }),
  });

  const unlink = useMutation({
    mutationFn: unlinkTeams,
    onSuccess: () => {
      setCode(null);
      invalidate();
      toast({ title: "Teams account unlinked" });
    },
    onError: (err: Error) => toast({ title: "Could not unlink", description: err.message, variant: "destructive" }),
  });

  const disconnect = useMutation({
    mutationFn: disconnectTeams,
    onSuccess: () => {
      setCode(null);
      invalidate();
      toast({ title: "Teams disconnected" });
    },
    onError: (err: Error) => toast({ title: "Could not disconnect", description: err.message, variant: "destructive" }),
  });

  const data = status.data;
  const state = !data ? "loading" : !data.connected ? "disconnected" : "connected";

  return (
    <article className="paper-flat p-4" data-testid="teams-card">
      <div className="flex items-center gap-2">
        <MessagesSquare className="h-4 w-4" />
        <span className="font-display text-lg tracking-tight">Microsoft Teams</span>
        <span
          className={cn("stamp ml-auto", state === "connected" ? "border-sage/60 text-sage" : "border-rule text-ink-muted")}
          data-testid="teams-state"
        >
          {state === "loading" ? "…" : state === "disconnected" ? "not connected" : `connected${data?.teamName ? ` · ${data.teamName}` : ""}`}
        </span>
      </div>

      <p className="text-sm font-serif text-ink-muted mt-2 max-w-prose">
        An <em>Outgoing Webhook</em> — no Azure app registration, no tenant admin, about a minute of setup by a team owner.{" "}
        <code className="font-mono text-xs">@PTD next</code> in the team runs the same registry action the web app would, as the PTD
        user that Teams account is linked to. Teams has no way for PTD to start a conversation, so this is a command surface only:
        notifications live in Slack and Telegram.
      </p>

      {status.isLoading ? (
        <div className="py-6 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></div>
      ) : status.error ? (
        <p className="py-6 text-center font-serif italic text-vermilion">{(status.error as Error).message}</p>
      ) : (
        <div className="mt-3 space-y-4">
          <div className="border-t border-rule pt-3">
            <div className="microcaps">In Teams</div>
            <ol className="mt-1 text-sm font-serif text-ink-muted space-y-0.5 list-decimal pl-4">
              <li>Team name → <span className="italic">Manage team</span> → <span className="italic">Apps</span> → <span className="italic">Create an outgoing webhook</span>.</li>
              <li>Name it <code className="font-mono text-xs">PTD</code> — the name is what people @mention.</li>
              <li>Paste the callback URL below.</li>
              <li>Teams shows a secret <span className="italic">once</span>. Copy it into the form below before closing the dialog.</li>
            </ol>
            <div className="mt-2">
              <CopyBlock body={data?.callbackUrl ?? ""} label="callback url" testId="teams-callback-url" />
            </div>
          </div>

          {state === "connected" ? (
            <div className="eyebrow text-[9px] flex flex-wrap gap-x-3 gap-y-1" data-testid="teams-connected">
              <span>team {data?.teamName ?? "—"}</span>
              {data?.connectedAt ? <span>connected {new Date(data.connectedAt).toLocaleDateString()}</span> : null}
              {data?.lastEventAt ? <span>last command {new Date(data.lastEventAt).toLocaleString()}</span> : <span>no commands yet</span>}
              {data?.lastError ? <span className="text-vermilion">{data.lastError}</span> : null}
            </div>
          ) : null}

          {data?.canManage ? (
            <form
              className="border-t border-rule pt-3 grid gap-2.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                if (!secret.trim()) return;
                connect.mutate();
              }}
              data-testid="teams-connect-form"
            >
              <label className="block">
                <span className="eyebrow text-[9px] inline-flex items-center gap-1.5">
                  webhook secret
                  <Hint text="The base64 string Teams displays when the outgoing webhook is created. PTD seals it with AES-256-GCM and never shows it again — it both verifies each delivery and identifies this organization." />
                </span>
                <input
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="base64 secret from the Teams dialog"
                  spellCheck={false}
                  autoComplete="off"
                  className="draft-input w-full mt-1 text-sm font-mono focus-ink"
                  data-testid="teams-secret"
                />
              </label>
              <label className="block">
                <span className="eyebrow text-[9px]">team name — optional</span>
                <input
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder={data?.teamName ?? "Engineering"}
                  className="draft-input w-full mt-1 text-sm focus-ink"
                  data-testid="teams-team-name"
                />
              </label>
              <button
                type="submit"
                disabled={connect.isPending || !secret.trim()}
                className="self-end inline-flex items-center justify-center gap-2 px-4 h-[38px] border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
                data-testid="teams-connect"
              >
                {connect.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                <span className="eyebrow text-[10px] !text-current">{state === "connected" ? "replace secret" : "connect"}</span>
              </button>
            </form>
          ) : state === "disconnected" ? (
            <p className="text-sm font-serif italic text-ink-muted">An admin has to connect the outgoing webhook.</p>
          ) : null}

          {state === "connected" ? (
            <>
              <div className="border-t border-rule pt-3">
                <div className="microcaps flex items-center gap-1.5">
                  {data?.linked ? <Link2 className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />} Your Teams link
                </div>
                {data?.linked ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-3">
                    <p className="text-sm font-serif text-ink-muted">
                      This PTD account answers to Entra object id <code className="font-mono text-xs">{data.aadObjectId}</code>.
                    </p>
                    <button
                      onClick={() => unlink.mutate()}
                      disabled={unlink.isPending}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-ink/40 hover:border-vermilion hover:text-vermilion transition-colors rounded-sm focus-ink disabled:opacity-60"
                      data-testid="teams-unlink"
                    >
                      {unlink.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2Off className="h-3 w-3" />}
                      <span className="eyebrow text-[9px] !text-current">unlink</span>
                    </button>
                  </div>
                ) : (
                  <div className="mt-1.5 space-y-2">
                    <p className="text-sm font-serif text-ink-muted">
                      Mint a one-time code, then @mention the webhook in Teams with it. Codes last ten minutes and work once.
                    </p>
                    <Hint text="Gives you a one-time @PTD link command, good for ten minutes, that ties your Teams account to this PTD account — after that your commands run with your role.">
                      <button
                        onClick={() => mint.mutate()}
                        disabled={mint.isPending}
                        className="inline-flex items-center gap-1.5 px-3 h-[34px] border border-ink/40 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
                        data-testid="teams-mint-code"
                      >
                        {mint.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
                        <span className="eyebrow text-[9px] !text-current">mint a link code</span>
                      </button>
                    </Hint>
                    {code ? (
                      <div className="space-y-1" data-testid="teams-link-code">
                        <CopyBlock body={code.command} label={`expires ${new Date(code.expiresAt).toLocaleTimeString()}`} testId="teams-link-command" />
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="border-t border-rule pt-3">
                <div className="microcaps">Commands</div>
                <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
                  {TEAMS_COMMANDS.map((c) => (
                    <li key={c.usage} className="text-xs font-serif text-ink-muted flex flex-wrap items-baseline gap-1.5">
                      <code className="font-mono text-[11px] text-ink">{c.usage}</code>
                      <span>{c.note}</span>
                      {c.role ? <span className="stamp border-rule text-ink-muted">{c.role}+</span> : null}
                    </li>
                  ))}
                </ul>
              </div>

              {data?.canManage ? (
                <div className="border-t border-rule pt-3">
                  <AlertDialog>
                    <Hint text="Asks first, then destroys the stored secret. Delete the webhook in Teams too, or it keeps posting to a URL that now refuses it.">
                      <AlertDialogTrigger asChild>
                        <button
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-ink/40 text-ink-muted hover:border-vermilion hover:text-vermilion transition-colors rounded-sm focus-ink"
                          data-testid="teams-disconnect"
                        >
                          <Unplug className="h-3 w-3" />
                          <span className="eyebrow text-[9px] !text-current">disconnect</span>
                        </button>
                      </AlertDialogTrigger>
                    </Hint>
                    <AlertDialogContent className="bg-card border border-ink/30 rounded-sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="font-display text-xl font-normal">Disconnect Microsoft Teams?</AlertDialogTitle>
                        <AlertDialogDescription className="font-serif">
                          The sealed secret is destroyed and <code className="font-mono text-xs">@PTD …</code> commands from{" "}
                          {data?.teamName ?? "that team"} stop being recognised. Members keep their link records. Remember to delete
                          the outgoing webhook in Teams as well.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => disconnect.mutate()} className="rounded-sm bg-vermilion text-parchment hover:bg-vermilion/90">
                          Disconnect
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ) : null}
            </>
          ) : null}

          {state === "disconnected" ? (
            <p className="eyebrow text-[9px]">
              <TriangleAlert className="h-3 w-3 inline -mt-0.5 mr-1" />
              nothing is stored until a secret is saved — PTD refuses every delivery it cannot verify
            </p>
          ) : null}
        </div>
      )}
    </article>
  );
}
