import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Link2, Link2Off, Loader2, Radio, Send, TriangleAlert, Unplug } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import CopyBlock from "../CopyBlock";
import { Hint } from "../Hint";
import {
  TELEGRAM_COMMANDS, TELEGRAM_STATUS_KEY, disconnectTelegram, getTelegramStatus, getTelegramWebhookInfo,
  mintTelegramLinkCode, registerTelegramWebhook, unlinkTelegram,
  type TelegramLinkCode, type TelegramWebhookInfo,
} from "./api";

const ENV_SNIPPET = `# .env — talk to @BotFather in Telegram first: /newbot
TELEGRAM_BOT_TOKEN=
PTD_BASE_URL=https://ptd.example.com`;

/**
 * Telegram — the same commands as Slack, in a chat people already have on their phone.
 *
 * One bot serves the whole deployment, so the card is careful about what "connected"
 * means: the token is the server's, and switching Telegram on is this organization
 * opting in to minting link codes and receiving DMs.
 */
export default function TelegramCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [code, setCode] = useState<TelegramLinkCode | null>(null);
  const [info, setInfo] = useState<TelegramWebhookInfo | null>(null);

  const status = useQuery({ queryKey: TELEGRAM_STATUS_KEY, queryFn: getTelegramStatus });
  const invalidate = () => qc.invalidateQueries({ queryKey: TELEGRAM_STATUS_KEY });

  const register = useMutation({
    mutationFn: registerTelegramWebhook,
    onSuccess: (data) => {
      invalidate();
      toast({
        title: "Webhook registered",
        description: data.warning ?? `${data.botUsername ? `@${data.botUsername}` : "The bot"} now delivers to this server.`,
        variant: data.warning ? "destructive" : undefined,
      });
    },
    onError: (err: Error) => toast({ title: "Could not register the webhook", description: err.message, variant: "destructive" }),
  });

  const probe = useMutation({
    mutationFn: getTelegramWebhookInfo,
    onSuccess: (data) => {
      setInfo(data);
      if (data.matches) toast({ title: "Telegram is pointing here", description: data.url ?? "" });
      else toast({ title: "Telegram points somewhere else", description: data.url ?? "no webhook set", variant: "destructive" });
    },
    onError: (err: Error) => toast({ title: "Could not ask Telegram", description: err.message, variant: "destructive" }),
  });

  const mint = useMutation({
    mutationFn: mintTelegramLinkCode,
    onSuccess: (data) => setCode(data),
    onError: (err: Error) => toast({ title: "Could not mint a code", description: err.message, variant: "destructive" }),
  });

  const unlink = useMutation({
    mutationFn: unlinkTelegram,
    onSuccess: () => {
      setCode(null);
      invalidate();
      toast({ title: "Telegram account unlinked" });
    },
    onError: (err: Error) => toast({ title: "Could not unlink", description: err.message, variant: "destructive" }),
  });

  const disconnect = useMutation({
    mutationFn: disconnectTelegram,
    onSuccess: () => {
      setCode(null);
      setInfo(null);
      invalidate();
      toast({ title: "Telegram switched off for this organization" });
    },
    onError: (err: Error) => toast({ title: "Could not disconnect", description: err.message, variant: "destructive" }),
  });

  const data = status.data;
  const state = !data ? "loading" : !data.appConfigured ? "unconfigured" : !data.connected ? "disconnected" : "connected";

  return (
    <article className="paper-flat p-4" data-testid="telegram-card">
      <div className="flex items-center gap-2">
        <Send className="h-4 w-4" />
        <span className="font-display text-lg tracking-tight">Telegram</span>
        <span
          className={cn("stamp ml-auto", state === "connected" ? "border-sage/60 text-sage" : "border-rule text-ink-muted")}
          data-testid="telegram-state"
        >
          {state === "loading" ? "…" : state === "unconfigured" ? "not configured" : state === "disconnected" ? "not switched on" : `on · ${data?.botUsername ? `@${data.botUsername}` : "bot"}`}
        </span>
      </div>

      <p className="text-sm font-serif text-ink-muted mt-2 max-w-prose">
        The same vocabulary as Slack, in a private chat: <code className="font-mono text-xs">/next</code>,{" "}
        <code className="font-mono text-xs">/start PTD-12</code>, <code className="font-mono text-xs">/log 45m PTD-12</code>. Commands
        run as the PTD user the Telegram account is linked to, with that user's role. Assignments and cascade shifts arrive as a DM.
      </p>

      {status.isLoading ? (
        <div className="py-6 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></div>
      ) : status.error ? (
        <p className="py-6 text-center font-serif italic text-vermilion">{(status.error as Error).message}</p>
      ) : state === "unconfigured" ? (
        <div className="mt-3 space-y-2" data-testid="telegram-unconfigured">
          <p className="text-sm font-serif">
            <TriangleAlert className="h-3.5 w-3.5 inline -mt-0.5 mr-1 text-vermilion" />
            Telegram bot not configured on this server.
          </p>
          <p className="eyebrow text-[9px]">
            message <code className="font-mono">@BotFather</code>, send <code className="font-mono">/newbot</code>, then restart PTD with:
          </p>
          <CopyBlock body={ENV_SNIPPET} label=".env" testId="telegram-env" />
        </div>
      ) : state === "disconnected" ? (
        <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="telegram-disconnected">
          {data?.canManage ? (
            <Hint text="Calls setWebhook on the bot, pointing it at this deployment, and switches Telegram on for this organization. The URL carries a secret derived from PTD_SECRET_KEY and the bot token.">
              <button
                onClick={() => register.mutate()}
                disabled={register.isPending}
                className="inline-flex items-center gap-2 px-4 h-[38px] border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
                data-testid="telegram-register"
              >
                {register.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
                <span className="eyebrow text-[10px] !text-current">register webhook</span>
              </button>
            </Hint>
          ) : (
            <p className="text-sm font-serif italic text-ink-muted">An admin has to switch the bot on.</p>
          )}
          <span className="eyebrow text-[9px]">
            delivery path {data?.webhookPath ?? "—"} — https only, Telegram refuses anything else
          </span>
        </div>
      ) : (
        <div className="mt-3 space-y-4" data-testid="telegram-connected">
          <div className="eyebrow text-[9px] flex flex-wrap gap-x-3 gap-y-1">
            <span>bot {data?.botUsername ? `@${data.botUsername}` : "—"}</span>
            {data?.webhookSetAt ? <span>webhook set {new Date(data.webhookSetAt).toLocaleString()}</span> : null}
            {data?.selectedOrgId ? <span>your /org choice: {data.selectedOrgId}</span> : null}
            {data?.lastError ? <span className="text-vermilion">{data.lastError}</span> : null}
          </div>

          {data?.canManage ? (
            <div className="border-t border-rule pt-3 flex flex-wrap items-center gap-2">
              <Hint text="Re-points the bot at this deployment. Safe to run again after a PTD_BASE_URL or PTD_SECRET_KEY change — the webhook URL is derived from both.">
                <button
                  onClick={() => register.mutate()}
                  disabled={register.isPending}
                  className="inline-flex items-center gap-1.5 px-3 h-[34px] border border-ink/40 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
                  data-testid="telegram-reregister"
                >
                  {register.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Radio className="h-3 w-3" />}
                  <span className="eyebrow text-[9px] !text-current">re-register</span>
                </button>
              </Hint>
              <Hint text="Asks Telegram what it thinks the webhook is, how many updates are queued and what the last delivery error was — the fastest way to tell a wrong base URL from a firewall.">
                <button
                  onClick={() => probe.mutate()}
                  disabled={probe.isPending}
                  className="inline-flex items-center gap-1.5 px-3 h-[34px] border border-ink/40 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
                  data-testid="telegram-webhook-info"
                >
                  {probe.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  <span className="eyebrow text-[9px] !text-current">check delivery</span>
                </button>
              </Hint>
              {info ? (
                <span className={cn("text-xs font-serif", info.matches ? "text-sage" : "text-vermilion")} data-testid="telegram-webhook-result">
                  {info.matches ? "pointing here" : `pointing at ${info.url ?? "nothing"}`}
                  {info.pendingUpdateCount ? ` · ${info.pendingUpdateCount} queued` : ""}
                  {info.lastErrorMessage ? ` · last error: ${info.lastErrorMessage}` : ""}
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="border-t border-rule pt-3">
            <div className="microcaps flex items-center gap-1.5">
              {data?.linked ? <Link2 className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />} Your Telegram link
            </div>
            {data?.linked ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                <p className="text-sm font-serif text-ink-muted">
                  This PTD account answers to Telegram user <code className="font-mono text-xs">{data.telegramUserId}</code>.
                </p>
                <button
                  onClick={() => unlink.mutate()}
                  disabled={unlink.isPending}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-ink/40 hover:border-vermilion hover:text-vermilion transition-colors rounded-sm focus-ink disabled:opacity-60"
                  data-testid="telegram-unlink"
                >
                  {unlink.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2Off className="h-3 w-3" />}
                  <span className="eyebrow text-[9px] !text-current">unlink</span>
                </button>
              </div>
            ) : (
              <div className="mt-1.5 space-y-2">
                <p className="text-sm font-serif text-ink-muted">
                  Open{" "}
                  {data?.botLink ? (
                    <a href={data.botLink} target="_blank" rel="noreferrer" className="font-mono text-xs underline decoration-dotted">
                      @{data.botUsername}
                    </a>
                  ) : (
                    "the bot"
                  )}{" "}
                  in Telegram, then send it the command below. Codes last ten minutes and work once.
                </p>
                <Hint text="Gives you a one-time /link command, good for ten minutes, that ties your Telegram user to this PTD account — after that your commands run with your role.">
                  <button
                    onClick={() => mint.mutate()}
                    disabled={mint.isPending}
                    className="inline-flex items-center gap-1.5 px-3 h-[34px] border border-ink/40 hover:bg-ink hover:text-parchment transition-colors rounded-sm focus-ink disabled:opacity-60"
                    data-testid="telegram-mint-code"
                  >
                    {mint.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
                    <span className="eyebrow text-[9px] !text-current">mint a link code</span>
                  </button>
                </Hint>
                {code ? (
                  <div className="space-y-1" data-testid="telegram-link-code">
                    <CopyBlock body={code.command} label={`expires ${new Date(code.expiresAt).toLocaleTimeString()}`} testId="telegram-link-command" />
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="border-t border-rule pt-3">
            <div className="microcaps">Commands</div>
            <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
              {TELEGRAM_COMMANDS.map((c) => (
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
                <Hint text="Asks first, then switches the bot off for this organization: link codes stop and DMs stop. Other organizations on this server keep using the same bot.">
                  <AlertDialogTrigger asChild>
                    <button
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-ink/40 text-ink-muted hover:border-vermilion hover:text-vermilion transition-colors rounded-sm focus-ink"
                      data-testid="telegram-disconnect"
                    >
                      <Unplug className="h-3 w-3" />
                      <span className="eyebrow text-[9px] !text-current">switch off</span>
                    </button>
                  </AlertDialogTrigger>
                </Hint>
                <AlertDialogContent className="bg-card border border-ink/30 rounded-sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="font-display text-xl font-normal">Switch Telegram off?</AlertDialogTitle>
                    <AlertDialogDescription className="font-serif">
                      Link codes stop being minted and DMs stop for this organization. Members keep their link records, and the
                      webhook is left registered because the same bot may be serving other organizations on this server.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => disconnect.mutate()} className="rounded-sm bg-vermilion text-parchment hover:bg-vermilion/90">
                      Switch off
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
