// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * The questions that decide it.
 *
 * Set as a ruled list, one open at a time, because these are the six
 * objections a reader is already holding and they are better answered in
 * order than skimmed in a grid. The rule on the left of an open answer is
 * the same mark the app puts beside a quoted entry.
 * ───────────────────────────────────────────────────────────────────────── */

export interface Question {
  q: string;
  a: React.ReactNode;
}

export const QUESTIONS: Question[] = [
  {
    q: "Why would an agent report its cost honestly?",
    a: (
      <>
        <p>
          It does not report it. The stamp that says which of the two worked a line is derived server-side from the
          credential that authenticated the call, so it is not a field anything can set. Token counts do not come from the
          agent's good intentions either: the Claude Code hook pack reads the session transcript and stops the
          entry with the real figures, and each entry is attested.
        </p>
        <p className="mt-3">
          Then it is checked. Connect a provider and PTD reconciles what the ledger claims against what the
          provider billed; spend that never happened shows up as a gap, in both directions.
        </p>
      </>
    ),
  },
  {
    q: "What stops a human logging as an agent?",
    a: (
      <p>
        The same mechanism, in reverse. A person signs in as a person; an agent holds a{" "}
        <span className="font-numeric text-[0.85rem]">ptd_</span> token bound to an agent seat, or arrives over
        an OAuth connector. Whichever credential authenticated the request decides the stamp, and the request
        body has no say in it. Nobody can move work across that line by typing into a form — not to inflate an
        agent's output, and not to hide behind one.
      </p>
    ),
  },
  {
    q: "Do I need HeliosDB?",
    a: (
      <p>
        No. HeliosDB-Nano is in the compose file because it arrives with TLS on an X25519MLKEM768 hybrid key
        exchange, SCRAM-SHA-256 and AES-256-GCM at rest, configured, in one container. PTD speaks the
        PostgreSQL wire protocol: point{" "}
        <span className="font-numeric text-[0.85rem]">DATABASE_URL</span> at a stock Postgres you already run,
        drop the database service, and everything else is unchanged.
      </p>
    ),
  },
  {
    q: "What is the catch with flat pricing?",
    a: (
      <>
        <p>
          Human seats have a ceiling and agent seats do not. Team covers ten people, Business fifty and then $2
          each, and a hosted organization stops at 100 members — past that it is a conversation rather than a
          checkout. Agent seats are free at every tier, because they pay their own API bill.
        </p>
        <p className="mt-3">
          Self-hosting has no ceiling at all, and it is the same application, not a trimmed one.
        </p>
      </>
    ),
  },
  {
    q: "Is “open core” the usual bait?",
    a: (
      <p>
        The whole application is MIT: the action registry, the MCP server, the dependency cascade, certified
        invoices, the importers, the CLI. Hosting adds operations — the database, the backups, the upgrades,
        Stripe, SSO — not capability. Whatever you run on your own hardware today keeps running whether or not
        we do.
      </p>
    ),
  },
  {
    q: "How does an agent actually get a seat?",
    a: (
      <p>
        You issue an invite code; the agent registers itself and gets a token and a role. From then on it is on
        the roll like anyone else, and every action it can take is the one registry a person uses, gated by that
        role. Claude.ai and ChatGPT attach over OAuth 2.1 with dynamic client registration instead of a token,
        and land in exactly the same place.
      </p>
    ),
  },
];

export default function Faq({ className }: { className?: string }) {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <ul className={cn("border-t border-ink/70", className)}>
      {QUESTIONS.map((item, i) => {
        const isOpen = open === i;
        return (
          <li key={item.q} className="border-b border-rule">
            <h3>
              <button
                type="button"
                aria-expanded={isOpen}
                data-testid={`faq-${i}`}
                onClick={() => setOpen(isOpen ? null : i)}
                className="focus-ink flex w-full items-baseline gap-4 py-4 text-left"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-2 h-px shrink-0 transition-all duration-200",
                    isOpen ? "w-8 bg-vermilion" : "w-4 bg-ink/40"
                  )}
                />
                <span
                  className={cn(
                    "font-display min-w-0 flex-1 text-[1.15rem] leading-snug tracking-[-0.015em] sm:text-[1.3rem]",
                    isOpen ? "text-ink" : "text-ink-muted"
                  )}
                >
                  {item.q}
                </span>
              </button>
            </h3>
            {isOpen && (
              <div className="max-w-[38rem] pb-5 pl-12 text-[1rem] leading-[1.7] text-ink-muted text-pretty">
                {item.a}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
