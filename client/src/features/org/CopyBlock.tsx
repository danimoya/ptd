import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** A code block with a copy button. Shared by the Agents, Tokens and Integrations tabs. */
export default function CopyBlock({
  body,
  label,
  className,
  testId,
}: {
  body: string;
  label?: string;
  className?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // A blocked clipboard is not worth an error state — the text is selectable.
    }
  };

  return (
    <div className={cn("relative group min-w-0 max-w-full", className)}>
      {label ? <div className="eyebrow text-[9px] mb-1">{label}</div> : null}
      <pre
        className="paper-flat bg-parchment-deep/50 px-3 py-2.5 pr-11 text-[11.5px] leading-relaxed font-mono overflow-x-auto nice-scroll whitespace-pre"
        data-testid={testId}
      >
        {body}
      </pre>
      <button
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        className={cn(
          "absolute right-1.5 p-1.5 rounded-sm focus-ink transition-colors",
          label ? "top-[22px]" : "top-1.5",
          copied ? "text-sage" : "text-ink-muted hover:text-ink",
        )}
        data-testid={testId ? `${testId}-copy` : undefined}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
