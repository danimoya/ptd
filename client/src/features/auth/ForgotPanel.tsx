import { useState } from "react";
import { CopyLine, ErrorNote, Field, Note, Submit } from "./bits";
import { forgotPassword } from "./api";

/**
 * "Forgot password?" — ask for a link.
 *
 * The answer is the same whether or not the address has an account, because the
 * server refuses to say; so the panel says the same thing back. The only extra is
 * the link itself, which a development deployment with no SMTP configured returns
 * so the flow can be finished without a mail server.
 */
export default function ForgotPanel({ email, onEmail, onBack }: { email: string; onEmail: (v: string) => void; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ message: string; resetUrl?: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await forgotPassword(email.trim());
      setSent({ message: res.message, resetUrl: res.resetUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not ask for a reset");
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="space-y-5" data-testid="forgot-sent">
        <Note testId="forgot-message">{sent.message}</Note>
        {sent.resetUrl ? (
          <div className="space-y-2">
            <p className="text-[0.85rem] leading-relaxed text-ink-muted">
              This deployment has no mail server configured, so the link is here instead. It is valid for thirty minutes and can be
              used once.
            </p>
            <CopyLine value={sent.resetUrl} />
            <a
              href={sent.resetUrl}
              className="focus-ink font-numeric inline-block text-[11px] uppercase tracking-[0.18em] text-vermilion hover:text-ink"
            >
              Open it now &rarr;
            </a>
          </div>
        ) : (
          <p className="text-[0.85rem] leading-relaxed text-ink-muted">
            The link is valid for thirty minutes and can be used once. If nothing arrives, check the spam folder before asking again.
          </p>
        )}
        <button
          type="button"
          onClick={onBack}
          className="focus-ink border-t border-rule pt-3 text-[0.9rem] text-ink-muted transition-colors hover:text-ink"
        >
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="border border-rule bg-card p-4 text-[0.9rem] leading-relaxed text-ink-muted">
        Give the address you sign in with. If it has an account, a single-use link arrives by mail; it expires in thirty minutes.
      </p>

      <Field label="Email">
        <input
          type="email"
          className="draft-input w-full"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => onEmail(e.target.value)}
          required
          autoComplete="email"
          data-testid="forgot-email"
        />
      </Field>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Submit busy={busy} disabled={!email.trim()}>
        Send the link
      </Submit>

      <div className="flex flex-col items-start gap-1 border-t border-rule pt-3">
        <button type="button" onClick={onBack} className="focus-ink py-1 text-[0.9rem] text-ink-muted transition-colors hover:text-ink">
          Remembered it? Sign in
        </button>
      </div>
    </form>
  );
}
