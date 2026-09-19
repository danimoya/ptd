import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Github, Loader2, Plus, Send, ShieldAlert, Slack, Trash2, TriangleAlert, Webhook } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import CopyBlock from "./CopyBlock";
import { createWebhook, deleteWebhook, listWebhooks, testWebhook, type CreatedWebhook, type WebhookTestResult } from "./api";
import { ALL_EVENT_KINDS, EVENT_GROUPS, parseEvents, unknownEvents } from "./events";

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

/** Webhooks are live; Slack and GitHub are declared, not pretended. */
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
              <span className="eyebrow text-[9px]">signing secret — leave blank and one is generated for you</span>
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
                    <button
                      onClick={() => probe.mutate(w.id)}
                      disabled={probe.isPending}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-ink/40 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
                      data-testid={`webhook-test-${w.id}`}
                    >
                      {probe.isPending && probe.variables === w.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                      <span className="eyebrow text-[9px] !text-current">test</span>
                    </button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button aria-label={`Delete webhook ${w.url}`} className="text-ink-muted hover:text-vermilion focus-ink rounded-sm p-1.5" data-testid={`webhook-delete-${w.id}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </AlertDialogTrigger>
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

      <section className="grid gap-3 sm:grid-cols-2">
        {[
          { icon: Slack, name: "Slack", note: "Post task events into a channel, and create a task from a thread with a slash command." },
          { icon: Github, name: "GitHub", note: "Mirror issues and pull requests onto tasks through externalKey, both directions." },
        ].map((c) => (
          <article key={c.name} className="paper-flat p-4 opacity-80" data-testid={`coming-soon-${c.name.toLowerCase()}`}>
            <div className="flex items-center gap-2">
              <c.icon className="h-4 w-4 text-ink-muted" />
              <span className="font-display text-lg tracking-tight">{c.name}</span>
              <span className="stamp border-rule text-ink-muted ml-auto">coming soon</span>
            </div>
            <p className="text-sm font-serif text-ink-muted mt-2">{c.note}</p>
            <p className="eyebrow text-[9px] mt-2">
              the <code className="font-mono">org_integrations</code> table already carries this kind — only the adapter is missing
            </p>
          </article>
        ))}
      </section>
    </div>
  );
}
