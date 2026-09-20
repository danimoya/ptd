// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React from "react";
import { Link } from "react-router-dom";
import PoweredBy from "@/components/PoweredBy";
import { Folio, Footnote, Heading, InkButton, Measure } from "@/features/landing/chrome";
import LedgerGlimpse from "@/features/landing/LedgerGlimpse";
import HalfThePicture from "@/features/landing/HalfThePicture";
import PriorityCalculator from "@/features/landing/PriorityCalculator";
import CascadeGlimpse from "@/features/landing/CascadeGlimpse";
import DoorsPanel from "@/features/landing/DoorsPanel";
import SeatSnippets from "@/features/landing/SeatSnippets";
import SurfaceTour from "@/features/landing/SurfaceTour";
import HybridFigures from "@/features/landing/HybridFigures";
import CertifiedInvoiceGlimpse from "@/features/landing/CertifiedInvoiceGlimpse";
import Pricing from "@/features/landing/Pricing";
import Faq from "@/features/landing/Faq";

/* ─────────────────────────────────────────────────────────────────────────
 * PTD — the public page.
 *
 * Built as a ledger book: a running head, numbered folios down the left
 * rail, ruled forms instead of cards, and one motion moment at the top.
 * The argument runs in the order the owner ranked it — the intersection
 * nobody else covers, then agents as members, then cost you can invoice,
 * then open core — and every claim that can be pressed has a working
 * instrument under it rather than an adjective.
 *
 * Seven of the folios hold something a visitor can drive without an account
 * and without a request leaving the page: a session, a score, a slip, a
 * credential swap, a cost cut, a tampered invoice, a price. The only form
 * that talks to the server is the enquiry behind the third pricing column.
 * ───────────────────────────────────────────────────────────────────────── */

const REGISTER = "/auth?mode=register";
const GITHUB = "https://github.com/danimoya/ptd";
const DOCS = "https://github.com/danimoya/ptd/tree/main/docs";

