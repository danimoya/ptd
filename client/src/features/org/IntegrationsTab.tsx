import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus, Send, ShieldAlert, Trash2, TriangleAlert, Webhook } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import CopyBlock from "./CopyBlock";
import Explainer from "./Explainer";
import { Hint } from "./Hint";
import { createWebhook, deleteWebhook, listWebhooks, testWebhook, type CreatedWebhook, type WebhookTestResult } from "./api";
import { ALL_EVENT_KINDS, EVENT_GROUPS, parseEvents, unknownEvents } from "./events";
import SlackCard from "./slack/SlackCard";
import GithubCard from "./github/GithubCard";
import TelegramCard from "./telegram/TelegramCard";
import TeamsCard from "./teams/TeamsCard";

const EXAMPLE_ENVELOPE = JSON.stringify(
  { event: "task.completed", orgId: 1, taskId: 42, actor: { userId: 7, label: "Nightly Triage Bot", isAgent: true }, payload: { status: "completed" }, ts: "2026-09-19T09:00:00.000Z" },
  null,
  2,
);

const VERIFY_SNIPPET = `// Verify the signature before trusting the body.
import { createHmac, timingSafeEqual } from "crypto";

function verify(rawBody, header, secret) {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(header ?? ""), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}`;

/** Webhooks, Slack, GitHub, Telegram and Teams — every one of them live. */
export default function IntegrationsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("");
  const [secret, setSecret] = useState("");
  const [created, setCreated] = useState<CreatedWebhook | null>(null);
  const [results, setResults] = useState<Record<number, WebhookTestResult>>({});

  const hooks = useQuery({ queryKey: ["/api/actions/webhook.list"], queryFn: listWebhooks });

  const create = useMutation({
    mutationFn: () =>
      createWebhook({
        url: url.trim(),
        secret: secret.trim() || undefined,
        events: events.trim() ? parseEvents(events) : undefined,
      }),
    onSuccess: (data) => {
      setCreated(data);
      setUrl("");
      setEvents("");
      setSecret("");
      qc.invalidateQueries({ queryKey: ["/api/actions/webhook.list"] });
    },
    onError: (err: Error) => toast({ title: "Could not create webhook", description: err.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => deleteWebhook(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/actions/webhook.list"] });
      toast({ title: "Webhook removed" });
    },
    onError: (err: Error) => toast({ title: "Could not remove webhook", description: err.message, variant: "destructive" }),
  });

  const probe = useMutation({
    mutationFn: (id: number) => testWebhook(id),
    onSuccess: (result) => {
      setResults((r) => ({ ...r, [result.id]: result }));
      if (result.delivered) toast({ title: "Ping delivered", description: `HTTP ${result.status}` });
      else toast({ title: "Ping failed", description: result.error ?? `HTTP ${result.status}`, variant: "destructive" });
    },
    onError: (err: Error) => toast({ title: "Could not send ping", description: err.message, variant: "destructive" }),
  });

  const rows = hooks.data ?? [];
  const unknown = unknownEvents(events);

  return (
    <div className="space-y-5">
      <Explainer
        testId="integrations-explainer"
        why={
          <>
            This is how PTD tells the rest of your tools what just happened, so nobody has to copy a status across by hand. A
            webhook POSTs every task event to a URL you own — n8n, Zapier, Make, a GitHub Action — while Slack, Telegram and
            Teams put the work where your team already talks, and GitHub keeps issues and cards as one thing. They all run the
            other way too: a <code className="font-mono text-xs">/ptd</code> command, a{" "}
            <code className="font-mono text-xs">/next</code>, an <code className="font-mono text-xs">@PTD today</code> or an
            imported issue acts as whoever linked the account, with that person's role, so connecting a workspace or a
            repository never widens what anyone may do.
          </>
        }
        technical={
          <>
            <li>
              Each event is a JSON POST carrying <code>X-PTD-Signature: sha256=…</code>, the HMAC-SHA256 of the exact raw body
              keyed with your secret. Verify it before trusting anything in the payload.
            </li>
            <li>
              The signing secret is shown once and sealed with AES-256-GCM at rest (server key <code>PTD_SECRET_KEY</code>), so
              PTD can sign with it but never display it again.
            </li>
            <li>
              Delivery is fire-and-forget with a 5 second timeout — a slow or dead subscriber never holds up the task that
              triggered it, and there is no retry queue.
            </li>
            <li>Subscribe to everything or name the kinds you want; an unknown kind is accepted and then never delivered.</li>
            <li>
              Chat commands run the same registry actions as this web app, as the linked PTD user and with their role — one
              vocabulary, three surfaces: <code>/ptd next</code> in Slack, <code>/next</code> in Telegram,{" "}
              <code>@PTD next</code> in Teams. Linking is always a one-time code that lasts ten minutes.
            </li>
            <li>
              Every inbound delivery is verified before it is trusted: Slack's <code>v0=</code> signature, GitHub's{" "}
              <code>X-Hub-Signature-256</code>, Teams' <code>Authorization: HMAC …</code>, and for Telegram a webhook path whose
              secret is derived from <code>PTD_SECRET_KEY</code> and the bot token.
            </li>
            <li>
              GitHub joins an issue to a card through <code>externalKey</code> — <code>gh:owner/name#12</code> — so an import is
              idempotent and a replayed delivery changes nothing. Anything PTD writes because of GitHub is marked{" "}
              <code>via: github</code>, which is what stops the two sides echoing each other.
            </li>
            <li>
              Server-side configuration: Slack needs <code>SLACK_CLIENT_ID</code>, <code>SLACK_CLIENT_SECRET</code> and{" "}
              <code>SLACK_SIGNING_SECRET</code>; GitHub needs <code>GITHUB_APP_ID</code>, <code>GITHUB_APP_PRIVATE_KEY</code>,{" "}
              <code>GITHUB_APP_SLUG</code> and <code>GITHUB_WEBHOOK_SECRET</code>; Telegram needs <code>TELEGRAM_BOT_TOKEN</code>.
              Teams needs nothing on the server — its outgoing webhook is created inside Teams.
            </li>
          </>
        }
      />

      <section className="paper p-4">
        <div className="eyebrow text-[9px]">Outgoing</div>
        <h3 className="font-display text-xl tracking-tight mt-0.5 flex items-center gap-2">
          <Webhook className="h-4 w-4" /> Webhooks
        </h3>
        <p className="text-sm font-serif text-ink-muted mt-1 max-w-prose">
          Every task event is POSTed as JSON with an <code className="font-mono text-xs">X-PTD-Signature</code> header — <code className="font-mono text-xs">sha256=</code> followed by the HMAC-SHA256 of the exact raw body, keyed with your secret. Delivery is fire-and-forget with a 5 second timeout, so a slow subscriber never slows a task down.
        </p>
        <div className="grid gap-3 lg:grid-cols-2 mt-3 min-w-0">
          <CopyBlock body={EXAMPLE_ENVELOPE} label="envelope" testId="webhook-envelope" />
          <CopyBlock body={VERIFY_SNIPPET} label="verify (node)" testId="webhook-verify" />
        </div>
      </section>

      {created ? (
        <section className="paper p-4 border-vermilion/40" data-testid="webhook-created">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-vermilion" />
            <span className="microcaps text-vermilion">Secret shown once</span>
          </div>
          <p className="text-sm font-serif text-ink-muted mt-1">{created.note}</p>
          <div className="mt-3 space-y-2.5">
            <CopyBlock body={created.secret} label={`signing secret for ${created.url}`} testId="webhook-secret" />
          </div>
          <button onClick={() => setCreated(null)} className="stamp mt-3 px-3 py-1.5 focus-ink" data-testid="webhook-created-done">
            I have stored it
          </button>
        </section>
      ) : (
        <section className="paper-flat">
          <div className="px-3 py-2 border-b border-rule flex items-center gap-2">
            <Plus className="h-3.5 w-3.5" />
            <span className="microcaps">Add a webhook</span>
            <Hint text="Saves the subscription and shows its signing secret once. Events start being POSTed to that URL as soon as it is saved." />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!url.trim()) return;
              create.mutate();
            }}
            className="p-3 grid gap-2.5 sm:grid-cols-[1fr_180px_auto]"
          >
            <label className="block sm:col-span-1">
              <span className="eyebrow text-[9px]">endpoint url</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/ptd" className="draft-input w-full mt-1 text-sm font-mono focus-ink" data-testid="webhook-url" />
            </label>
            <label className="block">
              <span className="eyebrow text-[9px]">events — blank for all</span>
              <input
                value={events}
                onChange={(e) => setEvents(e.target.value)}
                placeholder="task.created, task.completed"
                list="ptd-event-kinds"
                className="draft-input w-full mt-1 text-sm font-mono focus-ink"
                data-testid="webhook-events"
              />
              <datalist id="ptd-event-kinds">
                {ALL_EVENT_KINDS.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </label>
            <button
              type="submit"
              disabled={create.isPending || !url.trim()}
              className="self-end inline-flex items-center justify-center gap-2 px-4 h-[38px] border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
              data-testid="webhook-create"
            >
              {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              <span className="eyebrow text-[10px] !text-current">add</span>
            </button>
            <label className="block sm:col-span-3">
              <span className="eyebrow text-[9px] inline-flex items-center gap-1.5">
                signing secret — leave blank and one is generated for you
                <Hint text="The key your endpoint uses to verify X-PTD-Signature. Shown once when the webhook is created, then sealed at rest — PTD cannot read it back to you." />
              </span>
              <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="whsec_…" spellCheck={false} autoComplete="off" className="draft-input w-full mt-1 text-sm font-mono focus-ink" data-testid="webhook-secret-input" />
            </label>

            <div className="sm:col-span-3 border-t border-rule pt-3 space-y-2">
              {unknown.length > 0 ? (
                <p className="text-xs font-serif italic text-vermilion" data-testid="webhook-unknown-events">
                  Nothing currently emits {unknown.map((k) => `“${k}”`).join(", ")} — it will be accepted but never delivered.
                </p>
              ) : null}
              {EVENT_GROUPS.map((g) => (
                <div key={g.label}>
                  <div className="eyebrow text-[9px]">{g.label}</div>
                  <p className="text-xs font-serif italic text-ink-muted">{g.note}</p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {g.kinds.map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setEvents((cur) => (parseEvents(cur).includes(k) ? cur : [...parseEvents(cur), k].join(", ")))}
                        className="stamp border-rule text-ink-muted normal-case tracking-normal font-mono hover:border-ink hover:text-ink transition-colors focus-ink"
                        data-testid={`event-kind-${k}`}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </form>
        </section>
      )}

      <section className="paper-flat" data-testid="webhook-list">
        <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
          <span className="microcaps">Subscriptions</span>
          <span className="eyebrow text-[9px] font-numeric">{rows.length}</span>
        </div>
        {hooks.isLoading ? (
          <div className="py-10 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></div>
        ) : hooks.error ? (
          <p className="px-3 py-8 text-center font-serif italic text-vermilion">{(hooks.error as Error).message}</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-8 text-center font-serif italic text-ink-muted text-sm">No webhooks yet.</p>
        ) : (
          <ul className="divide-y divide-rule">
            {rows.map((w) => {
              const result = results[w.id];
              return (
                <li key={w.id} className="px-3 py-2.5" data-testid={`webhook-${w.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs truncate">{w.url}</div>
                      <div className="eyebrow text-[9px] mt-0.5 flex flex-wrap items-center gap-1.5">
                        {w.events.map((e) => (
                          <span key={e} className="stamp border-rule text-ink-muted normal-case tracking-normal">{e}</span>
                        ))}
                        <span>{w.secretSet ? "signed" : "unsigned"}</span>
                        {!w.enabled ? <span className="text-vermilion">disabled</span> : null}
                      </div>
                    </div>
                    <Hint text="POSTs a signed test event to this URL right now and reports what came back — the fastest way to tell a broken endpoint from a broken signature.">
                      <button
                        onClick={() => probe.mutate(w.id)}
                        disabled={probe.isPending}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-ink/40 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
                        data-testid={`webhook-test-${w.id}`}
                      >
                        {probe.isPending && probe.variables === w.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                        <span className="eyebrow text-[9px] !text-current">test</span>
                      </button>
                    </Hint>
                    <AlertDialog>
                      <Hint text="Asks first, then stops deliveries to this URL and destroys its signing secret. Adding it back means a new secret and a new verification key.">
                        <AlertDialogTrigger asChild>
                          <button aria-label={`Delete webhook ${w.url}`} className="text-ink-muted hover:text-vermilion focus-ink rounded-sm p-1.5" data-testid={`webhook-delete-${w.id}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </AlertDialogTrigger>
                      </Hint>
                      <AlertDialogContent className="bg-card border border-ink/30 rounded-sm">
                        <AlertDialogHeader>
                          <AlertDialogTitle className="font-display text-xl font-normal">Delete this webhook?</AlertDialogTitle>
                          <AlertDialogDescription className="font-serif">
                            Deliveries to <span className="font-mono text-xs">{w.url}</span> stop immediately and its signing secret is destroyed.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => remove.mutate(w.id)} className="rounded-sm bg-vermilion text-parchment hover:bg-vermilion/90">Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                  {result ? (
                    <div className={cn("mt-2 flex items-center gap-1.5 text-xs font-serif", result.delivered ? "text-sage" : "text-vermilion")} data-testid={`webhook-result-${w.id}`}>
                      {result.delivered ? <Check className="h-3.5 w-3.5" /> : <TriangleAlert className="h-3.5 w-3.5" />}
                      {result.delivered ? `ping delivered · HTTP ${result.status}` : `ping failed · ${result.error ?? `HTTP ${result.status}`}`}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <SlackCard />

      <GithubCard />

      <TelegramCard />

      <TeamsCard />
    </div>
  );
}
