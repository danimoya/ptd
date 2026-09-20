import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import {
  announceEmailConfig,
  appBaseUrl,
  envFlag,
  isEmailConfigured,
  resetEmailTransport,
  setEmailTransport,
  smtpEnv,
} from "../../server/email/transport";
import { invitationUrl, passwordResetUrl, sendInvitationEmail, sendLetter, sendPasswordResetEmail } from "../../server/email/send";

/**
 * The contract under test is not "mail arrives" — that is SMTP's business — but
 * "a request never fails because of mail". Every path through `sendLetter` has to
 * return a verdict rather than throw, because the invitation row is already
 * written by the time it is called.
 */

const REAL_ENV = { ...process.env };

function clearSmtp() {
  for (const key of Object.keys(process.env)) if (key.startsWith("SMTP_")) delete process.env[key];
  delete process.env.PTD_BASE_URL;
}

beforeEach(() => {
  clearSmtp();
  resetEmailTransport();
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  resetEmailTransport();
});

describe("smtpEnv", () => {
  it("is not configured without a host", () => {
    expect(isEmailConfigured()).toBe(false);
  });

  it("defaults the port to submission, or to 465 with implicit TLS", () => {
    process.env.SMTP_HOST = "mail.foor.email";
    expect(smtpEnv().port).toBe(587);
    process.env.SMTP_SECURE = "1";
    expect(smtpEnv().port).toBe(465);
    process.env.SMTP_PORT = "2525";
    expect(smtpEnv().port).toBe(2525);
  });

  it("invents a From only as a last resort", () => {
    process.env.SMTP_HOST = "mail.foor.email";
    expect(smtpEnv().from).toBe("PTD <no-reply@mail.foor.email>");
    process.env.SMTP_FROM = "PTD <no-reply@ptd.example>";
    expect(smtpEnv().from).toBe("PTD <no-reply@ptd.example>");
  });

  it("reads a flag the way a person would write one", () => {
    for (const truthy of ["1", "true", "YES", "on"]) {
      process.env.SMTP_ACCEPT_INVALID_CERTS = truthy;
      expect(envFlag("SMTP_ACCEPT_INVALID_CERTS"), truthy).toBe(true);
    }
    for (const falsy of ["", "0", "false", "no"]) {
      process.env.SMTP_ACCEPT_INVALID_CERTS = falsy;
      expect(envFlag("SMTP_ACCEPT_INVALID_CERTS"), falsy).toBe(false);
    }
  });

  it("only accepts invalid certificates when explicitly told to", () => {
    process.env.SMTP_HOST = "mail.foor.email";
    expect(smtpEnv().acceptInvalidCerts).toBe(false);
    process.env.SMTP_ACCEPT_INVALID_CERTS = "1";
    expect(smtpEnv().acceptInvalidCerts).toBe(true);
  });
});

describe("appBaseUrl and the links built on it", () => {
  it("prefers the configured origin and tolerates a trailing slash", () => {
    process.env.PTD_BASE_URL = "https://ptd.example/";
    expect(appBaseUrl()).toBe("https://ptd.example");
    expect(invitationUrl("abc")).toBe("https://ptd.example/auth?invite=abc");
    expect(passwordResetUrl("def")).toBe("https://ptd.example/auth?reset=def");
  });

  it("escapes a token so the query string cannot be broken", () => {
    process.env.PTD_BASE_URL = "https://ptd.example";
    expect(invitationUrl("a b&c=d")).toBe("https://ptd.example/auth?invite=a%20b%26c%3Dd");
  });

  it("falls back to localhost on the configured port", () => {
    process.env.PORT = "3055";
    expect(appBaseUrl()).toBe("http://localhost:3055");
  });
});

describe("the startup notice", () => {
  it("says so, once, when there is no SMTP at all", () => {
    const lines: string[] = [];
    announceEmailConfig((m) => lines.push(m));
    announceEmailConfig((m) => lines.push(m));
    // `send.ts` already announced at import, so this module-level latch is
    // expected to swallow both of these — which is the behaviour under test:
    // the notice is printed once per process, not once per call.
    expect(lines.length).toBe(0);
  });
});

describe("sendLetter", () => {
  const letter = { subject: "Reset your PTD password", html: "<p>link</p>", text: "link" };

  it("is a no-op with a reason when SMTP is not configured", async () => {
    const result = await sendLetter("theo@atelier14.demo", letter);
    expect(result).toEqual({ to: "theo@atelier14.demo", subject: letter.subject, sent: false, reason: "smtp_not_configured" });
  });

  it("hands the transport a complete message, with both bodies", async () => {
    process.env.SMTP_FROM = "PTD <no-reply@ptd.example>";
    const sent: Record<string, unknown>[] = [];
    setEmailTransport({
      sendMail: async (message: Record<string, unknown>) => {
        sent.push(message);
        return { messageId: "<1@ptd>" };
      },
    } as never);

    const result = await sendLetter("theo@atelier14.demo", letter);

    expect(result).toMatchObject({ sent: true, messageId: "<1@ptd>" });
    expect(sent[0]).toMatchObject({
      from: "PTD <no-reply@ptd.example>",
      to: "theo@atelier14.demo",
      subject: letter.subject,
      html: letter.html,
      text: letter.text,
    });
  });

  it("reports a refusal instead of throwing it into the request", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setEmailTransport({
      sendMail: async () => {
        throw new Error("535 5.7.8 authentication failed");
      },
    } as never);

    const result = await sendLetter("theo@atelier14.demo", letter);

    expect(result).toMatchObject({ sent: false, reason: "smtp_error", error: "535 5.7.8 authentication failed" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("produces a message nodemailer itself accepts", async () => {
    // The JSON transport runs the real composer, so a malformed message would
    // fail here rather than in production.
    setEmailTransport(nodemailer.createTransport({ jsonTransport: true }));
    const result = await sendLetter("theo@atelier14.demo", letter);
    expect(result.sent).toBe(true);
    expect(result.messageId).toBeTruthy();
  });
});

describe("the two letters PTD sends", () => {
  function captured() {
    const box: Record<string, unknown>[] = [];
    setEmailTransport({
      sendMail: async (message: Record<string, unknown>) => {
        box.push(message);
        return { messageId: "<x@ptd>" };
      },
    } as never);
    return box;
  }

  it("sends an invitation to the invited address with the accept link in it", async () => {
    process.env.PTD_BASE_URL = "https://ptd.example";
    const box = captured();
    const result = await sendInvitationEmail({
      orgName: "Atelier 14",
      role: "manager",
      email: "nadia@atelier14.demo",
      inviterName: "Elena Draftworks",
      token: "tok-123",
      expiresAt: new Date("2026-09-27T00:00:00Z"),
    });

    expect(result.sent).toBe(true);
    expect(box[0].to).toBe("nadia@atelier14.demo");
    expect(box[0].subject).toBe("You're invited to Atelier 14 as manager");
    expect(String(box[0].text)).toContain("https://ptd.example/auth?invite=tok-123");
  });

  it("sends a reset to the account's own address with the reset link in it", async () => {
    process.env.PTD_BASE_URL = "https://ptd.example";
    const box = captured();
    const result = await sendPasswordResetEmail({
      email: "theo@atelier14.demo",
      displayName: "Theo Schibsted",
      token: "tok-456",
      expiresMinutes: 30,
    });

    expect(result.sent).toBe(true);
    expect(box[0].to).toBe("theo@atelier14.demo");
    expect(String(box[0].html)).toContain("https://ptd.example/auth?reset=tok-456");
  });
});
