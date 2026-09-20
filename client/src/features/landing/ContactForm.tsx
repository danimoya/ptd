// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { InkButton } from "./chrome";

/* ─────────────────────────────────────────────────────────────────────────
 * The enquiry form behind the third pricing column.
 *
 * It answers in place — no page, no modal, no redirect. Three outcomes, all
 * of them said plainly:
 *
 *   sent      the letter is on its way, reply-to set to whoever filled this in;
 *   queued:false  the server took the enquiry but SMTP is not configured or
 *                 refused it, so the form hands back an address to write to
 *                 instead of pretending;
 *   invalid   the field that is wrong says what is wrong, under the field.
 *
 * `website` is the honeypot. It is off-screen rather than `display:none`,
 * because a scraper that parses CSS skips what is hidden and fills what is
 * merely far away.
 * ───────────────────────────────────────────────────────────────────────── */

export const ORG_SIZES = ["1–10", "11–50", "51–200", "201–1000", "1000+"] as const;

export const NEEDS = [
  { key: "hosted", label: "Hosted at scale", hint: "past the 100-member cap" },
  { key: "on-prem", label: "On-premises", hint: "inside your own network" },
  { key: "consulting", label: "Implementation & integration", hint: "connect it to what you run" },
] as const;

export type NeedKey = (typeof NEEDS)[number]["key"];

export const FALLBACK_EMAIL = "me@danimoya.com";

type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "unsent"; address: string }
  | { kind: "error"; message: string };

export interface Draft {
  name: string;
  email: string;
  company: string;
  orgSize: string;
  need: NeedKey;
  message: string;
  website: string;
}

export const EMPTY: Draft = {
  name: "",
  email: "",
  company: "",
  orgSize: "11–50",
  need: "hosted",
  message: "",
  website: "",
};

