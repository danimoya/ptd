// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React from "react";
import { cn } from "@/lib/utils";
import { oidcStartUrl, type ProviderSummary } from "./api";

/**
 * The providers this deployment actually has, as plain links.
 *
 * Links, not buttons with an onClick: the flow begins with a full-page navigation
 * to another origin, so there is nothing for JavaScript to add, and a link works
 * with a middle click, a right-click, and a keyboard.
 *
 * Renders nothing at all when none are configured — a self-hoster who set no
 * client ids sees the password form and no explanation of an absence.
 */
export default function OidcButtons({
  providers,
  redirectTo,
  inviteToken,
  label = "Or continue with",
}: {
  providers: ProviderSummary[];
  redirectTo?: string;
  inviteToken?: string;
  label?: string;
}) {
  if (providers.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="oidc-buttons">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-rule" />
        <span className="eyebrow text-[9px]">{label}</span>
        <span className="h-px flex-1 bg-rule" />
      </div>
      <div className={cn("grid gap-2", providers.length > 1 ? "sm:grid-cols-2" : "")}>
        {providers.map((p) => (
          <a
            key={p.provider}
            href={oidcStartUrl(p.provider, { redirectTo, inviteToken })}
            data-testid={`oidc-${p.provider}`}
            className={cn(
              "focus-ink group flex items-center justify-center gap-2 border border-rule bg-card px-4 py-2.5",
              "font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted transition-all duration-150",
              "hover:-translate-x-px hover:-translate-y-px hover:border-ink hover:text-ink hover:shadow-stamp",
            )}
          >
            <ProviderMark provider={p.provider} />
            {p.label}
          </a>
        ))}
      </div>
      <p className="text-[0.78rem] leading-relaxed text-ink-muted">
        PTD asks the provider for your name and your verified email address, and nothing else. An unverified address is refused —
        it would otherwise be a way into somebody else's account.
      </p>
    </div>
  );
}

/**
 * One 16×16 glyph each, drawn rather than fetched: a remote logo would be a
 * third-party request on the sign-in page, which is the last place to invite one.
 * Monochrome on purpose — the page has one accent colour and it is not Google's.
 */
function ProviderMark({ provider }: { provider: ProviderSummary["provider"] }) {
  const common = { width: 14, height: 14, viewBox: "0 0 24 24", "aria-hidden": true, className: "shrink-0" } as const;
  if (provider === "github") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.55v-2.06c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .3.2.66.8.55A11.5 11.5 0 0 0 23.5 12A11.5 11.5 0 0 0 12 .5z" />
      </svg>
    );
  }
  if (provider === "microsoft") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M3 3h8.5v8.5H3V3zm9.5 0H21v8.5h-8.5V3zM3 12.5h8.5V21H3v-8.5zm9.5 0H21V21h-8.5v-8.5z" />
      </svg>
    );
  }
  return (
    <svg {...common} fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18M3.5 9h17M3.5 15h17" strokeWidth="1.2" />
    </svg>
  );
}
