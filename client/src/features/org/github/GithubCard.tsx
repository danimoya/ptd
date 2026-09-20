import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ArrowLeftRight, ArrowRight, Check, Github, Link2Off, Loader2, RefreshCw, TriangleAlert, Unplug } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import CopyBlock from "../CopyBlock";
import { Hint } from "../Hint";
import {
  DIRECTION_NOTES, GITHUB_STATUS_KEY, disconnectGithub, getGithubStatus, githubInstallUrl,
  listStreamOptions, mapGithubStream, syncGithubNow, unmapGithubStream,
  type GithubSyncSummary, type SyncDirection,
} from "./api";

const ENV_SNIPPET = `# .env — create the App at https://github.com/settings/apps/new first
#   permissions: Issues read & write, Metadata read
#   subscribe to: Issues, Issue comment
#   setup URL: https://ptd.example.com/api/integrations/github/setup
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_WEBHOOK_SECRET=
# base64 of the .pem GitHub gave you: base64 -w0 ptd.private-key.pem
GITHUB_APP_PRIVATE_KEY=
PTD_BASE_URL=https://ptd.example.com`;

const DIRECTIONS: SyncDirection[] = ["both", "in", "out"];

/**
 * GitHub — issues and tasks as one card, keyed on `externalKey`.
 *
 * Three states, and the card says which one it is in rather than offering a button that
 * cannot work: the server has no GitHub App configured, the App exists but this
 * organization has not installed it, or an installation is mapped to repositories.
 */
