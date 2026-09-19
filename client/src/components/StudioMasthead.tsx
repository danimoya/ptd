import { cn } from "@/lib/utils";

interface StudioMastheadProps {
  className?: string;
  size?: "sm" | "md" | "lg";
  withCaret?: boolean;
}

/**
 * Brand wordmark used across auth, header and error screens.
 * Pairs the serif "TimeTracker" with a ruled corner badge, matching the
 * Kanttban landing vocabulary so the two products read as one document set.
 */
export function StudioMasthead({
  className,
  size = "md",
  withCaret = false,
}: StudioMastheadProps) {
  const sizes = {
    sm: "text-2xl",
    md: "text-4xl",
    lg: "text-6xl md:text-7xl",
  };

  return (
    <div className={cn("flex items-baseline gap-3", className)}>
      <h1
        className={cn(
          "wordmark text-ink leading-none tracking-tightest",
          sizes[size],
          withCaret && "caret"
        )}
      >
        Time<span className="font-display italic">Tracker</span>
        <span className="font-display italic text-vermilion">.</span>
      </h1>
    </div>
  );
}

export function StudioRibbon({
  label = "Daily ledger · est. MMXXVI",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("microcaps flex items-center gap-2", className)}>
      <span className="inline-block h-px w-6 bg-ink/60" />
      {label}
      <span className="inline-block h-px w-6 bg-ink/60" />
    </div>
  );
}