export default function ContactForm({ className }: { className?: string }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const ids = useId();

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (state.kind === "sending") return;
    setState({ kind: "sending" });
    setFieldErrors({});
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (res.status === 400) {
        const details = (body as any)?.details?.fieldErrors ?? {};
        setFieldErrors(details);
        setState({ kind: "error", message: "Some of that did not go through. The fields below say why." });
        return;
      }
      if (!res.ok) {
        setState({
          kind: "error",
          message:
            res.status === 429
              ? "That is more enquiries than we accept from one address in a quarter of an hour. Write to us directly instead."
              : "The server would not take that. Write to us directly instead.",
        });
        return;
      }
      if ((body as any)?.queued === false) {
        setState({ kind: "unsent", address: String((body as any)?.contactEmail || FALLBACK_EMAIL) });
        return;
      }
      setState({ kind: "sent" });
    } catch {
      setState({
        kind: "error",
        message: "That request did not leave the browser. Check the connection, or write to us directly.",
      });
    }
  }

  if (state.kind === "sent") {
    return (
      <div className={cn("border-t-2 border-ink pt-5", className)} data-testid="contact-sent" aria-live="polite">
        <h4 className="font-display text-[1.5rem] tracking-[-0.02em] text-ink">That is with us</h4>
        <p className="mt-2 max-w-[34rem] text-[1rem] leading-relaxed text-ink-muted text-pretty">
          A person reads these, usually within a working day. The reply comes to{" "}
          <span className="font-numeric text-[0.85rem] text-ink">{draft.email}</span>.
        </p>
      </div>
    );
  }

  if (state.kind === "unsent") {
    return (
      <div
        className={cn("border-t-2 border-vermilion pt-5", className)}
        data-testid="contact-unsent"
        aria-live="polite"
      >
        <h4 className="font-display text-[1.5rem] tracking-[-0.02em] text-ink">We could not send that</h4>
        <p className="mt-2 max-w-[34rem] text-[1rem] leading-relaxed text-ink-muted text-pretty">
          Mail is not configured on this instance, so nothing left the building. Write to{" "}
          <a
            href={`mailto:${state.address}`}
            className="focus-ink font-numeric text-[0.85rem] text-vermilion underline underline-offset-4"
          >
            {state.address}
          </a>{" "}
          and say the same thing — it reaches the same desk.
        </p>
        <button
          type="button"
          onClick={() => setState({ kind: "idle" })}
          className="focus-ink mt-4 font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted underline underline-offset-4 hover:text-ink"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <form className={cn("min-w-0", className)} onSubmit={submit} noValidate data-testid="contact-form">
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        <Field
          id={`${ids}-name`}
          label="Your name"
          value={draft.name}
          onChange={(v) => set("name", v)}
          autoComplete="name"
          errors={fieldErrors.name}
        />
        <Field
          id={`${ids}-email`}
          label="Work email"
          type="email"
          value={draft.email}
          onChange={(v) => set("email", v)}
          autoComplete="email"
          errors={fieldErrors.email}
        />
        <Field
          id={`${ids}-company`}
          label="Company"
          value={draft.company}
          onChange={(v) => set("company", v)}
          autoComplete="organization"
          optional
          errors={fieldErrors.company}
        />
        <div className="min-w-0">
          <label
            htmlFor={`${ids}-size`}
            className="font-numeric block text-[10px] uppercase tracking-[0.14em] text-ink-muted"
          >
            Organization size
          </label>
          <select
            id={`${ids}-size`}
            name="orgSize"
            value={draft.orgSize}
            onChange={(e) => set("orgSize", e.target.value)}
            className="draft-input focus-ink mt-1.5 w-full text-[0.95rem]"
          >
            {ORG_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} people
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="mt-6 border-t border-rule pt-4">
        <legend className="font-numeric px-0 text-[10px] uppercase tracking-[0.14em] text-ink-muted">
          What you need
        </legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {NEEDS.map((n) => (
            <label
              key={n.key}
              className={cn(
                "flex cursor-pointer flex-col border px-3 py-2.5 transition-colors",
                draft.need === n.key
                  ? "border-ink bg-parchment-deep/50 text-ink"
                  : "border-rule text-ink-muted hover:border-ink/50"
              )}
            >
              <span className="flex items-baseline gap-2">
                <input
                  type="radio"
                  name="need"
                  value={n.key}
                  checked={draft.need === n.key}
                  onChange={() => set("need", n.key)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-1 h-2 w-2 shrink-0 border",
                    draft.need === n.key ? "border-vermilion bg-vermilion" : "border-ink/40"
                  )}
                />
                <span className="text-[0.95rem] leading-snug text-ink">{n.label}</span>
              </span>
              <span className="font-numeric mt-1 pl-4 text-[10px] leading-snug text-ink-muted">{n.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5">
        <label
          htmlFor={`${ids}-message`}
          className="font-numeric block text-[10px] uppercase tracking-[0.14em] text-ink-muted"
        >
          What you would like to happen
        </label>
        <textarea
          id={`${ids}-message`}
          name="message"
          rows={5}
          value={draft.message}
          onChange={(e) => set("message", e.target.value)}
          className="draft-input focus-ink mt-1.5 w-full resize-y text-[0.95rem] leading-relaxed"
          placeholder="Roughly how many people and agents, which systems it has to talk to, and when you need it."
        />
        <FieldErrors errors={fieldErrors.message} />
      </div>

      {/* The honeypot. Off-screen, never announced, never focusable. */}
      <div aria-hidden="true" className="pointer-events-none absolute left-[-9999px] h-px w-px overflow-hidden">
        <label htmlFor={`${ids}-website`}>Website</label>
        <input
          id={`${ids}-website`}
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={draft.website}
          onChange={(e) => set("website", e.target.value)}
        />
      </div>

      {state.kind === "error" && (
        <p
          data-testid="contact-error"
          aria-live="polite"
          className="mt-5 border-l-2 border-vermilion pl-3 text-[0.9rem] leading-relaxed text-vermilion"
        >
          {state.message}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-rule pt-5">
        <InkButton type="submit" testId="contact-submit" disabled={state.kind === "sending"}>
          {state.kind === "sending" ? "Sending" : "Send the enquiry"}
        </InkButton>
        <span className="font-numeric text-[10px] leading-relaxed text-ink-muted">
          It goes to one inbox. No list, no sequence, no tracking pixel.
        </span>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  optional,
  errors,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  optional?: boolean;
  errors?: string[];
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="font-numeric block text-[10px] uppercase tracking-[0.14em] text-ink-muted">
        {label}
        {optional && <span className="ml-1.5 normal-case tracking-normal opacity-70">optional</span>}
      </label>
      <input
        id={id}
        name={id.split("-").pop()}
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={errors && errors.length > 0 ? true : undefined}
        className={cn("draft-input focus-ink mt-1.5 w-full text-[0.95rem]", errors?.length && "border-vermilion")}
      />
      <FieldErrors errors={errors} />
    </div>
  );
}

function FieldErrors({ errors }: { errors?: string[] }) {
  if (!errors?.length) return null;
  return (
    <p className="mt-1.5 text-[0.85rem] leading-snug text-vermilion">{errors[0]}</p>
  );
}
