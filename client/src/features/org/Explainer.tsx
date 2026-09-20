import React, { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * The marginal note at the top of every Org tab.
 *
 * Two audiences, one block: an owner who has never seen a bearer token reads the
 * "why" and stops there; whoever has to wire the thing up opens "Technical
 * details" for the endpoints, headers and guarantees. Technical is collapsed by
 * default so the plain-language sentence is never buried under mechanics.
 */
export default function Explainer({
  why,
  technical,
  testId = "explainer",
  className,
}: {
  why: ReactNode;
  /** A fragment of <li> elements — Explainer supplies the list. */
  technical: ReactNode;
  testId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section
      className={cn("paper-flat bg-parchment-deep/40 border-l-2 border-l-vermilion/70 px-3 py-3 sm:px-4", className)}
      data-testid={testId}
    >
      <div className="eyebrow text-[9px]">Why this matters</div>
      <p className="font-serif text-[14.5px] leading-relaxed mt-1 max-w-prose" data-testid={`${testId}-why`}>
        {why}
      </p>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="mt-2.5 microcaps inline-flex items-center gap-1.5 hover:text-ink transition-colors focus-ink rounded-sm"
          data-testid={`${testId}-toggle`}
        >
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
          Technical details
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 pt-2.5 rule-t">
            <ul
              className="space-y-1.5 pl-4 list-disc marker:text-vermilion/70 text-[13px] leading-relaxed font-serif text-ink-muted max-w-prose [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:text-ink"
              data-testid={`${testId}-technical`}
            >
              {technical}
            </ul>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
