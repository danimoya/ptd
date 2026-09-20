import React, { type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * One line of "what happens if I click this", on the control itself.
 *
 * With a child it wraps that control (hover or keyboard focus shows the note);
 * without one it renders a small question mark to hang next to a label, which is
 * what the controls that start out disabled get — a disabled button never fires
 * a pointer event, so a tooltip on it would be unreachable.
 */
export function Hint({
  text,
  children,
  side = "top",
  align = "center",
  className,
  label,
}: {
  text: string;
  children?: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
  /** Accessible name for the standalone glyph. Defaults to the note itself. */
  label?: string;
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        {children ? (
          <TooltipTrigger asChild>{children}</TooltipTrigger>
        ) : (
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={label ?? text}
              className={cn(
                "inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border border-rule align-middle font-mono text-[9px] leading-none text-ink-muted transition-colors hover:border-ink hover:text-ink focus-ink",
                className,
              )}
              data-testid="hint-glyph"
            >
              ?
            </button>
          </TooltipTrigger>
        )}
        <TooltipContent
          side={side}
          align={align}
          collisionPadding={12}
          className="max-w-[268px] rounded-sm border-ink/30 bg-card px-2.5 py-1.5 font-serif text-[12.5px] leading-snug text-ink shadow-sm"
          data-testid="hint-content"
        >
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default Hint;
