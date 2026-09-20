// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { Footnote } from "./chrome";

/* ─────────────────────────────────────────────────────────────────────────
 * The four surfaces.
 *
 * The tab row is the app's own numbered navigation, reused as the tour's
 * control: whatever a visitor presses here is the thing they will press
 * once they are inside. Screenshots are set as plates, with the caption on
 * a rule beneath them.
 * ───────────────────────────────────────────────────────────────────────── */

export interface Surface {
  key: string;
  glyph: string;
  label: string;
  title: string;
  lede: string;
  lines: string[];
  image: string;
  caption: string;
}

export const SURFACES: Surface[] = [
  {
    key: "overview",
    glyph: "I",
    label: "Overview",
    title: "What the work owes you",
    lede: "The whole organization on one page: what is open, what is late, and what it has cost so far.",
    lines: [
      "A strip of figures across every app and stream",
      "A backlog sorted on a 0–100 priority score",
      "Cross-app streams for the work that is nobody's app and everybody's problem",
      "A next-task queue your agents pull from instead of guessing",
    ],
    image: "overview",
    caption: "Plate I · Overview · the backlog, ordered by score",
  },
  {
    key: "plan",
    glyph: "II",
    label: "Plan",
    title: "The drafting board",
    lede: "Backlog on the left, the month on the right. Drag a card onto a lane and everything that waits on it moves too.",
    lines: [
      "Backlog and timeline, one drag apart",
      "Dependency cascade: push a card and its dependants follow",
      "Streams as swim-lanes across the month",
      "Cascade mode: the dependency tree, ordered and sub-ordered, with a slip preview",
    ],
    image: "plan",
    caption: "Plate II · Plan · streams as lanes across September",
  },
  {
    key: "track",
    glyph: "III",
    label: "Track",
    title: "The day's page",
    lede: "A chronograph, a ledger, and a source on every line — so a month of work can be read back honestly.",
    lines: [
      "Chronograph and break tiles",
      "A day ledger stamped human, or agent with its tokens and dollars",
      "Calendar, reports and insights",
      "PDF invoices that show the human and agent split",
    ],
    image: "track",
    caption: "Plate III · Track · the chronograph, before the day starts",
  },
  {
    key: "org",
    glyph: "IV",
    label: "Org",
    title: "Who may write here",
    lede: "Members, agents and everything that talks to the organization from outside.",
    lines: [
      "Roles: owner, admin, manager, member",
      "Agent seats by invite code, with onboarding for Claude Code, Claude Desktop and Cursor",
      "Tokens, a Slack app and signed webhooks",
      "CSV importers for Jira, Trello, Asana, Linear, Notion, Toggl, Clockify and Harvest · iCal feed · OpenAPI",
    ],
    image: "org",
    caption: "Plate IV · Org · how an agent joins",
  },
];

export default function SurfaceTour({ className }: { className?: string }) {
  const [active, setActive] = useState(SURFACES[0].key);
  const surface = SURFACES.find((s) => s.key === active) ?? SURFACES[0];

  return (
    <div className={className}>
      <nav aria-label="Surfaces">
        <ul className="-mx-1 flex flex-wrap border-b border-ink/70">
          {SURFACES.map((s) => {
            const on = s.key === surface.key;
            return (
              <li key={s.key} className="flex-1">
                <button
                  type="button"
                  aria-pressed={on}
                  data-testid={`surface-${s.key}`}
                  onClick={() => setActive(s.key)}
                  className={cn(
                    "focus-ink relative block w-full px-1 py-3 text-left transition-colors",
                    on ? "text-ink" : "text-ink-muted hover:text-ink"
                  )}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="section-num tabular-nums">{s.glyph}.</span>
                    <span className="font-display text-base tracking-[-0.015em] sm:text-lg">{s.label}</span>
                  </span>
                  {on && <span className="absolute inset-x-0 -bottom-px h-[2px] bg-vermilion" />}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-8 grid gap-8 lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-10">
        <div>
          <h3 className="font-display text-[1.6rem] leading-tight tracking-[-0.02em] text-ink">{surface.title}</h3>
          <p className="mt-3 text-[1rem] leading-[1.6] text-ink-muted text-pretty">{surface.lede}</p>
          <ul className="mt-4 divide-y divide-rule border-y border-rule">
            {surface.lines.map((line) => (
              <li key={line} className="py-2 text-[0.9rem] leading-snug text-ink">
                {line}
              </li>
            ))}
          </ul>
        </div>

        <figure className="min-w-0">
          <div className="aspect-[16/10] w-full overflow-hidden border border-ink/70 bg-parchment-deep/40">
            <picture>
              <source media="(max-width: 640px)" srcSet={`/landing/${surface.image}@sm.webp`} type="image/webp" />
              <img
                src={`/landing/${surface.image}.webp`}
                alt={`${surface.label} in PTD — ${surface.title}`}
                width={1280}
                height={800}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover object-top"
              />
            </picture>
          </div>
          <Footnote>{surface.caption}</Footnote>
        </figure>
      </div>
    </div>
  );
}
