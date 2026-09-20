/**
 * The letters PTD sends, set in the same ledger style as the application.
 *
 * Every template is a pure function of its arguments returning `{ subject, html,
 * text }`, so a test can assert on the words and the link without a transport,
 * and so the text part is never an afterthought — plenty of people read mail as
 * plain text, and a reset link that only exists inside a `<a href>` is a broken
 * reset for them.
 *
 * Constraints that shaped the markup: tables rather than flexbox, inline styles
 * rather than a stylesheet, hex rather than `hsl(var(--…))`, and no web fonts —
 * Outlook, Gmail and Apple Mail between them rule out everything else. The
 * palette is the application's: parchment, ink, vermilion, a hairline rule.
 */

export interface Letter {
  subject: string;
  html: string;
  text: string;
}

const PARCHMENT = "#F4F1EA";
const CARD = "#FBF9F4";
const INK = "#1A1510";
const INK_MUTED = "#6B6255";
const VERMILION = "#B8451A";
const RULE = "#D9D2C4";

const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";
const MONO = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";

/** Angle brackets and ampersands in a name or an org title must not become markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The shell every letter is printed on: masthead, body, hairline, footer.
 * `preheader` is the line inboxes show next to the subject; hiding it keeps the
 * letter itself from opening with a duplicate sentence.
 */
function layout(opts: { title: string; preheader: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:${PARCHMENT};color:${INK};font-family:${SERIF};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PARCHMENT};padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${CARD};border:1px solid ${RULE};">
        <tr>
          <td style="padding:22px 28px 14px 28px;border-bottom:1px solid ${RULE};">
            <div style="font-family:${MONO};font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${VERMILION};">Plan &middot; Track &middot; Done</div>
            <div style="font-family:${SERIF};font-size:26px;letter-spacing:-0.02em;margin-top:6px;color:${INK};"><strong>PTD</strong><span style="color:${VERMILION};">.</span></div>
          </td>
        </tr>
        <tr>
          <td style="padding:26px 28px 28px 28px;">
${opts.body}
          </td>
        </tr>
        <tr>
          <td style="padding:14px 28px 20px 28px;border-top:1px solid ${RULE};font-family:${MONO};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${INK_MUTED};">
            Same task, same source of truth &mdash; human or agent
          </td>
        </tr>
      </table>
      <div style="max-width:560px;margin:10px auto 0 auto;font-family:${MONO};font-size:10px;color:${INK_MUTED};text-align:left;">
        You received this because someone at your organization uses PTD. If it was not meant for you, ignore it.
      </div>
    </td>
  </tr>
</table>
</body>
</html>`;
}

const h1 = (text: string): string =>
  `<h1 style="margin:0 0 10px 0;font-family:${SERIF};font-size:27px;line-height:1.2;letter-spacing:-0.02em;font-weight:normal;color:${INK};">${escapeHtml(text)}</h1>`;

const p = (html: string): string =>
  `<p style="margin:0 0 14px 0;font-family:${SERIF};font-size:16px;line-height:1.6;color:${INK};">${html}</p>`;

const muted = (html: string): string =>
  `<p style="margin:0 0 14px 0;font-family:${SERIF};font-size:14px;line-height:1.6;color:${INK_MUTED};">${html}</p>`;

const eyebrow = (text: string): string =>
  `<div style="font-family:${MONO};font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${INK_MUTED};margin:0 0 14px 0;">${escapeHtml(text)}</div>`;

/** A stamped ink button, with the bare URL underneath for the clients that eat buttons. */
function button(label: string, url: string): string {
  const safe = escapeHtml(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px 0;">
  <tr>
    <td style="background:${INK};border:1px solid ${INK};">
      <a href="${safe}" style="display:inline-block;padding:13px 22px;font-family:${MONO};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${PARCHMENT};text-decoration:none;">${escapeHtml(label)} &rarr;</a>
    </td>
  </tr>
</table>
<p style="margin:0 0 16px 0;font-family:${MONO};font-size:11px;line-height:1.5;word-break:break-all;color:${INK_MUTED};">${safe}</p>`;
}

