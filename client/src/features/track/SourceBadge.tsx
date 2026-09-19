import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTokens, formatUsd } from "./format";
import type { EntryView } from "./api";

/**
 * Who did this work — the product's whole point, printed on every ledger line.
 *
 * A human line is a quiet stamp. An agent line is set in vermilion and carries
 * the tokens and dollars it burned, because that is the number a manager is
 * actually looking for: "agent · 12.4k tok · $0.37".
 */
export function SourceBadge({
  entry,
  className,
  showName = false,
}: {
  entry: Pick<EntryView, "entrySource" | "agentLabel" | "tokensUsed" | "apiCostUsd">;
  className?: string;
  showName?: boolean;
}) {
  const isAgent = entry.entrySource === "agent";
  const Icon = isAgent ? Bot : User;
  const parts: string[] = [showName && isAgent && entry.agentLabel ? entry.agentLabel : entry.entrySource];
  if (isAgent) {
    if (entry.tokensUsed) parts.push(`${formatTokens(entry.tokensUsed)} tok`);
    if (entry.apiCostUsd) parts.push(formatUsd(entry.apiCostUsd));
  }

  return (
    <span
      title={isAgent ? `Logged by agent${entry.agentLabel ? ` ${entry.agentLabel}` : ""}` : "Logged by a person"}
      className={cn(
        "inline-flex items-center gap-1 shrink-0 border px-1.5 py-[1px] rounded-[1px] font-numeric text-[10px] uppercase tracking-wider leading-[1.4] whitespace-nowrap",
        isAgent ? "border-vermilion/60 text-vermilion" : "border-rule text-ink-muted",
        className
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={2} aria-hidden />
      {parts.join(" · ")}
    </span>
  );
}

export default SourceBadge;
