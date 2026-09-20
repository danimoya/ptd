// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { InkButton, QuietButton } from "./chrome";
import ContactForm from "./ContactForm";

/* ─────────────────────────────────────────────────────────────────────────
 * What it costs.
 *
 * Three columns, and the third one is a door: pressing it turns the whole
 * section over in place rather than sending anyone to a contact page. A
 * pricing page that loses your place the moment you have a question is a
 * pricing page you leave.
 *
 * The turn is a real half-rotation, held at the same height as the face it
 * replaced so the page beneath it does not jump. Under
 * `prefers-reduced-motion` the faces simply swap.
 * ───────────────────────────────────────────────────────────────────────── */

export type Plan = "free" | "team" | "business";
export type Cycle = "monthly" | "annual";

export interface PlanCopy {
  key: Plan;
  name: string;
  monthly: number;
  seats: string;
  /** The sentence directly under the figure. */
  gist: string;
  includes: string[];
}

export const PLANS: PlanCopy[] = [
  {
    key: "free",
    name: "Free",
    monthly: 0,
    seats: "1 organization · 3 seats, humans and agents",
    gist: "Enough to run a real project and see whether the ledger tells you the truth.",
    includes: ["All four surfaces", "MCP, REST and the action registry", "Community support"],
  },
  {
    key: "team",
    name: "Team",
    monthly: 15,
    seats: "up to 10 human seats · agent seats free",
    gist: "Agent seats cost nothing — they pay their own API bill.",
    includes: [
      "All surfaces, all integrations",
      "OAuth connectors for Claude.ai and ChatGPT",
      "Signed webhooks and importers",
      "Certified invoices at $1 each",
    ],
  },
  {
    key: "business",
    name: "Business",
    monthly: 49,
    seats: "up to 50 human seats, then $2 each · agent seats free",
    gist: "For organizations that have to hand the numbers to somebody else.",
    includes: [
      "Everything in Team",
      "Certified invoices and verifiable links, included",
      "SSO, 2FA, audit log and data export",
      "Stripe Tax and priority support",
      "AI priority scoring with your own key",
    ],
  },
];

/** Two months free on the year. Returns dollars, exact. */
export function planPrice(plan: PlanCopy, cycle: Cycle): number {
  return cycle === "annual" ? plan.monthly * 10 : plan.monthly;
}

/** What the annual figure works out to per month. */
export function perMonthOnAnnual(plan: PlanCopy): number {
  return Math.round((plan.monthly * 10 * 100) / 12) / 100;
}

export function money(n: number): string {
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

type Face = "pricing" | "contact";
/** rest → leaving (turn away) → entering (snapped a quarter-turn past) → arriving (settle). */
type Phase = "rest" | "leaving" | "entering" | "arriving";

export default function Pricing({ className }: { className?: string }) {
  const [face, setFace] = useState<Face>("pricing");
  const [phase, setPhase] = useState<Phase>("rest");
  const [held, setHeld] = useState<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const frames = useRef<number[]>([]);

  useLayoutEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      frames.current.forEach((f) => window.cancelAnimationFrame(f));
    },
    []
  );

  // The half-turn only reads as a turn if the new face arrives from the other
  // side. It is painted at +90° with no transition, and only on the next frame
  // is it told to settle — one frame apart, or the browser collapses the two
  // styles into a single paint and nothing moves.
  useLayoutEffect(() => {
    if (phase !== "entering") return;
    frames.current.push(
      window.requestAnimationFrame(() => {
        frames.current.push(window.requestAnimationFrame(() => setPhase("arriving")));
      })
    );
  }, [phase]);

  useLayoutEffect(() => {
    if (phase !== "arriving") return;
    timers.current.push(
      window.setTimeout(() => {
        setPhase("rest");
        setHeld(null);
      }, 240)
    );
  }, [phase]);

  const turn = useCallback((next: Face) => {
    // Hold the height of the face we are leaving, so nothing below the section
    // moves while the turn is in flight.
    setHeld(stage.current?.offsetHeight ?? null);
    if (prefersReducedMotion()) {
      setFace(next);
      setHeld(null);
      return;
    }
    setPhase("leaving");
    timers.current.push(
      window.setTimeout(() => {
        setFace(next);
        setPhase("entering");
      }, 180)
    );
  }, []);

  const faceStyle: React.CSSProperties = {
    transformOrigin: "50% 42%",
    backfaceVisibility: "hidden",
    ...(phase === "leaving"
      ? {
          transform: "rotateY(-90deg)",
          opacity: 0,
          transition: "transform 180ms ease-in, opacity 150ms ease-in",
        }
      : phase === "entering"
        ? { transform: "rotateY(90deg)", opacity: 0, transition: "none" }
        : phase === "arriving"
          ? {
              transform: "none",
              opacity: 1,
              transition: "transform 240ms cubic-bezier(0.22,1,0.36,1), opacity 200ms ease-out",
            }
          : {}),
  };

  return (
    <div
      className={cn("min-w-0", className)}
      style={{ perspective: "1800px", minHeight: held ? `${held}px` : undefined }}
    >
      <div ref={stage} data-testid="pricing-stage" data-face={face} style={faceStyle}>
        {face === "pricing" ? (
          <PricingFace onContact={() => turn("contact")} />
        ) : (
          <ContactFace onBack={() => turn("pricing")} />
        )}
      </div>
    </div>
  );
}

