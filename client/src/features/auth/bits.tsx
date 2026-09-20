// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { ArrowRight, Check, Copy, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The plate the door is set on.
 *
 * These were inline in `pages/Auth.tsx` while that page had one job. It now has
 * five — sign in, open an organization, take an agent seat, ask for a reset, set a
 * new password — and the panels for those live in their own files, so the pieces
 * they share moved here. Nothing in this file knows about any particular form.
 */

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="eyebrow">{label}</span>
        {hint && <span className="text-[0.75rem] text-ink-muted">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Submit({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className={cn(
        "focus-ink group flex w-full items-center justify-center gap-2 border border-ink bg-ink px-5 py-3",
        "font-numeric text-[11px] uppercase tracking-[0.18em] text-parchment transition-all duration-150",
        "hover:-translate-x-px hover:-translate-y-px hover:bg-parchment hover:text-ink hover:shadow-stamp",
        "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-x-0 disabled:hover:translate-y-0",
        "disabled:hover:bg-ink disabled:hover:text-parchment disabled:hover:shadow-none"
      )}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="border border-vermilion/50 bg-vermilion/5 px-3 py-2 text-[0.9rem] text-vermilion">
      {children}
    </p>
  );
}

/** The counterpart to ErrorNote: something worked, and there is nothing to click. */
export function Note({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p className="border border-rule bg-card px-3 py-2 text-[0.9rem] leading-relaxed text-ink-muted" data-testid={testId}>
      {children}
    </p>
  );
}

export function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-rule pt-3">
      <div className="eyebrow mb-2">{label}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[0.8rem]">
      <span className="eyebrow text-[10px]">{k}</span>
      <span className={cn("truncate text-right text-ink", mono && "font-numeric")}>{v}</span>
    </div>
  );
}

export function CopyRow({
  value,
  onCopy,
  copied,
  mono,
  subtle,
}: {
  value: string;
  onCopy: () => void;
  copied: boolean;
  mono?: boolean;
  subtle?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2 border px-2.5 py-1.5", subtle ? "border-rule bg-card" : "border-ink bg-parchment-deep/50")}>
      <code className={cn("flex-1 truncate text-[11px]", mono && "font-mono", subtle ? "text-ink-muted" : "text-ink")} title={value}>
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="focus-ink inline-flex shrink-0 items-center gap-1 border border-rule px-2 py-1 font-numeric text-[10px] uppercase tracking-[0.12em] transition-colors hover:border-ink hover:text-ink"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

/** A copy button that manages its own "copied" flash — for one-off links. */
export function CopyLine({ value, mono = true }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be blocked — the value is on screen either way */
    }
  };
  return <CopyRow value={value} onCopy={copy} copied={copied} mono={mono} subtle />;
}
