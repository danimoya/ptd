import { useState } from "react";
import { ErrorNote, Field, Submit } from "./bits";
import { keepSession, resetPassword } from "./api";

/**
 * `?reset=…` — set a new password and come in.
 *
 * The confirmation field is not theatre: this is the one form in PTD where a typo
 * cannot be recovered by trying again, because the token is spent on submission.
 * A successful reset signs the caller in, on the reasoning that they have just
 * proved control of the mailbox the account is bound to.
 */
export default function ResetPanel({ token, onDone, onBack }: { token: string; onDone: () => void; onBack: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async () => {
    if (password !== confirm) {
      setError("Those two passwords are not the same.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await resetPassword(token, password);
      keepSession(res.token, res.user?.email);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That link could not be used");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="reset-form"
    >
      <p className="border border-rule bg-card p-4 text-[0.9rem] leading-relaxed text-ink-muted">
        Choose a new password. The link you followed works once, and setting a password here cancels every other reset link
        outstanding on the account.
      </p>

      <Field label="New password" hint="At least eight characters">
        <input
          type="password"
          className="draft-input w-full font-mono"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          data-testid="reset-password"
        />
      </Field>

      <Field label="Again" hint={mismatch ? <span className="text-vermilion">not the same</span> : undefined}>
        <input
          type="password"
          className="draft-input w-full font-mono"
          placeholder="••••••••"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          data-testid="reset-confirm"
        />
      </Field>

      {tooShort && <ErrorNote>Eight characters is the minimum.</ErrorNote>}
      {error && <ErrorNote>{error}</ErrorNote>}

      <Submit busy={busy} disabled={password.length < 8 || password !== confirm}>
        Set the password and sign in
      </Submit>

      <div className="flex flex-col items-start gap-1 border-t border-rule pt-3">
        <button type="button" onClick={onBack} className="focus-ink py-1 text-[0.9rem] text-ink-muted transition-colors hover:text-ink">
          Cancel — back to sign in
        </button>
      </div>
    </form>
  );
}