export default function Landing() {
  return (
    <div className="grain relative min-h-[100dvh]">
      <div className="relative z-10">
        <RunningHead />
        <TitlePage />

        <Folio id="picture" mark="I">
          <Heading
            title="Everyone else sees half the picture"
            lede="Planners know the work but not the hours. Trackers know the hours but not the dependencies, the agents or the tokens. Provider dashboards know the tokens but not the task, the person or the invoice. Monitoring tools prove a contractor was at the keyboard. PTD's claim is the intersection."
          />
          <HalfThePicture className="mt-10" />
        </Folio>

        <Folio id="members" mark="II">
          <Heading
            title="Agents are members, not plug-ins"
            lede="A role, a seat, a token. Every action an agent can take is the same registry a human uses, gated by the same role, served over MCP, REST, Slack, Telegram, Teams and the Claude.ai and ChatGPT connectors. Nobody else has this because nobody else's product is built as an action registry."
          />

          <Registry className="mt-10" />

          <div className="mt-10">
            <h3 className="font-display text-[1.5rem] tracking-[-0.02em] text-ink">Swap the credential</h3>
            <p className="mt-2 max-w-[34rem] text-[1rem] leading-relaxed text-ink-muted text-pretty">
              Pick a role and a door. The call is the same call; the answer changes because the role check lives
              on the action, not on the adapter.
            </p>
            <DoorsPanel className="mt-5 max-w-3xl" />
          </div>

          <div className="mt-12">
            <h3 className="font-display text-[1.5rem] tracking-[-0.02em] text-ink">Seat one in three steps</h3>
            <p className="mt-2 max-w-[34rem] text-[1rem] leading-relaxed text-ink-muted text-pretty">
              An agent registers itself with an invite code and is on the roll like anyone else — and on the
              ledger like anyone else.
            </p>
            <SeatSnippets className="mt-5 max-w-3xl" />
          </div>
        </Folio>

        <Folio id="cost" mark="III">
          <Heading
            title="Cost you can put on an invoice"
            lede="Minutes, tokens and dollars land on the task, the stream and the agent, under budgets that stop the work rather than warn about it. Then the invoice: lines frozen, hashed and signed at issue, and checkable by whoever holds the link."
          />

          <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-10">
            <HybridFigures />
            <figure className="min-w-0">
              <div className="aspect-[16/10] w-full overflow-hidden border border-ink/70 bg-parchment-deep/40">
                <picture>
                  <source media="(max-width: 640px)" srcSet="/landing/agent-spend@sm.webp" type="image/webp" />
                  <img
                    src="/landing/agent-spend.webp"
                    alt="PTD's Hybrid view: agent minutes, tokens and cost broken down by stream, against each stream's budget"
                    width={1280}
                    height={800}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover object-top"
                  />
                </picture>
              </div>
              <Footnote>
                Nobody typed the agent column in. It is stamped from the credential that made each call, and the
                token counts come from the session itself.
              </Footnote>
            </figure>
          </div>

          <div className="mt-12">
            <h3 className="font-display text-[1.5rem] tracking-[-0.02em] text-ink">
              Proof of work, not proof of presence
            </h3>
            <p className="mt-2 max-w-[38rem] text-[1rem] leading-relaxed text-ink-muted text-pretty">
              An external employee's hours are certified by the system — task links, cascade history, event log —
              and shared through a private verification link. Accountability without a single screenshot. Pad a
              line and watch what the link says.
            </p>
            <CertifiedInvoiceGlimpse className="mt-5" />
          </div>
        </Folio>

        <Folio id="open" mark="IV">
          <Heading
            title="Open core, yours to run"
            lede="MIT, one docker compose, and a database that arrives with post-quantum TLS and encryption at rest already configured. Nothing here is a demo tier."
          />

          <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-12">
            <div className="min-w-0">
              <pre className="nice-scroll overflow-x-auto border border-ink/70 bg-parchment-deep/50 p-4 font-mono text-[11px] leading-relaxed text-ink">
                {"git clone https://github.com/danimoya/ptd\ncd ptd\ndocker compose up -d --build"}
              </pre>
              <Footnote>
                Two commands and it is yours, with the database, the migrations and the seed in the box.
              </Footnote>

              <h3 className="font-display mt-10 text-[1.5rem] tracking-[-0.02em] text-ink">
                And from a terminal
              </h3>
              <p className="mt-2 max-w-[34rem] text-[1rem] leading-relaxed text-ink-muted text-pretty">
                The CLI is the registry with a prompt in front of it. Anything an agent can call, you can call.
              </p>
              <pre className="nice-scroll mt-4 overflow-x-auto border border-rule bg-parchment-deep/50 p-4 font-mono text-[11px] leading-relaxed text-ink">
                {"ptd login\nptd actions | grep invoice\nptd run task.complete --taskId 118"}
              </pre>
            </div>

            <div className="min-w-0">
              <dl className="border-t border-ink/70">
                {[
                  ["Licence", "MIT — the whole application, not a hollowed-out core"],
                  ["Database", "HeliosDB-Nano in the box; stock PostgreSQL also works"],
                  ["In transit", "TLS with the X25519MLKEM768 post-quantum hybrid"],
                  ["Credentials", "SCRAM-SHA-256"],
                  ["At rest", "AES-256-GCM"],
                  ["Machine-readable", "OpenAPI 3.1, an MCP endpoint and an agent manifest"],
                ].map(([term, desc]) => (
                  <div key={term} className="border-b border-rule py-3">
                    <dt className="eyebrow">{term}</dt>
                    <dd className="mt-1 text-[0.95rem] leading-snug text-ink text-pretty">{desc}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-6 flex flex-wrap items-center gap-4">
                <InkButton href={GITHUB}>Read the source</InkButton>
                <a
                  href={DOCS}
                  className="focus-ink font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted underline underline-offset-4 hover:text-ink"
                >
                  Docs
                </a>
              </div>
            </div>
          </div>
        </Folio>

        <Folio id="surfaces" mark="V">
          <Heading
            title="One organization, one task, four surfaces"
            lede="A card scored in Overview is the card dragged in Plan and the card a timer runs against in Track, under the roles set in Org. There is no second copy to reconcile."
          />
          <SurfaceTour
            className="mt-10"
            instruments={{
              overview: (
                <Instrument
                  title="Every card carries a number"
                  lede="Three questions anyone on the team can answer, turned into one figure the backlog sorts on. Move the sliders — the arithmetic is the same one the server keeps."
                >
                  <PriorityCalculator className="max-w-3xl" />
                </Instrument>
              ),
              plan: (
                <Instrument
                  title="Move one card, move the plan"
                  lede="Dependencies are dates, not decoration. Push the first card later and everything behind it is recomputed before you commit to it."
                >
                  <CascadeGlimpse className="max-w-4xl" />
                </Instrument>
              ),
            }}
          />
        </Folio>

        <Folio id="price" mark="VI">
          <Heading
            title="Flat, not per seat"
            lede="Per organization, not per head — and agent seats are free at every tier, because they pay their own API bill. A ten-person hybrid team pays roughly $150–250 a month today, across a planner and a tracker that cannot see each other."
          />
          <Pricing className="mt-10" />
        </Folio>

        <Folio id="faq" mark="VII">
          <Heading title="The questions that decide it" />
          <Faq className="mt-8" />

          <div className="mt-12 flex flex-wrap items-center gap-4 border-t border-ink/70 pt-8">
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

/* ── The running head ────────────────────────────────────────────────── */

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
          {[
            ["#members", "Agents"],
            ["#cost", "Cost"],
            ["#price", "Price"],
          ].map(([href, label]) => (
            <a
              key={label}
              href={href}
              className="focus-ink hidden font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink md:inline"
            >
              {label}
            </a>
          ))}
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
      {/* The sentence runs the full measure; the rule under it is the ledger's. */}
      <h1 className="reveal reveal-1 font-display text-[2.1rem] leading-[1.08] tracking-[-0.035em] text-ink sm:text-[3.25rem] sm:leading-[1.06] lg:text-[4rem] xl:text-[4.5rem]">
        <span className="block text-balance">The system of record</span>
        <span className="block text-balance">for hybrid work.</span>
      </h1>

      <div className="reveal reveal-2 my-7 h-px w-full bg-ink/70 sm:my-9" />

      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_26rem] lg:gap-14">
        <div className="min-w-0">
          <p className="reveal reveal-3 max-w-[32rem] text-[1.15rem] leading-[1.6] text-ink text-pretty sm:text-[1.3rem]">
            Not another project manager. One task, planned and logged in the same ledger, whether a human or an
            agent did it — with proof.
          </p>

          <div className="reveal reveal-4 mt-8 flex flex-wrap items-center gap-4">
            <InkButton to={REGISTER}>Create an organization</InkButton>
            <a
              href={GITHUB}
              className="focus-ink font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted underline underline-offset-4 hover:text-ink"
            >
              Read the source
            </a>
          </div>

          <p className="reveal reveal-5 font-numeric mt-6 text-[11px] leading-relaxed text-ink-muted">
            Self-host free under MIT · hosted $15 a month per organization, flat · agent seats free
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

/* ── The registry explainer ──────────────────────────────────────────── */

/**
 * The structural claim under message one, stated as four facts rather than
 * an adjective. The figure carries the weight; the four entries say why a
 * figure that size is possible at all.
 */
function Registry({ className }: { className?: string }) {
  return (
    <div className={className}>
      <div className="grid gap-8 border-t-2 border-ink pt-6 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-12">
        <div>
          <p className="font-display text-[3.5rem] leading-none tracking-[-0.04em] text-ink sm:text-[4.5rem]">
            150<span className="text-vermilion">+</span>
          </p>
          <p className="font-numeric mt-2 text-[10px] uppercase leading-relaxed tracking-[0.14em] text-ink-muted">
            actions in one registry
          </p>
        </div>
        <dl className="min-w-0 divide-y divide-rule border-y border-rule">
          {[
            [
              "One definition",
              "An action is written once: a name, its arguments, the role it needs, and the handler that does the work.",
            ],
            [
              "Every door",
              "MCP, REST, OpenAPI, Slack, Telegram, Teams, OAuth connectors, the CLI and the app's own surfaces all call that one definition. None of them is a special case.",
            ],
            [
              "One gate",
              "The role check sits on the definition, so no door can slip past it — and adding a door adds no new way in.",
            ],
            [
              "One stamp",
              "The stamp that says which of the two did the work is read off the credential the server authenticated, never from the request. Humans and agents are the same kind of member, told apart by how they signed in.",
            ],
          ].map(([term, desc]) => (
            <div key={term} className="py-3.5">
              <dt className="font-display text-[1.05rem] tracking-[-0.015em] text-ink">{term}</dt>
              <dd className="mt-1 max-w-[36rem] text-[0.95rem] leading-relaxed text-ink-muted text-pretty">
                {desc}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** A working glimpse set beneath a surface plate, with its own short head. */
function Instrument({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="font-display text-[1.4rem] tracking-[-0.02em] text-ink">{title}</h4>
      <p className="mt-2 max-w-[34rem] text-[1rem] leading-relaxed text-ink-muted text-pretty">{lede}</p>
      <div className="mt-5">{children}</div>
    </div>
  );
}

/* ── The colophon ────────────────────────────────────────────────────── */

function Colophon() {
  return (
    <footer className="border-t border-ink/70">
      <Measure className="py-10">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <span className="font-display text-xl font-light tracking-tight">
              <span className="font-semibold">PTD</span>
              <span className="text-vermilion">.</span>
            </span>
            <p className="font-display mt-1 max-w-xs text-sm italic leading-relaxed text-ink-muted">
              The system of record for hybrid work.
            </p>
          </div>

          <div className="grid gap-8 sm:grid-cols-2 sm:text-right">
            <nav aria-label="Source and documentation" className="grid gap-2">
              {[
                [GITHUB, "GitHub"],
                [DOCS, "Docs"],
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
            <nav aria-label="Machine-readable" className="grid gap-2">
              {[
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
