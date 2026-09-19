import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { StudioMasthead } from "@/components/StudioMasthead";
import { cn } from "@/lib/utils";

type SignInResult = { ok: true } | { ok: false; message: string };

interface FloatingLoginBarProps {
  visible: boolean;
  busy?: boolean;
  onSignIn: (email: string, password: string) => Promise<SignInResult>;
  onOpenFull: (mode: "signin" | "register") => void;
}

/**
 * A short sign-in form that floats into the top navigation once the first fold
 * (hero + form plate) has scrolled away, so the visitor can sign in while
 * reading the sheets below without scrolling back up.
 */
export function FloatingLoginBar({
  visible,
  busy = false,
  onSignIn,
  onOpenFull,
}: FloatingLoginBarProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-transform duration-300 ease-out",
        visible ? "translate-y-0" : "-translate-y-full"
      )}
    >
      <div className="border-b border-ink bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/85 shadow-[0_1px_0_0_hsl(var(--rule))]">
        <div className="mx-auto max-w-6xl px-6 md:px-10">
          {/* Desktop: brand + short inline form */}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await onSignIn(email, password);
            }}
            className="hidden md:flex items-center gap-4 h-14"
          >
            <button
              type="button"
              onClick={() => onOpenFull("signin")}
              className="shrink-0 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ochre/60"
              aria-label="Back to top"
            >
              <StudioMasthead size="sm" />
            </button>
            <span className="microcaps hidden lg:inline whitespace-nowrap">
              Hours ledger
            </span>

            <div className="flex-1" />

            <label className="sr-only" htmlFor="float-email">
              Email
            </label>
            <input
              id="float-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="Email"
              className="draft-input h-9 w-44 text-sm"
              tabIndex={visible ? 0 : -1}
            />
            <label className="sr-only" htmlFor="float-password">
              Password
            </label>
            <input
              id="float-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="Password"
              className="draft-input h-9 w-40 text-sm font-mono"
              tabIndex={visible ? 0 : -1}
            />
            <button
              type="submit"
              disabled={busy || !email || !password}
              tabIndex={visible ? 0 : -1}
              className={cn(
                "group inline-flex items-center gap-2 border border-ink bg-ink px-4 h-9 text-paper",
                "transition-all duration-150 hover:bg-paper hover:text-ink hover:shadow-stamp",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              )}
              <span className="microcaps !text-current">Sign in</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenFull("register")}
              tabIndex={visible ? 0 : -1}
              className="text-sm text-ink-3 hover:text-ink transition-colors whitespace-nowrap"
            >
              Open a ledger →
            </button>
          </form>

          {/* Mobile: brand + jump back to the form */}
          <div className="md:hidden flex items-center justify-between gap-3 h-14">
            <StudioMasthead size="sm" />
            <button
              type="button"
              onClick={() => onOpenFull("signin")}
              tabIndex={visible ? 0 : -1}
              className="inline-flex items-center gap-2 border border-ink bg-ink px-4 h-9 text-paper"
            >
              <span className="microcaps !text-current">Sign in</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