/* ── Face one: the table ─────────────────────────────────────────────── */

function PricingFace({ onContact }: { onContact: () => void }) {
  const [plan, setPlan] = useState<Plan>("team");
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const active = PLANS.find((p) => p.key === plan) ?? PLANS[1];
  const price = planPrice(active, cycle);

  return (
    <div className="grid gap-px border border-ink/70 bg-rule lg:grid-cols-3" data-testid="pricing-face">
      {/* Self-host */}
      <section className="min-w-0 bg-card p-5 sm:p-6">
        <h3 className="font-display text-[1.4rem] tracking-[-0.02em] text-ink">Self-host</h3>
        <p className="font-display mt-3 text-[2.4rem] leading-none tracking-[-0.03em] text-ink">Free</p>
        <p className="font-numeric mt-1.5 text-[10px] uppercase tracking-[0.14em] text-ink-muted">
          MIT · unlimited seats
        </p>
        <p className="mt-4 text-[0.95rem] leading-relaxed text-ink-muted text-pretty">
          Everything except the hosted conveniences. Your hardware, your database, your backups, and no seat
          ceiling at all.
        </p>
        <pre className="nice-scroll mt-4 overflow-x-auto border border-rule bg-parchment-deep/50 p-3 font-mono text-[11px] leading-relaxed text-ink">
          {"docker compose up -d --build"}
        </pre>
        <ul className="mt-4 divide-y divide-rule border-y border-rule">
          {["HeliosDB-Nano in the box; stock Postgres also works", "The full action registry, MCP and REST", "The ptd CLI and the docs"].map(
            (line) => (
              <li key={line} className="py-2 text-[0.9rem] leading-snug text-ink">
                {line}
              </li>
            )
          )}
        </ul>
      </section>

      {/* Hosted */}
      <section className="min-w-0 bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
          <h3 className="font-display text-[1.4rem] tracking-[-0.02em] text-ink">Hosted</h3>
          <div className="flex gap-1" role="group" aria-label="Billing period">
            {(["monthly", "annual"] as Cycle[]).map((c) => (
              <QuietButton
                key={c}
                data-testid={`cycle-${c}`}
                active={cycle === c}
                onClick={() => setCycle(c)}
                className="px-2.5 py-1"
              >
                {c}
              </QuietButton>
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1" role="group" aria-label="Hosted plan">
          {PLANS.map((p) => (
            <QuietButton
              key={p.key}
              data-testid={`plan-${p.key}`}
              active={plan === p.key}
              onClick={() => setPlan(p.key)}
              className="px-2.5 py-1"
            >
              {p.name}
            </QuietButton>
          ))}
        </div>

        <p
          data-testid="hosted-price"
          className="font-display mt-4 text-[2.4rem] leading-none tracking-[-0.03em] text-vermilion"
        >
          {money(price)}
          <span className="font-numeric ml-1.5 align-middle text-[11px] uppercase tracking-[0.12em] text-ink-muted">
            {price === 0 ? "for ever" : cycle === "annual" ? "/ org / year" : "/ org / month"}
          </span>
        </p>
        <p data-testid="hosted-basis" className="font-numeric mt-1.5 text-[10px] leading-relaxed text-ink-muted">
          {price === 0
            ? active.seats
            : cycle === "annual"
              ? `${money(perMonthOnAnnual(active))} a month, two months free · ${active.seats}`
              : `flat, not per seat · ${active.seats}`}
        </p>

        <p className="mt-4 text-[0.95rem] leading-relaxed text-ink-muted text-pretty">{active.gist}</p>

        <ul className="mt-4 divide-y divide-rule border-y border-rule">
          {active.includes.map((line) => (
            <li key={line} className="py-2 text-[0.9rem] leading-snug text-ink">
              {line}
            </li>
          ))}
        </ul>

        <div className="mt-5">
          <InkButton to="/auth?mode=register">Create an organization</InkButton>
        </div>
        <p className="font-numeric mt-3 text-[10px] leading-relaxed text-ink-muted">
          Founding members: 40% off for the first 100 organizations.
        </p>
      </section>

      {/* Larger deployments */}
      <section className="min-w-0 bg-card p-5 sm:p-6">
        <h3 className="font-display text-[1.4rem] tracking-[-0.02em] text-ink">
          Larger deployments &amp; consulting
        </h3>
        <p className="font-display mt-3 text-[2.4rem] leading-none tracking-[-0.03em] text-ink">Talk to us</p>
        <p className="font-numeric mt-1.5 text-[10px] uppercase tracking-[0.14em] text-ink-muted">
          hosted at scale · on-prem · integration
        </p>
        <p className="mt-4 text-[0.95rem] leading-relaxed text-ink-muted text-pretty">
          Hosted organizations are capped at 100 members. Past that, or behind your own firewall, or with your
          own systems to connect to — say what you need and a person answers.
        </p>
        <ul className="mt-4 divide-y divide-rule border-y border-rule">
          {[
            "Hosted at scale, beyond the 100-member cap",
            "On-premises, in your own network",
            "Implementation and integration consulting",
          ].map((line) => (
            <li key={line} className="py-2 text-[0.9rem] leading-snug text-ink">
              {line}
            </li>
          ))}
        </ul>
        <div className="mt-5">
          <InkButton onClick={onContact} className="w-full sm:w-auto" testId="open-contact">
            Tell us what you need
          </InkButton>
        </div>
        <p className="font-numeric mt-3 text-[10px] leading-relaxed text-ink-muted">
          The form opens here. You keep your place on the page.
        </p>
      </section>

      {/* The small print, across the foot of all three */}
      <div className="bg-card p-5 sm:p-6 lg:col-span-3">
        <dl className="grid gap-x-10 gap-y-4 sm:grid-cols-3">
          <div>
            <dt className="font-numeric text-[10px] uppercase tracking-[0.14em] text-ink-muted">Add-ons</dt>
            <dd className="mt-1.5 text-[0.9rem] leading-snug text-ink text-pretty">
              $1 per certified invoice on Team. AI provided by us is metered at cost plus 20% for
              organizations without a key of their own.
            </dd>
          </div>
          <div>
            <dt className="font-numeric text-[10px] uppercase tracking-[0.14em] text-ink-muted">Annual</dt>
            <dd className="mt-1.5 text-[0.9rem] leading-snug text-ink text-pretty">
              Two months free. Team is {money(planPrice(PLANS[1], "annual"))} a year, Business{" "}
              {money(planPrice(PLANS[2], "annual"))}.
            </dd>
          </div>
          <div>
            <dt className="font-numeric text-[10px] uppercase tracking-[0.14em] text-ink-muted">Why switch</dt>
            <dd className="mt-1.5 text-[0.9rem] leading-snug text-ink text-pretty">
              A ten-person hybrid team pays roughly $150–250 a month today, across a planner and a tracker that
              cannot see each other.
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

/* ── Face two: the form ──────────────────────────────────────────────── */

function ContactFace({ onBack }: { onBack: () => void }) {
  return (
    <div className="border border-ink/70 bg-card p-5 sm:p-6 lg:p-8" data-testid="contact-face">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h3 className="font-display text-[1.6rem] tracking-[-0.025em] text-ink sm:text-[1.9rem]">
          Larger deployments &amp; consulting
        </h3>
        <button
          type="button"
          onClick={onBack}
          data-testid="back-to-pricing"
          className="focus-ink font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted underline underline-offset-4 hover:text-ink"
        >
          Back to pricing
        </button>
      </div>
      <p className="mt-3 max-w-[38rem] text-[1rem] leading-relaxed text-ink-muted text-pretty">
        Hosted at scale past the 100-member cap, an on-premises install, or help connecting PTD to the systems
        you already run. Tell us which, and roughly how big, and a person replies.
      </p>
      <ContactForm className="mt-6" />
    </div>
  );
}