/** A hairline definition list — the ledger's way of stating facts. */
function facts(rows: [string, string][]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;border-top:1px solid ${RULE};">
${rows
  .map(
    ([k, v]) => `  <tr>
    <td style="padding:8px 0;border-bottom:1px solid ${RULE};font-family:${MONO};font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${INK_MUTED};">${escapeHtml(k)}</td>
    <td style="padding:8px 0;border-bottom:1px solid ${RULE};font-family:${SERIF};font-size:15px;color:${INK};text-align:right;">${escapeHtml(v)}</td>
  </tr>`
  )
  .join("\n")}
</table>`;
}

const ROLE_SAYS: Record<string, string> = {
  owner: "Owner — everything, including billing and the roll itself.",
  admin: "Admin — the whole organization, its members, tokens and integrations.",
  manager: "Manager — the backlog, the plan and every member's hours.",
  member: "Member — your own ledger, and the work assigned to you.",
};

/* ── Invitation ──────────────────────────────────────────────────────── */

export interface InvitationLetter {
  orgName: string;
  role: string;
  email: string;
  inviterName?: string | null;
  acceptUrl: string;
  expiresAt: Date | string;
}

export function invitationLetter(input: InvitationLetter): Letter {
  const expires = new Date(input.expiresAt);
  const expiresText = Number.isNaN(expires.getTime())
    ? "in seven days"
    : `on ${expires.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`;
  const from = input.inviterName?.trim();
  const subject = `You're invited to ${input.orgName} as ${input.role}`;

  const body = [
    eyebrow("An invitation"),
    h1(subject),
    p(
      `${from ? `${escapeHtml(from)} has invited you` : "You have been invited"} to join <strong>${escapeHtml(input.orgName)}</strong> on PTD — where the plan and the hours live in the same ledger, whether a person or an agent did the work.`
    ),
    facts([
      ["organization", input.orgName],
      ["your role", input.role],
      ["invited address", input.email],
      ["expires", expiresText.replace(/^on /, "")],
    ]),
    button("Accept the invitation", input.acceptUrl),
    muted(
      `Sign in with <strong>${escapeHtml(input.email)}</strong>, or create an account with that address — the invitation is bound to it, and the link stops working ${escapeHtml(expiresText)}.`
    ),
    muted(escapeHtml(ROLE_SAYS[input.role] ?? "")),
  ].join("\n");

  const text = [
    subject.toUpperCase(),
    "",
    `${from ? `${from} has invited you` : "You have been invited"} to join ${input.orgName} on PTD.`,
    "",
    `Organization: ${input.orgName}`,
    `Your role:    ${input.role}`,
    `Address:      ${input.email}`,
    `Expires:      ${expiresText.replace(/^on /, "")}`,
    "",
    "Accept the invitation:",
    input.acceptUrl,
    "",
    `Sign in with ${input.email}, or create an account with that address — the invitation is bound to it.`,
    ROLE_SAYS[input.role] ?? "",
  ]
    .join("\n")
    .trim();

  return { subject, html: layout({ title: subject, preheader: `${input.orgName} — ${input.role}`, body }), text };
}

/* ── Password reset ──────────────────────────────────────────────────── */

export interface ResetLetter {
  displayName?: string | null;
  email: string;
  resetUrl: string;
  expiresMinutes: number;
}

export function passwordResetLetter(input: ResetLetter): Letter {
  const subject = "Reset your PTD password";
  const name = input.displayName?.trim();
  const body = [
    eyebrow("A single-use link"),
    h1(subject),
    p(`${name ? `${escapeHtml(name)}, s` : "S"}omeone asked for a new password for <strong>${escapeHtml(input.email)}</strong>. If that was you, set one now.`),
    button("Choose a new password", input.resetUrl),
    facts([
      ["account", input.email],
      ["valid for", `${input.expiresMinutes} minutes`],
      ["uses", "one"],
    ]),
    muted(
      "If it was not you, nothing has changed and you can ignore this letter — the link expires by itself, and your current password still works. Setting a new password invalidates every other outstanding reset link for this account."
    ),
  ].join("\n");

  const text = [
    subject.toUpperCase(),
    "",
    `${name ? `${name}, s` : "S"}omeone asked for a new password for ${input.email}.`,
    "",
    "Choose a new password:",
    input.resetUrl,
    "",
    `The link is valid for ${input.expiresMinutes} minutes and can be used once.`,
    "If it was not you, ignore this letter — nothing has changed.",
  ].join("\n");

  return { subject, html: layout({ title: subject, preheader: `Valid for ${input.expiresMinutes} minutes, one use`, body }), text };
}

/* ── Weekly digest ───────────────────────────────────────────────────── */

export interface DigestLetter {
  orgName: string;
  /** Window label, e.g. "14–20 Sep 2026". */
  window: string;
  narrative: string;
  figures: [string, string][];
  streams: { name: string; agentCost: string; burn: string; over: boolean }[];
  dashboardUrl: string;
}

export function digestLetter(input: DigestLetter): Letter {
  const subject = `${input.orgName} — human and agent, ${input.window}`;
  const rows = input.streams
    .map(
      (s) => `  <tr>
    <td style="padding:8px 0;border-bottom:1px solid ${RULE};font-family:${SERIF};font-size:15px;color:${INK};">${escapeHtml(s.name)}</td>
    <td style="padding:8px 0;border-bottom:1px solid ${RULE};font-family:${MONO};font-size:12px;text-align:right;color:${s.over ? VERMILION : INK};">${escapeHtml(s.agentCost)}</td>
    <td style="padding:8px 0;border-bottom:1px solid ${RULE};font-family:${MONO};font-size:11px;text-align:right;color:${s.over ? VERMILION : INK_MUTED};">${escapeHtml(s.burn)}</td>
  </tr>`
    )
    .join("\n");

  const body = [
    eyebrow(`The week in figures · ${input.window}`),
    h1(`${input.orgName}: what the machines did`),
    p(escapeHtml(input.narrative)),
    facts(input.figures),
    input.streams.length > 0
      ? `<div style="font-family:${MONO};font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${INK_MUTED};margin:0 0 6px 0;">Agent spend by stream</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;border-top:1px solid ${RULE};">
${rows}
</table>`
      : "",
    button("Open the hybrid dashboard", input.dashboardUrl),
  ]
    .filter(Boolean)
    .join("\n");

  const text = [
    subject.toUpperCase(),
    "",
    input.narrative,
    "",
    ...input.figures.map(([k, v]) => `${k}: ${v}`),
    "",
    ...(input.streams.length > 0
      ? ["Agent spend by stream:", ...input.streams.map((s) => `  ${s.name} — ${s.agentCost} (${s.burn})${s.over ? " OVER BUDGET" : ""}`), ""]
      : []),
    input.dashboardUrl,
  ].join("\n");

  return { subject, html: layout({ title: subject, preheader: input.narrative.slice(0, 120), body }), text };
}
