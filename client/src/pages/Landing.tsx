// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React from "react";
import { Link } from "react-router-dom";
import PoweredBy from "@/components/PoweredBy";
import { Folio, Footnote, Heading, InkButton, Measure } from "@/features/landing/chrome";
import LedgerGlimpse from "@/features/landing/LedgerGlimpse";
import PriorityCalculator from "@/features/landing/PriorityCalculator";
import CascadeGlimpse from "@/features/landing/CascadeGlimpse";
import DoorsPanel from "@/features/landing/DoorsPanel";
import SeatSnippets from "@/features/landing/SeatSnippets";
import SurfaceTour from "@/features/landing/SurfaceTour";

/* ─────────────────────────────────────────────────────────────────────────
 * PTD — the public page.
 *
 * Built as a ledger book: a running head, numbered folios down the left
 * rail, ruled forms instead of cards, and one motion moment at the top.
 * Five of the folios are working instruments — a visitor can start a
 * session, score a card, slip a plan, swap credentials and copy the lines
 * that seat an agent, all without an account and without a request leaving
 * the page.
 * ───────────────────────────────────────────────────────────────────────── */

const REGISTER = "/auth?mode=register";
const GITHUB = "https://github.com/danimoya/ptd";

export default function Landing() {
  return (
    <div className="grain relative min-h-[100dvh]">
      <div className="relative z-10">
        <RunningHead />
        <TitlePage />

        <Folio id="why" mark="I">
          <Heading
            title="Half the team has no chair"
            lede="Work already goes to agents. The work comes back; the accounting does not. Nobody can say which task an agent touched, how long it ran, or what the tokens cost — so the agent's share of the month is a guess."
          />

          <div className="mt-10 grid gap-8 lg:grid-cols-[23rem_minmax(0,1fr)] lg:gap-12">
            <div className="min-w-0">
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">Human and agent work in the seeded demo organization</caption>
                <thead>
                  <tr className="border-b border-ink/70">
                    <th scope="col" className="eyebrow py-2 pr-2 text-[10px] font-normal">
                      Source
                    </th>
                    <th scope="col" className="eyebrow px-2 py-2 text-right text-[10px] font-normal">
                      Min
                    </th>
                    <th scope="col" className="eyebrow px-2 py-2 text-right text-[10px] font-normal">
                      Tokens
                    </th>
                    <th scope="col" className="eyebrow py-2 pl-2 text-right text-[10px] font-normal">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody className="font-numeric text-[13px] tabular-nums">
                  <tr className="border-b border-rule">
                    <th scope="row" className="py-3 pr-2 text-left font-normal text-ink">
                      Human
                    </th>
                    <td className="px-2 py-3 text-right text-ink">1,570</td>
                    <td className="px-2 py-3 text-right text-ink-muted">—</td>
                    <td className="py-3 pl-2 text-right text-ink-muted">—</td>
                  </tr>
                  <tr>
                    <th scope="row" className="py-3 pr-2 text-left font-normal text-vermilion">
                      Agent
                    </th>
                    <td className="px-2 py-3 text-right text-vermilion">309</td>
                    <td className="px-2 py-3 text-right text-vermilion">958,300</td>
                    <td className="py-3 pl-2 text-right text-vermilion">$12.87</td>
                  </tr>
                </tbody>
              </table>
              <Footnote>
                From the seeded demo organization. Nobody typed the agent column in — it is stamped from the
                credential that made each call.
              </Footnote>
            </div>

            <figure className="min-w-0">
              <div className="aspect-[16/10] w-full overflow-hidden border border-ink/70 bg-parchment-deep/40">
                <picture>
                  <source media="(max-width: 640px)" srcSet="/landing/agent-spend@sm.webp" type="image/webp" />
                  <img
                    src="/landing/agent-spend.webp"
                    alt="PTD's Overview surface showing agent minutes, tokens and cost broken down by stream"
                    width={1280}
                    height={800}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover object-top"
                  />
                </picture>
              </div>
              <Footnote>Agent spend, by stream, read straight off the same entries the day ledger shows.</Footnote>
            </figure>
          </div>
        </Folio>

        <Folio id="surfaces" mark="II">
          <Heading
            title="Four surfaces, one task"
            lede="A card scored in Overview is the card dragged in Plan and the card a timer runs against in Track. There is no second copy to reconcile."
          />
          <SurfaceTour className="mt-10" />
        </Folio>

        <Folio id="priority" mark="III">
          <Heading
            title="Every card carries a number"
            lede="Three questions anyone on the team can answer, turned into one figure the backlog sorts on. Move the sliders — the arithmetic is the same one the server keeps."
          />
          <PriorityCalculator className="mt-8 max-w-3xl" />
        </Folio>

        <Folio id="cascade" mark="IV">
          <Heading
            title="Move one card, move the plan"
            lede="Dependencies are dates, not decoration. Push the first card later and everything behind it is recomputed before you commit to it."
          />
          <CascadeGlimpse className="mt-8 max-w-4xl" />
        </Folio>

        <Folio id="doors" mark="V">
          <Heading
            title="One action, every door"
            lede="An action is written once, with the role it needs. MCP serves it at /mcp, REST at /api/actions, Slack as /ptd, and Claude.ai or ChatGPT connectors attach over OAuth 2.1. Swap the credential and watch the same call change its answer."
          />
          <DoorsPanel className="mt-8 max-w-3xl" />
        </Folio>

        <Folio id="seat" mark="VI">
          <Heading
            title="Give your agent a seat"
            lede="An agent is a member with a role, not an integration. It registers itself with an invite code, gets a token, and from then on it is on the roll like anyone else — and on the ledger like anyone else."
          />
          <SeatSnippets className="mt-8 max-w-3xl" />
        </Folio>

        <Folio id="price" mark="VII">
          <Heading title="What it costs" lede="Two ways to run it. Neither charges you by the head." />

          <div className="mt-10 grid gap-10 md:grid-cols-2 md:gap-12">
            <div className="border-t-2 border-ink pt-5">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="font-display text-[1.5rem] tracking-[-0.02em] text-ink">Self-host</h3>
                <span className="font-numeric text-lg tabular-nums text-ink">Free</span>
              </div>
              <p className="mt-3 text-[0.98rem] leading-relaxed text-ink-muted text-pretty">
                MIT, the whole application. Two commands and it is yours, on your own hardware, with your own
                backups.
              </p>
              <pre className="nice-scroll mt-4 overflow-x-auto border border-rule bg-parchment-deep/50 p-3 font-mono text-[11px] leading-relaxed text-ink">
                {"git clone https://github.com/danimoya/ptd\ndocker compose up -d --build"}
              </pre>
              <p className="mt-3 text-[0.9rem] leading-relaxed text-ink-muted">
                Ships with HeliosDB-Nano, PostgreSQL-compatible, in the box. Stock PostgreSQL works if you would
                rather.
              </p>
            </div>

            <div className="border-t-2 border-vermilion pt-5">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="font-display text-[1.5rem] tracking-[-0.02em] text-ink">Hosted</h3>
                <span className="font-numeric text-lg tabular-nums text-vermilion">$15 / month</span>
              </div>
              <p className="mt-3 text-[0.98rem] leading-relaxed text-ink-muted text-pretty">
                Per organization, flat. Not per seat — put the whole team and every agent on it and the figure
                does not move. We run the database, the backups and the upgrades.
              </p>
              <div className="mt-5">
                <InkButton to={REGISTER}>Create an organization</InkButton>
              </div>
              <p className="font-numeric mt-3 text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Hosted billing is being switched on
              </p>
            </div>
          </div>
        </Folio>

        <Folio id="open" mark="VIII">
          <Heading
            title="Open at the core"
            lede="Nothing about this is a demo tier. The application is MIT, the database ships with it, and the wire is closed properly."
          />

          <dl className="mt-8 grid max-w-3xl gap-x-10 border-t border-ink/70 sm:grid-cols-2">
            {[
              ["Licence", "MIT — the whole application, not a hollowed-out core"],
              ["Database", "HeliosDB-Nano in the box, PostgreSQL-compatible; stock Postgres also works"],
              ["In transit", "TLS with the X25519MLKEM768 post-quantum hybrid"],
              ["Credentials", "SCRAM-SHA-256"],
              ["At rest", "AES-256-GCM"],
              ["Machine-readable", "OpenAPI 3.1, an MCP endpoint of 85 tools, and an agent manifest"],
            ].map(([term, desc]) => (
              <div key={term} className="border-b border-rule py-3">
                <dt className="eyebrow">{term}</dt>
                <dd className="mt-1 text-[0.95rem] leading-snug text-ink text-pretty">{desc}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <InkButton to={REGISTER}>Create an organization</InkButton>
            <a
              href={GITHUB}
              className="focus-ink font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted underline underline-offset-4 hover:text-ink"
            >
              Read the source
            </a>
          </div>
        </Folio>

        <Colophon />
      </div>
    </div>
  );
}

/** The running head: brand left, the way into the book right. */
function RunningHead() {
  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-parchment/90 backdrop-blur">
      <Measure className="flex items-center justify-between gap-4 py-2.5">
        <Link to="/welcome" className="focus-ink flex flex-col leading-none">
          <span className="eyebrow hidden text-[9px] text-vermilion/90 sm:block">Plan · Track · Done</span>
          <span className="font-display text-[22px] font-light tracking-tight sm:mt-0.5">
            <span className="font-semibold">PTD</span>
            <span className="text-vermilion">.</span>
          </span>
        </Link>
        <nav className="flex items-center gap-4">
          <a
            href="#price"
            className="focus-ink hidden font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink sm:inline"
          >
            Price
          </a>
          <a
            href={GITHUB}
            className="focus-ink hidden font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink sm:inline"
          >
            Source
          </a>
          <Link
            to="/auth"
            className="focus-ink hidden font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink sm:inline"
          >
            Sign in
          </Link>
          <InkButton to={REGISTER} className="px-3 py-2 sm:px-4">
            Create an organization
          </InkButton>
        </nav>
      </Measure>
    </header>
  );
}

/**
 * The title page. One orchestrated entrance here and nowhere else on the
 * page: the sentence settles, the rule draws, the day's page arrives.
 */
function TitlePage() {
  return (
    <Measure className="pb-14 pt-12 sm:pb-20 sm:pt-16 lg:pt-20">
      {/* The sentence runs the full measure; the em dash in it becomes the rule. */}
      <h1 className="reveal reveal-1 font-display text-[2.1rem] leading-[1.08] tracking-[-0.035em] text-ink sm:text-[3.25rem] sm:leading-[1.06] lg:text-[4rem] xl:text-[4.5rem]">
        <span className="block text-balance">Plan the work in one view,</span>
        <span className="block text-balance">log the work in the other.</span>
      </h1>

      <div className="reveal reveal-2 my-7 h-px w-full bg-ink/70 sm:my-9" />

      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_26rem] lg:gap-14">
        <div className="min-w-0">
          <p className="reveal reveal-3 max-w-[32rem] text-[1.15rem] leading-[1.6] text-ink text-pretty sm:text-[1.3rem]">
            Same task, same source of truth, whether a human or an agent did it.
          </p>

          <div className="reveal reveal-4 mt-8 flex flex-wrap items-center gap-4">
            <InkButton to={REGISTER}>Create an organization</InkButton>
            <a
              href="#seat"
              className="focus-ink font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted underline underline-offset-4 hover:text-ink"
            >
              Seat an agent instead
            </a>
          </div>

          <p className="reveal reveal-5 font-numeric mt-6 text-[11px] leading-relaxed text-ink-muted">
            Self-host free under MIT · hosted $15 a month per organization, flat
          </p>
        </div>

        <div className="reveal reveal-4 min-w-0">
          <LedgerGlimpse />
          <p className="font-numeric mt-3 text-[11px] leading-relaxed text-ink-muted">
            Try it: start a session as either one and watch where it lands.
          </p>
        </div>
      </div>
    </Measure>
  );
}

function Colophon() {
  return (
    <footer className="border-t border-ink/70">
      <Measure className="py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <span className="font-display text-xl font-light tracking-tight">
              <span className="font-semibold">PTD</span>
              <span className="text-vermilion">.</span>
            </span>
            <p className="font-display mt-1 max-w-xs text-sm italic leading-relaxed text-ink-muted">
              Plan the work in one view, log the work in the other.
            </p>
          </div>

          <nav aria-label="Machine-readable and source" className="grid gap-2 sm:text-right">
            {[
              [GITHUB, "GitHub"],
              ["/.well-known/ai-agent.json", "/.well-known/ai-agent.json"],
              ["/llms.txt", "/llms.txt"],
              ["/openapi.json", "/openapi.json"],
            ].map(([href, label]) => (
              <a
                key={label}
                href={href}
                className="focus-ink font-numeric text-[11px] text-ink-muted hover:text-vermilion"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-4">
          <span className="eyebrow text-[10px]">Open core · MIT</span>
          <PoweredBy />
          <span className="eyebrow text-[10px]">MMXXVI</span>
        </div>
      </Measure>
    </footer>
  );
}
