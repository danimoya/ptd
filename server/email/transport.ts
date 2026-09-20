/**
 * SMTP configuration and the one nodemailer transport PTD sends through.
 *
 * Mail is an *optional* capability. A self-hoster who never sets SMTP_HOST still
 * gets working invitations (the link is in the API response and the Org tab) and
 * a working password reset (the token comes back in the response in development);
 * they simply get no mail. So nothing in this file throws on a missing variable:
 * the transport is `null`, `sendMail` returns `{ sent: false, reason:
 * "smtp_not_configured" }`, and one line is printed at startup saying so.
 *
 * The self-signed-certificate switch is deliberate. Mailcow's submission port
 * commonly presents a certificate for the mail host rather than the submission
 * host, which Node rejects; SMTP_ACCEPT_INVALID_CERTS=1 is the documented way out
 * for that deployment, and it is opt-in because it does turn off verification.
 */

import nodemailer, { type Transporter } from "nodemailer";

export interface SmtpEnv {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Envelope From, e.g. `PTD <no-reply@example.com>`. */
  from: string;
  /** true = implicit TLS (port 465). false = plain connect then STARTTLS. */
  secure: boolean;
  acceptInvalidCerts: boolean;
}

const env = (name: string): string => (process.env[name] ?? "").trim();

/** `1`, `true`, `yes`, `on` — anything else is false, including "" and "0". */
export function envFlag(name: string): boolean {
  const raw = env(name).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function smtpEnv(): SmtpEnv {
  const secure = envFlag("SMTP_SECURE");
  const port = Number.parseInt(env("SMTP_PORT"), 10);
  const host = env("SMTP_HOST");
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : secure ? 465 : 587,
    user: env("SMTP_USER"),
    pass: env("SMTP_PASS"),
    from: env("SMTP_FROM") || (host ? `PTD <no-reply@${host}>` : "PTD <no-reply@localhost>"),
    secure,
    acceptInvalidCerts: envFlag("SMTP_ACCEPT_INVALID_CERTS"),
  };
}

/** One variable decides it: without a host there is nowhere to send. */
export function isEmailConfigured(e: SmtpEnv = smtpEnv()): boolean {
  return e.host !== "";
}

/** The public origin every link in an email is built from. */
export function appBaseUrl(): string {
  const configured = env("PTD_BASE_URL").replace(/\/+$/, "");
  if (configured) return configured;
  const port = env("PORT") || "3000";
  return `http://localhost:${port}`;
}

/* ── The transport ───────────────────────────────────────────────────── */

let cached: Transporter | null | undefined;
let overridden = false;

/**
 * The memoised transport, or null when SMTP is not configured.
 *
 * Memoised because nodemailer pools connections, and building a transport per
 * message would open a TCP connection per invitation.
 */
export function emailTransport(): Transporter | null {
  if (overridden) return cached ?? null;
  if (cached !== undefined) return cached;
  const e = smtpEnv();
  if (!isEmailConfigured(e)) {
    cached = null;
    return null;
  }
  cached = nodemailer.createTransport({
    host: e.host,
    port: e.port,
    secure: e.secure,
    // STARTTLS is required on submission ports, but port 25 relays are often
    // plaintext on a private network, so it is not forced there.
    requireTLS: !e.secure && e.port !== 25,
    ...(e.user ? { auth: { user: e.user, pass: e.pass } } : {}),
    ...(e.acceptInvalidCerts ? { tls: { rejectUnauthorized: false } } : {}),
  });
  return cached;
}

/** Tests inject nodemailer's JSON transport here; production never calls this. */
export function setEmailTransport(transport: Transporter | null): void {
  cached = transport;
  overridden = true;
}

export function resetEmailTransport(): void {
  cached = undefined;
  overridden = false;
}

/* ── The startup notice ──────────────────────────────────────────────── */

let announced = false;

/** One line, once, so "why did no invitation arrive?" is answered by the log. */
export function announceEmailConfig(log: (message: string) => void = (m) => console.log(m)): void {
  if (announced) return;
  announced = true;
  const e = smtpEnv();
  if (!isEmailConfigured(e)) {
    log("[email] SMTP not configured (set SMTP_HOST) — invitations and password resets will not be mailed; their links are returned by the API instead.");
    return;
  }
  log(
    `[email] SMTP ${e.host}:${e.port} ${e.secure ? "implicit TLS" : "STARTTLS"}${e.user ? ` as ${e.user}` : " (no auth)"}` +
      `${e.acceptInvalidCerts ? ", accepting invalid certificates" : ""} — from ${e.from}`
  );
}
