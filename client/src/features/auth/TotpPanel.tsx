// Classic JSX transform (tsconfig keeps jsx: "preserve"), so React must be in scope.
import React, { useEffect, useRef, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { ErrorNote, Field, Note, Submit } from "./bits";
import { totpLogin, type MfaChallenge } from "./api";

/**
 * Step two of a sign-in: the six digits, or one recovery code.
 *
 * The password already checked out — this panel holds a five-minute token and
 * nothing else, so there is nothing here worth stealing and no reason to hide how
 * it works. Two deliberate details:
 *
 *  - The code field is `inputMode="numeric"` with `autoComplete="one-time-code"`,
 *    which is what lets iOS and Android offer the code from the notification.
 *  - Six digits submit on their own. Typing a code and then hunting for a button
 *    is the whole friction of 2FA, and the form is one field long.
 */
export default function TotpPanel({
  challenge,
  onSession,
  onCancel,
}: {
  challenge: MfaChallenge;
  onSession: (token: string, email?: string, note?: string) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(challenge.expiresInSeconds);
  const field = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    field.current?.focus();
  }, [useRecovery]);

  // The pre-auth token expires; a visible countdown is kinder than a sudden
  // "that sign-in took too long" after typing a code.
  useEffect(() => {
    const timer = window.setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const submit = async (value?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await totpLogin({
        preAuthToken: challenge.preAuthToken,
        ...(useRecovery ? { recoveryCode: (value ?? recovery).trim() } : { code: (value ?? code).replace(/\D/g, "") }),
      });
      onSession(
        result.token,
        result.user?.email ?? challenge.email,
        result.usedRecoveryCode
          ? `Recovery code used — ${result.recoveryCodesLeft} left. Mint a new set under Org → Security.`
          : undefined,
      );
    } catch (e) {
      submitted.current = false;
      setError(e instanceof Error ? e.message : "That code was not accepted");
      setCode("");
      field.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const onCodeChange = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && !submitted.current) {
      submitted.current = true;
      void submit(digits);
    }
  };

  const expired = left <= 0;

  return (
    <form
      className="space-y-5"
      data-testid="totp-step"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Note testId="totp-intro">
        <span className="mr-1.5 inline-flex items-center gap-1.5 align-middle text-ink">
          <ShieldCheck className="h-3.5 w-3.5 text-vermilion" />
          <span className="microcaps">Second factor</span>
        </span>
        {challenge.provider
          ? `${challenge.email ?? "That account"} signed in with ${challenge.provider}, and has two-factor authentication on.`
          : `The password for ${challenge.email ?? "that account"} was right. One more step.`}
      </Note>

      {useRecovery ? (
        <Field label="Recovery code" hint="One of the ten you saved. Each works once.">
          <input
            ref={field}
            className="draft-input w-full font-mono tracking-[0.12em]"
            placeholder="abcde-fghij"
            value={recovery}
            onChange={(e) => setRecovery(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
            data-testid="totp-recovery-input"
          />
        </Field>
      ) : (
        <Field label="Six-digit code" hint={expired ? "This step has expired" : `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}>
          <input
            ref={field}
            className="draft-input w-full text-center font-mono text-[1.6rem] tracking-[0.5em]"
            placeholder="000000"
            value={code}
            onChange={(e) => onCodeChange(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            required
            data-testid="totp-code-input"
          />
        </Field>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
      {expired && !error && <ErrorNote>This step has expired — sign in again to get a new one.</ErrorNote>}

      <Submit busy={busy} disabled={expired || (useRecovery ? recovery.trim().length < 8 : code.length !== 6)}>
        {useRecovery ? "Use recovery code" : "Sign in"}
      </Submit>

      <div className="flex flex-col items-start gap-1 border-t border-rule pt-3">
        <button
          type="button"
          onClick={() => {
            setUseRecovery((v) => !v);
            setError(null);
            submitted.current = false;
          }}
          className="focus-ink inline-flex items-center gap-1.5 py-1 text-[0.9rem] text-ink-muted transition-colors hover:text-ink"
          data-testid="totp-toggle-recovery"
        >
          <KeyRound className="h-3.5 w-3.5" />
          {useRecovery ? "Use the code from your authenticator instead" : "Lost the device? Use a recovery code"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ink py-1 text-[0.9rem] text-ink-muted transition-colors hover:text-ink"
          data-testid="totp-cancel"
        >
          Start over
        </button>
      </div>
    </form>
  );
}
