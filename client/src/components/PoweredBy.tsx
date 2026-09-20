import { cn } from "@/lib/utils";

/**
 * The house credit. It rides in the desktop colophon, in the mobile bar's small
 * print and in Plan's full-screen chrome, so every surface carries it exactly
 * once and in the same voice.
 */
export default function PoweredBy({ className }: { className?: string }) {
  return (
    <a
      href="https://heliosdb.com"
      target="_blank"
      rel="noreferrer"
      data-testid="powered-by-heliosdb"
      className={cn(
        "microcaps whitespace-nowrap transition-colors hover:text-vermilion focus-ink",
        className
      )}
    >
      Powered by <span className="text-ink">HeliosDB</span>
    </a>
  );
}
