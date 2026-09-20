/**
 * The one place PTD hands a letter to SMTP.
 *
 * The contract every caller relies on: **this never throws**. Mail is a
 * side-effect of a request that has already succeeded — the invitation row is
 * written, the reset token is stored — so a refused connection or a bad password
 * must not turn a 201 into a 500. Every failure comes back as
 * `{ sent: false, reason }`, which the route reports alongside the thing that did
 * work, and which the Org tab prints as "invitation created, mail not sent".
 *
 * Reasons a caller may see:
 *   smtp_not_configured — SMTP_HOST is unset; nothing was attempted.
 *   smtp_error          — the transport refused it; `error` carries the message.
 */

import { announceEmailConfig, appBaseUrl, emailTransport, smtpEnv } from "./transport";
import { digestLetter, invitationLetter, passwordResetLetter, type DigestLetter, type InvitationLetter, type Letter, type ResetLetter } from "./templates";

export interface SendResult {
  sent: boolean;
  to: string;
  subject: string;
  reason?: "smtp_not_configured" | "smtp_error";
  error?: string;
  messageId?: string;
}

/** Send one letter. Returns the outcome; raises nothing. */
export async function sendLetter(to: string, letter: Letter): Promise<SendResult> {
  const base = { to, subject: letter.subject };
  // `emailTransport()` is null exactly when SMTP_HOST is unset, so one check
  // covers "not configured" — and a transport injected by a test is honoured
  // without also having to fake the environment it would have come from.
  const transport = emailTransport();
  if (!transport) return { ...base, sent: false, reason: "smtp_not_configured" };
  try {
    const info = (await transport.sendMail({
      from: smtpEnv().from,
      to,
      subject: letter.subject,
      text: letter.text,
      html: letter.html,
    })) as { messageId?: string };
    return { ...base, sent: true, messageId: info?.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Worth a line in the log: the caller only reports "not sent", and the
    // operator needs to know whether it was auth, TLS or DNS.
    console.error(`[email] could not send "${letter.subject}" to ${to}: ${message}`);
    return { ...base, sent: false, reason: "smtp_error", error: message };
  }
}

/* ── The links ───────────────────────────────────────────────────────── */

/** Where an invited person lands: the sign-in page, with the invitation in hand. */
export const invitationUrl = (token: string): string => `${appBaseUrl()}/auth?invite=${encodeURIComponent(token)}`;

/** Where a reset lands: the same page, in new-password mode. */
export const passwordResetUrl = (token: string): string => `${appBaseUrl()}/auth?reset=${encodeURIComponent(token)}`;

/* ── The three letters ───────────────────────────────────────────────── */

export function sendInvitationEmail(input: Omit<InvitationLetter, "acceptUrl"> & { token: string }): Promise<SendResult> {
  const { token, ...rest } = input;
  return sendLetter(input.email, invitationLetter({ ...rest, acceptUrl: invitationUrl(token) }));
}

export function sendPasswordResetEmail(input: Omit<ResetLetter, "resetUrl"> & { token: string }): Promise<SendResult> {
  const { token, ...rest } = input;
  return sendLetter(input.email, passwordResetLetter({ ...rest, resetUrl: passwordResetUrl(token) }));
}

export function sendDigestEmail(to: string, input: DigestLetter): Promise<SendResult> {
  return sendLetter(to, digestLetter(input));
}

// One line at boot, from the first module that needs mail. Says whether SMTP is
// configured, so "the invitation never arrived" is a log lookup, not a guess.
announceEmailConfig();
