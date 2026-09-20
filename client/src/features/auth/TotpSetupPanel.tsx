// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useEffect, useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { CopyLine, ErrorNote, Field, Note, Submit } from "./bits";
import { beginTotpEnrolment, finishTotpEnrolment, getAccountSecurity, type AccountSecurity, type TotpEnrolment } from "./api";

/**
 * Enrolment, on the sign-in page.
 *
 * An organization that requires two-factor authentication refuses every
 * org-scoped call from a member who does not have it — including the ones the Org
 * surface needs to draw itself, and including the role check that would let them
 * in there at all. So the page that fixes the problem cannot live behind that
 * surface. It lives here, needs nothing but the session token, and works for a
 * member exactly as it does for an owner.
 *
 * The QR is an `<img src="data:image/svg+xml,…">` rather than inlined markup: an
 * image cannot execute script, so the server's SVG stays data rather than DOM.
 */
export default function TotpSetupPanel({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<AccountSecurity | null>(null);
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getAccountSecurity()
      .then((s) => {
        if (!live) return;
        setState(s);
        if (!s.totpEnabled) return beginTotpEnrolment().then((e) => live && setEnrolment(e));
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not start the setup"));
    return () => {
      live = false;
    };
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await finishTotpEnrolment(code.replace(/\D/g, ""));
      setCodes(result.recoveryCodes);
      setEnrolment(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That code was not accepted");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <div className="space-y-5" data-testid="setup-recovery">
        <p className="border border-vermilion/50 bg-vermilion/5 px-3 py-2 text-[0.9rem] leading-relaxed text-ink-muted">
          <span className="eyebrow mb-1 block text-vermilion">Shown once</span>
          Ten recovery codes. Each works once, in place of a code from the app — they are how you get back in if the phone is
          lost. Copy them somewhere that is not that phone.
        </p>
        <div className="grid grid-cols-2 gap-1.5 font-mono text-[0.85rem]" data-testid="setup-recovery-codes">
          {codes.map((c) => (
            <span key={c} className="border border-rule bg-card px-2 py-1 text-center tracking-[0.08em]">
              {c}
            </span>
          ))}
        </div>
        <CopyLine value={codes.join("\n")} />
        <button
          type="button"
          onClick={onDone}
          className="focus-ink group flex w-full items-center justify-center gap-2 border border-ink bg-ink px-5 py-3 font-numeric text-[11px] uppercase tracking-[0.18em] text-parchment transition-all duration-150 hover:-translate-x-px hover:-translate-y-px hover:bg-parchment hover:text-ink hover:shadow-stamp"
          data-testid="setup-done"
        >
          I have saved them — take me in
        </button>
      </div>
    );
  }

  if (state?.totpEnabled) {
    return (
      <div className="space-y-5" data-testid="setup-already-on">
        <Note>
          <span className="mr-1.5 inline-flex items-center gap-1.5 align-middle text-ink">
            <ShieldCheck className="h-3.5 w-3.5 text-vermilion" />
            <span className="microcaps">Already on</span>
          </span>
          Two-factor authentication is on for this account, with {state.recoveryCodesLeft} recovery code
          {state.recoveryCodesLeft === 1 ? "" : "s"} left.
        </Note>
        <button
          type="button"
          onClick={onDone}
          className="focus-ink font-numeric text-[11px] uppercase tracking-[0.18em] text-ink-muted hover:text-ink"
        >
          Continue to PTD &rarr;
        </button>
      </div>
    );
  }

  if (!enrolment) {
    return (
      <div className="py-8 text-center" data-testid="setup-loading">
        {error ? <ErrorNote>{error}</ErrorNote> : <Loader2 className="mx-auto h-4 w-4 animate-spin text-ink-muted" />}
      </div>
    );
  }

  const required = state?.orgs.filter((o) => o.requireTotp).map((o) => o.name) ?? [];

  return (
    <form
      className="space-y-5"
      data-testid="setup-step"
      onSubmit={(e) => {
        e.preventDefault();
        void confirm();
      }}
    >
      {required.length > 0 && (
        <p className="border border-vermilion/50 bg-vermilion/5 px-3 py-2 text-[0.9rem] leading-relaxed text-ink-muted" data-testid="setup-required">
          <span className="mr-1.5 inline-flex items-center gap-1.5 align-middle text-vermilion">
            <ShieldAlert className="h-3.5 w-3.5" />
            <span className="microcaps">Required</span>
          </span>
          {required.join(", ")} {required.length === 1 ? "requires" : "require"} two-factor authentication. Finish this and you
          are back in.
        </p>
      )}

      <div className="flex flex-col items-start gap-4 sm:flex-row">
        <img
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(enrolment.qrSvg)}`}
          alt="QR code for your authenticator app"
          width={168}
          height={168}
          className="shrink-0 border border-rule bg-white p-1"
          data-testid="setup-qr"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-[0.9rem] leading-relaxed text-ink-muted">
            Scan this with an authenticator app, or type the secret in by hand. Then enter the six digits it shows.
          </p>
          <CopyLine value={enrolment.secret} />
          <p className="text-[0.75rem] text-ink-muted">
            {enrolment.account} · SHA1 · {enrolment.digits} digits · {enrolment.period}s
          </p>
        </div>
      </div>

      <Field label="Code from the app" hint="Six digits, good for thirty seconds">
        <input
          className="draft-input w-full text-center font-mono text-[1.5rem] tracking-[0.45em]"
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          data-testid="setup-code-input"
        />
      </Field>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Submit busy={busy} disabled={code.length !== 6}>
        Turn it on
      </Submit>
    </form>
  );
}
