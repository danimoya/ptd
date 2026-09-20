import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Check, KeyRound, Link2, Link2Off, Loader2, Send, Slack, TriangleAlert, Unplug } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import CopyBlock from "../CopyBlock";
import { Hint } from "../Hint";
import {
  SLACK_STATUS_KEY, SLASH_COMMANDS, disconnectSlack, getSlackStatus, mintSlackLinkCode,
  setSlackChannel, slackInstallUrl, testSlack, unlinkSlack, type SlackLinkCode, type SlackTestResult,
} from "./api";

const ENV_SNIPPET = `# .env — create the app at https://api.slack.com/apps first
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_SIGNING_SECRET=
PTD_BASE_URL=https://ptd.example.com`;

/**
 * Slack — the third adapter over the action registry, next to MCP and REST.
 *
 * Three states, and the card says which one it is in rather than offering a button
 * that cannot work: the server has no Slack app configured, the app exists but this
 * organization has not connected a workspace, or a workspace is connected.
 */
export default function SlackCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const [channel, setChannel] = useState("");
  const [code, setCode] = useState<SlackLinkCode | null>(null);
  const [probe, setProbe] = useState<SlackTestResult | null>(null);

  const status = useQuery({ queryKey: SLACK_STATUS_KEY, queryFn: getSlackStatus });
  const invalidate = () => qc.invalidateQueries({ queryKey: SLACK_STATUS_KEY });

  // The OAuth callback lands back here with the outcome in the query string.
  const outcome = params.get("slack");
  useEffect(() => {
    if (!outcome) return;
    if (outcome === "connected") toast({ title: "Slack connected", description: "Pick a channel and tell your team to run /ptd link." });
    else toast({ title: "Slack could not be connected", description: params.get("reason") ?? outcome, variant: "destructive" });
    const next = new URLSearchParams(params);
    next.delete("slack");
    next.delete("reason");
    setParams(next, { replace: true });
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const install = useMutation({
    mutationFn: slackInstallUrl,
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err: Error) => toast({ title: "Could not start the Slack install", description: err.message, variant: "destructive" }),
  });

  const saveChannel = useMutation({
    mutationFn: () => setSlackChannel(channel.trim()),
    onSuccess: (data) => {
      setChannel("");
      invalidate();
      toast({ title: "Channel set", description: data.channelId });
    },
    onError: (err: Error) => toast({ title: "Could not set the channel", description: err.message, variant: "destructive" }),
  });

  const sendTest = useMutation({
    mutationFn: testSlack,
    onSuccess: (result) => {
      setProbe(result);
      if (result.posted) toast({ title: "Posted to Slack", description: result.channel ?? "" });
      else toast({ title: "Slack refused the message", description: result.error ?? "unknown error", variant: "destructive" });
    },
    onError: (err: Error) => toast({ title: "Could not post to Slack", description: err.message, variant: "destructive" }),
  });

  const mint = useMutation({
    mutationFn: mintSlackLinkCode,
    onSuccess: (data) => setCode(data),
    onError: (err: Error) => toast({ title: "Could not mint a code", description: err.message, variant: "destructive" }),
  });

  const unlink = useMutation({
    mutationFn: unlinkSlack,
    onSuccess: () => {
      setCode(null);
      invalidate();
      toast({ title: "Slack account unlinked" });
    },
    onError: (err: Error) => toast({ title: "Could not unlink", description: err.message, variant: "destructive" }),
  });

  const disconnect = useMutation({
    mutationFn: disconnectSlack,
    onSuccess: () => {
      setProbe(null);
      setCode(null);
      invalidate();
      toast({ title: "Slack disconnected" });
    },
    onError: (err: Error) => toast({ title: "Could not disconnect", description: err.message, variant: "destructive" }),
  });

  const data = status.data;
  const state = !data ? "loading" : !data.appConfigured ? "unconfigured" : !data.connected ? "disconnected" : "connected";

  return (
    <article className="paper-flat p-4" data-testid="slack-card">
      <div className="flex items-center gap-2">
        <Slack className="h-4 w-4" />
        <span className="font-display text-lg tracking-tight">Slack</span>
        <span
          className={cn("stamp ml-auto", state === "connected" ? "border-sage/60 text-sage" : "border-rule text-ink-muted")}
          data-testid="slack-state"
        >
          {state === "loading" ? "…" : state === "unconfigured" ? "not configured" : state === "disconnected" ? "not connected" : `connected · ${data?.teamName ?? data?.teamId}`}
        </span>
      </div>

      <p className="text-sm font-serif text-ink-muted mt-2 max-w-prose">
        Slash commands run the same registry actions as the web app, as the PTD user the Slack account is linked to and with that user's role — so <code className="font-mono text-xs">/ptd stats</code> works for a manager and politely refuses a member. Assignments arrive as a DM; completions, cascade shifts and agent-budget alerts go to one channel.
      </p>

      {status.isLoading ? (
        <div className="py-6 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></div>
      ) : status.error ? (
        <p className="py-6 text-center font-serif italic text-vermilion">{(status.error as Error).message}</p>
      ) : state === "unconfigured" ? (
        <div className="mt-3 space-y-2" data-testid="slack-unconfigured">
          <p className="text-sm font-serif">
            <TriangleAlert className="h-3.5 w-3.5 inline -mt-0.5 mr-1 text-vermilion" />
            Slack app not configured on this server.
          </p>
          <p className="eyebrow text-[9px]">
            create one at api.slack.com/apps with the <code className="font-mono">commands</code>, <code className="font-mono">chat:write</code>, <code className="font-mono">users:read</code> and <code className="font-mono">users:read.email</code> bot scopes, then restart PTD with:
          </p>
          <CopyBlock body={ENV_SNIPPET} label=".env" testId="slack-env" />
        </div>
      ) : state === "disconnected" ? (
        <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="slack-disconnected">
          {data?.canManage ? (
            <button
              onClick={() => install.mutate()}
              disabled={install.isPending}
              className="inline-flex items-center gap-2 px-4 h-[38px] border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
              data-testid="slack-install"
            >
              {install.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Slack className="h-3.5 w-3.5" />}
              <span className="eyebrow text-[10px] !text-current">add to slack</span>
            </button>
          ) : (
            <p className="text-sm font-serif italic text-ink-muted">An admin has to connect the workspace.</p>
          )}
          <span className="eyebrow text-[9px]">scopes: {(data?.scopes ?? []).join(", ")}</span>
        </div>
      ) : (
        <div className="mt-3 space-y-4" data-testid="slack-connected">
          <div className="eyebrow text-[9px] flex flex-wrap gap-x-3 gap-y-1">
            <span>workspace {data?.teamName ?? "—"} ({data?.teamId})</span>
            <span>bot {data?.botUserId ?? "—"}</span>
            <span>channel {data?.channelId ?? "none yet"}</span>
            {data?.installedAt ? <span>installed {new Date(data.installedAt).toLocaleDateString()}</span> : null}
          </div>

          {data?.canManage ? (
            <div className="border-t border-rule pt-3">
              <div className="microcaps">Notification channel</div>
              <p className="text-xs font-serif italic text-ink-muted mt-0.5">
                Invite the PTD bot to the channel first — Slack will not post into a channel its app is not in. Copy the id from the channel's About tab.
              </p>
              <form
                className="mt-2 flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (channel.trim()) saveChannel.mutate();
                }}
              >
                <label className="block flex-1 min-w-[180px]">
                  <span className="eyebrow text-[9px]">channel id</span>
                  <input
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                    placeholder={data?.channelId ?? "C0123456789"}
                    spellCheck={false}
                    className="draft-input w-full mt-1 text-sm font-mono focus-ink"
                    data-testid="slack-channel-input"
                  />
                </label>
                <button
                  type="submit"
                  disabled={saveChannel.isPending || !channel.trim()}
                  className="inline-flex items-center gap-1.5 px-3 h-[34px] border border-ink/40 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
                  data-testid="slack-channel-save"
                >
                  {saveChannel.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  <span className="eyebrow text-[9px] !text-current">save</span>
                </button>
                <Hint text="Posts one real test message to the saved channel now. If the bot is not in that channel, Slack refuses and the error says so.">
                  <button
                    type="button"
                    onClick={() => sendTest.mutate()}
                    disabled={sendTest.isPending || !data?.channelId}
                    className="inline-flex items-center gap-1.5 px-3 h-[34px] border border-ink/40 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
                    data-testid="slack-test"
                  >
                    {sendTest.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                    <span className="eyebrow text-[9px] !text-current">test</span>
                  </button>
                </Hint>
              </form>
              {probe ? (
                <div className={cn("mt-2 flex items-center gap-1.5 text-xs font-serif", probe.posted ? "text-sage" : "text-vermilion")} data-testid="slack-test-result">
                  {probe.posted ? <Check className="h-3.5 w-3.5" /> : <TriangleAlert className="h-3.5 w-3.5" />}
                  {probe.posted ? `posted to ${probe.channel}` : `failed · ${probe.error}`}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="border-t border-rule pt-3">
            <div className="microcaps flex items-center gap-1.5">
              {data?.linked ? <Link2 className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />} Your Slack link
            </div>
            {data?.linked ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                <p className="text-sm font-serif text-ink-muted">
                  This PTD account answers to Slack user <code className="font-mono text-xs">{data.slackUserId}</code> in {data.teamName ?? "the workspace"}.
                </p>
                <button
                  onClick={() => unlink.mutate()}
                  disabled={unlink.isPending}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-ink/40 hover:border-vermilion hover:text-vermilion transition-colors rounded-sm focus-ink disabled:opacity-60"
                  data-testid="slack-unlink"
                >
                  {unlink.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2Off className="h-3 w-3" />}
                  <span className="eyebrow text-[9px] !text-current">unlink</span>
                </button>
              </div>
            ) : (
              <div className="mt-1.5 space-y-2">
                <p className="text-sm font-serif text-ink-muted">
                  Mint a one-time code, then run the command it gives you in Slack. Codes last ten minutes and work once.
                </p>
                <Hint text="Gives you a one-time /ptd link command, good for ten minutes, that ties your Slack user to this PTD account — after that your slash commands run with your role.">
                  <button
                    onClick={() => mint.mutate()}
                    disabled={mint.isPending}
                    className="inline-flex items-center gap-1.5 px-3 h-[34px] border border-ink/40 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
                    data-testid="slack-mint-code"
                  >
                    {mint.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
                    <span className="eyebrow text-[9px] !text-current">mint a link code</span>
                  </button>
                </Hint>
                {code ? (
                  <div className="space-y-1" data-testid="slack-link-code">
                    <CopyBlock body={code.command} label={`expires ${new Date(code.expiresAt).toLocaleTimeString()}`} testId="slack-link-command" />
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="border-t border-rule pt-3">
            <div className="microcaps">Commands</div>
            <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
              {SLASH_COMMANDS.map((c) => (
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
                <Hint text="Asks first, then unhooks the whole workspace: notifications stop and every /ptd command fails until someone re-installs the app.">
                  <AlertDialogTrigger asChild>
                    <button
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-ink/40 text-ink-muted hover:border-vermilion hover:text-vermilion transition-colors rounded-sm focus-ink"
                      data-testid="slack-disconnect"
                    >
                      <Unplug className="h-3 w-3" />
                      <span className="eyebrow text-[9px] !text-current">disconnect</span>
                    </button>
                  </AlertDialogTrigger>
                </Hint>
                <AlertDialogContent className="bg-card border border-ink/30 rounded-sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="font-display text-xl font-normal">Disconnect Slack?</AlertDialogTitle>
                    <AlertDialogDescription className="font-serif">
                      The sealed bot token is destroyed, notifications stop and slash commands from {data?.teamName ?? "the workspace"} stop working. Members keep their link records, so a re-install picks up where it left off.
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
        </div>
      )}
    </article>
  );
}