export default function GithubCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const [streamId, setStreamId] = useState("");
  const [repo, setRepo] = useState("");
  const [direction, setDirection] = useState<SyncDirection>("both");
  const [synced, setSynced] = useState<GithubSyncSummary | null>(null);

  const status = useQuery({ queryKey: GITHUB_STATUS_KEY, queryFn: getGithubStatus });
  const streams = useQuery({ queryKey: ["/api/actions/stream.list", "github"], queryFn: listStreamOptions, enabled: !!status.data?.connected });
  const invalidate = () => qc.invalidateQueries({ queryKey: GITHUB_STATUS_KEY });

  // The post-install redirect lands back here with the outcome in the query string.
  const outcome = params.get("github");
  useEffect(() => {
    if (!outcome) return;
    if (outcome === "connected") toast({ title: "GitHub installed", description: "Map a stream to a repository to start syncing." });
    else toast({ title: "GitHub could not be installed", description: params.get("reason") ?? outcome, variant: "destructive" });
    const next = new URLSearchParams(params);
    next.delete("github");
    next.delete("reason");
    setParams(next, { replace: true });
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const install = useMutation({
    mutationFn: githubInstallUrl,
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err: Error) => toast({ title: "Could not start the GitHub install", description: err.message, variant: "destructive" }),
  });

  const map = useMutation({
    mutationFn: () => mapGithubStream({ streamId: Number(streamId), repo: repo.trim(), direction }),
    onSuccess: (data) => {
      setRepo("");
      setStreamId("");
      invalidate();
      toast({ title: "Mapped", description: `${data.repo} is now synced` });
    },
    onError: (err: Error) => toast({ title: "Could not map that repository", description: err.message, variant: "destructive" }),
  });

  const unmap = useMutation({
    mutationFn: (id: number) => unmapGithubStream(id),
    onSuccess: () => {
      invalidate();
      toast({ title: "Unmapped" });
    },
    onError: (err: Error) => toast({ title: "Could not unmap", description: err.message, variant: "destructive" }),
  });

  const sync = useMutation({
    mutationFn: (id: number) => syncGithubNow(id),
    onSuccess: (summary) => {
      setSynced(summary);
      invalidate();
      if (summary.errors.length > 0) {
        toast({ title: "Synced with problems", description: summary.errors[0], variant: "destructive" });
      } else {
        toast({ title: "Synced", description: `${summary.issues} open issue${summary.issues === 1 ? "" : "s"} · ${summary.created} new card${summary.created === 1 ? "" : "s"}` });
      }
    },
    onError: (err: Error) => toast({ title: "Could not sync", description: err.message, variant: "destructive" }),
  });

  const disconnect = useMutation({
    mutationFn: disconnectGithub,
    onSuccess: () => {
      setSynced(null);
      invalidate();
      toast({ title: "GitHub disconnected" });
    },
    onError: (err: Error) => toast({ title: "Could not disconnect", description: err.message, variant: "destructive" }),
  });

  const data = status.data;
  const state = !data ? "loading" : !data.appConfigured ? "unconfigured" : !data.connected ? "disconnected" : "connected";
  const options = (streams.data ?? []).filter((s) => !data?.mappings.some((m) => m.streamId === s.id));

  return (
    <article className="paper-flat p-4" data-testid="github-card">
      <div className="flex items-center gap-2">
        <Github className="h-4 w-4" />
        <span className="font-display text-lg tracking-tight">GitHub</span>
        <span
          className={cn("stamp ml-auto", state === "connected" ? "border-sage/60 text-sage" : "border-rule text-ink-muted")}
          data-testid="github-state"
        >
          {state === "loading"
            ? "…"
            : state === "unconfigured"
              ? "not configured"
              : state === "disconnected"
                ? "not installed"
                : `installed · ${data?.account?.login ?? data?.installationId}`}
        </span>
      </div>

      <p className="text-sm font-serif text-ink-muted mt-2 max-w-prose">
        Map a stream to a repository and an issue and a card become one thing, joined by{" "}
        <code className="font-mono text-xs">externalKey</code> —{" "}
        <code className="font-mono text-xs">gh:owner/name#12</code>. Labels arrive as tags, a milestone's due date as the card's
        due date, a close as a completion; a new card in a mapped stream opens the issue. Every write goes through the same
        registry actions the web app uses, as the admin who mapped the repository.
      </p>

      {status.isLoading ? (
        <div className="py-6 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></div>
      ) : status.error ? (
        <p className="py-6 text-center font-serif italic text-vermilion">{(status.error as Error).message}</p>
      ) : state === "unconfigured" ? (
        <div className="mt-3 space-y-2" data-testid="github-unconfigured">
          <p className="text-sm font-serif">
            <TriangleAlert className="h-3.5 w-3.5 inline -mt-0.5 mr-1 text-vermilion" />
            GitHub app not configured on this server.
          </p>
          <p className="eyebrow text-[9px]">
            missing: {(data?.missingEnv ?? []).map((v) => <code key={v} className="font-mono mr-1.5">{v}</code>)}
          </p>
          <CopyBlock body={ENV_SNIPPET} label=".env" testId="github-env" />
        </div>
      ) : state === "disconnected" ? (
        <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="github-disconnected">
          {data?.canManage ? (
            <button
              onClick={() => install.mutate()}
              disabled={install.isPending}
              className="inline-flex items-center gap-2 px-4 h-[38px] border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
              data-testid="github-install"
            >
              {install.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Github className="h-3.5 w-3.5" />}
              <span className="eyebrow text-[10px] !text-current">install on github</span>
            </button>
          ) : (
            <p className="text-sm font-serif italic text-ink-muted">An admin has to install the app.</p>
          )}
          <span className="eyebrow text-[9px]">
            permissions: issues read/write · metadata read — events: {(data?.events ?? []).join(", ")}
          </span>
        </div>
      ) : (
        <div className="mt-3 space-y-4" data-testid="github-connected">
          <div className="eyebrow text-[9px] flex flex-wrap gap-x-3 gap-y-1">
            <span>account {data?.account?.login ?? "—"}</span>
            <span>installation {data?.installationId}</span>
            {data?.installedAt ? <span>installed {new Date(data.installedAt).toLocaleDateString()}</span> : null}
            {data?.lastEventAt ? <span>last event {new Date(data.lastEventAt).toLocaleString()}</span> : <span>no events yet</span>}
          </div>
          {data?.lastError ? (
            <p className="text-xs font-serif text-vermilion" data-testid="github-last-error">
              <TriangleAlert className="h-3.5 w-3.5 inline -mt-0.5 mr-1" />
              {data.lastError}
            </p>
          ) : null}

          <div className="border-t border-rule pt-3">
            <div className="microcaps flex items-center gap-1.5">
              Mappings
              <Hint text="One stream to one repository. A repository can only belong to one stream, so its issues always have one home." />
            </div>
            {(data?.mappings ?? []).length === 0 ? (
              <p className="text-sm font-serif italic text-ink-muted mt-1">No repositories mapped yet.</p>
            ) : (
              <ul className="mt-1.5 divide-y divide-rule" data-testid="github-mappings">
                {(data?.mappings ?? []).map((m) => (
                  <li key={m.streamId} className="py-2 flex flex-wrap items-center gap-2" data-testid={`github-mapping-${m.streamId}`}>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-serif flex items-center gap-1.5 flex-wrap">
                        <span>{m.streamName ?? `stream #${m.streamId}`}</span>
                        {m.direction === "both" ? <ArrowLeftRight className="h-3 w-3 text-ink-muted" /> : <ArrowRight className={cn("h-3 w-3 text-ink-muted", m.direction === "in" && "rotate-180")} />}
                        <a href={m.url} target="_blank" rel="noreferrer" className="font-mono text-xs underline decoration-dotted">{m.repo}</a>
                      </div>
                      <div className="eyebrow text-[9px] mt-0.5 flex flex-wrap gap-x-2">
                        <span>{DIRECTION_NOTES[m.direction]}</span>
                        {m.lastSyncAt ? <span>synced {new Date(m.lastSyncAt).toLocaleString()}</span> : <span>never synced</span>}
                        {m.lastImported !== null ? <span>{m.lastImported} open issues</span> : null}
                        {m.lastError ? <span className="text-vermilion">{m.lastError}</span> : null}
                      </div>
                    </div>
                    {data?.canManage ? (
                      <>
                        <Hint text="Pulls every open issue now and upserts it as a task. Idempotent — run it twice and nothing changes the second time.">
                          <button
                            onClick={() => sync.mutate(m.streamId)}
                            disabled={sync.isPending || m.direction === "out"}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-ink/40 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
                            data-testid={`github-sync-${m.streamId}`}
                          >
                            {sync.isPending && sync.variables === m.streamId ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                            <span className="eyebrow text-[9px] !text-current">sync now</span>
                          </button>
                        </Hint>
                        <button
                          onClick={() => unmap.mutate(m.streamId)}
                          disabled={unmap.isPending}
                          aria-label={`Unmap ${m.repo}`}
                          className="text-ink-muted hover:text-vermilion focus-ink rounded-sm p-1.5"
                          data-testid={`github-unmap-${m.streamId}`}
                        >
                          <Link2Off className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {synced ? (
              <div className={cn("mt-2 flex items-center gap-1.5 text-xs font-serif", synced.errors.length === 0 ? "text-sage" : "text-vermilion")} data-testid="github-sync-result">
                {synced.errors.length === 0 ? <Check className="h-3.5 w-3.5" /> : <TriangleAlert className="h-3.5 w-3.5" />}
                {synced.errors.length === 0
                  ? `${synced.repo}: ${synced.issues} open issues · ${synced.created} created · ${synced.updated} updated`
                  : `${synced.repo}: ${synced.errors[0]}`}
              </div>
            ) : null}
          </div>

          {data?.canManage ? (
            <form
              className="border-t border-rule pt-3 grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                if (!streamId || !repo.trim()) return;
                map.mutate();
              }}
            >
              <label className="block">
                <span className="eyebrow text-[9px]">stream</span>
                <select
                  value={streamId}
                  onChange={(e) => setStreamId(e.target.value)}
                  className="draft-input w-full mt-1 text-sm focus-ink"
                  data-testid="github-stream"
                >
                  <option value="">choose…</option>
                  {options.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="eyebrow text-[9px]">repository</span>
                <input
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="owner/name"
                  spellCheck={false}
                  className="draft-input w-full mt-1 text-sm font-mono focus-ink"
                  data-testid="github-repo"
                />
              </label>
              <label className="block">
                <span className="eyebrow text-[9px]">direction</span>
                <select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as SyncDirection)}
                  className="draft-input w-full mt-1 text-sm focus-ink"
                  data-testid="github-direction"
                >
                  {DIRECTIONS.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={map.isPending || !streamId || !repo.trim()}
                className="self-end inline-flex items-center justify-center gap-2 px-4 h-[38px] border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
                data-testid="github-map"
              >
                {map.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span className="eyebrow text-[10px] !text-current">map</span>
              </button>
              <p className="sm:col-span-4 text-xs font-serif italic text-ink-muted">{DIRECTION_NOTES[direction]}</p>
            </form>
          ) : null}

          <div className="border-t border-rule pt-3">
            <div className="microcaps">Webhook</div>
            <p className="text-xs font-serif italic text-ink-muted mt-0.5">
              The App must deliver <code className="font-mono">issues</code> and <code className="font-mono">issue_comment</code> here, signed with{" "}
              <code className="font-mono">GITHUB_WEBHOOK_SECRET</code>.
            </p>
            <div className="mt-2">
              <CopyBlock body={data?.webhookUrl ?? ""} label="webhook url" testId="github-webhook-url" />
            </div>
          </div>

          {data?.canManage ? (
            <div className="border-t border-rule pt-3">
              <AlertDialog>
                <Hint text="Asks first, then forgets the installation and every mapping. Cards keep their externalKey, and the App stays installed on GitHub until you remove it there.">
                  <AlertDialogTrigger asChild>
                    <button
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-ink/40 text-ink-muted hover:border-vermilion hover:text-vermilion transition-colors rounded-sm focus-ink"
                      data-testid="github-disconnect"
                    >
                      <Unplug className="h-3 w-3" />
                      <span className="eyebrow text-[9px] !text-current">disconnect</span>
                    </button>
                  </AlertDialogTrigger>
                </Hint>
                <AlertDialogContent className="bg-card border border-ink/30 rounded-sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="font-display text-xl font-normal">Disconnect GitHub?</AlertDialogTitle>
                    <AlertDialogDescription className="font-serif">
                      PTD forgets the installation and its {data?.mappings.length ?? 0} mapping{(data?.mappings.length ?? 0) === 1 ? "" : "s"}. Issues and cards
                      are left exactly as they are, and the App stays installed on GitHub until someone removes it there.
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
