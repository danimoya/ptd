import { describe, expect, it } from "vitest";
import { digestLetter, escapeHtml, invitationLetter, passwordResetLetter } from "../../server/email/templates";

/**
 * A letter has two bodies and both of them have to work. Every test here checks
 * the HTML *and* the text: a reset link that only exists inside an `<a href>` is
 * a broken reset for anyone reading mail as plain text, and that is exactly the
 * kind of thing nobody notices until a customer cannot get back in.
 */

const INVITE = {
  orgName: "Atelier 14",
  role: "manager",
  email: "nadia@atelier14.demo",
  inviterName: "Elena Draftworks",
  acceptUrl: "https://ptd.example/auth?invite=abc123",
  expiresAt: new Date("2026-09-27T16:18:17.581Z"),
};

describe("escapeHtml", () => {
  it("neutralises markup in a name nobody vetted", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(escapeHtml("Ben & Co's")).toBe("Ben &amp; Co&#39;s");
  });
});

describe("invitationLetter", () => {
  const letter = invitationLetter(INVITE);

  it("says what it is in the subject", () => {
    expect(letter.subject).toBe("You're invited to Atelier 14 as manager");
  });

  it("carries the accept link in both bodies", () => {
    expect(letter.html).toContain(INVITE.acceptUrl);
    expect(letter.text).toContain(INVITE.acceptUrl);
  });

  it("names the organization, the role, the address and the expiry", () => {
    for (const part of ["Atelier 14", "manager", "nadia@atelier14.demo", "27 September 2026"]) {
      expect(letter.html, part).toContain(part);
      expect(letter.text, part).toContain(part);
    }
  });

  it("credits the person who sent it", () => {
    expect(letter.text).toContain("Elena Draftworks has invited you");
    expect(invitationLetter({ ...INVITE, inviterName: null }).text).toContain("You have been invited");
  });

  it("explains what the role can do", () => {
    expect(letter.text).toContain("the backlog, the plan and every member's hours");
  });

  it("escapes an organization name that contains markup", () => {
    const nasty = invitationLetter({ ...INVITE, orgName: '<img src=x onerror="alert(1)">' });
    expect(nasty.html).not.toContain("<img src=x");
    expect(nasty.html).toContain("&lt;img src=x");
  });

  it("survives an expiry it cannot read", () => {
    const letter = invitationLetter({ ...INVITE, expiresAt: "not a date" });
    expect(letter.text).toContain("in seven days");
  });

  it("is a complete HTML document with a light-only colour scheme", () => {
    expect(letter.html.startsWith("<!doctype html>")).toBe(true);
    expect(letter.html).toContain('content="light"');
    expect(letter.html).toContain("<title>");
  });
});

describe("passwordResetLetter", () => {
  const letter = passwordResetLetter({
    displayName: "Theo Schibsted",
    email: "theo@atelier14.demo",
    resetUrl: "https://ptd.example/auth?reset=deadbeef",
    expiresMinutes: 30,
  });

  it("is titled plainly — this is the one mail people search their inbox for", () => {
    expect(letter.subject).toBe("Reset your PTD password");
  });

  it("carries the link and the terms in both bodies", () => {
    for (const body of [letter.html, letter.text]) {
      expect(body).toContain("https://ptd.example/auth?reset=deadbeef");
      expect(body).toContain("30 minutes");
      expect(body).toContain("theo@atelier14.demo");
    }
  });

  it("tells a recipient who did not ask for it that nothing has happened", () => {
    expect(letter.text).toContain("ignore this letter");
    expect(letter.html).toContain("nothing has changed");
  });

  it("does not need a display name", () => {
    const anon = passwordResetLetter({ email: "x@y.z", resetUrl: "https://ptd.example/auth?reset=1", expiresMinutes: 30 });
    expect(anon.text).toContain("Someone asked for a new password");
  });
});

describe("digestLetter", () => {
  const letter = digestLetter({
    orgName: "Atelier 14",
    window: "14 Sep – 20 Sep 2026",
    narrative: "Agents did 32.9% of the hours for $12.26.",
    figures: [
      ["hours logged", "14h 32m"],
      ["agent spend", "$12.26"],
    ],
    streams: [
      { name: "Security audit", agentCost: "$4.57", burn: "18.3% of $25.00", over: false },
      { name: "API v2", agentCost: "$6.25", burn: "156.3% of $4.00", over: true },
    ],
    dashboardUrl: "https://ptd.example/overview/hybrid",
  });

  it("puts the window in the subject and the finding in the body", () => {
    expect(letter.subject).toContain("14 Sep – 20 Sep 2026");
    expect(letter.html).toContain("Agents did 32.9% of the hours");
    expect(letter.text).toContain("Agents did 32.9% of the hours");
  });

  it("prints every figure and every stream in both bodies", () => {
    for (const body of [letter.html, letter.text]) {
      expect(body).toContain("14h 32m");
      expect(body).toContain("Security audit");
      expect(body).toContain("156.3% of $4.00");
    }
  });

  it("marks the over-budget stream so it cannot be missed in plain text either", () => {
    expect(letter.text).toContain("OVER BUDGET");
    expect(letter.html).toContain("#B8451A"); // vermilion, the one accent this page allows
  });

  it("links back to the tab it was rendered from", () => {
    expect(letter.html).toContain("https://ptd.example/overview/hybrid");
    expect(letter.text).toContain("https://ptd.example/overview/hybrid");
  });

  it("copes with an organization that has no streams worth listing", () => {
    const bare = digestLetter({
      orgName: "Atelier 14",
      window: "14 Sep – 20 Sep 2026",
      narrative: "Nothing closed.",
      figures: [],
      streams: [],
      dashboardUrl: "https://ptd.example/overview/hybrid",
    });
    expect(bare.html).not.toContain("Agent spend by stream");
    expect(bare.text).toContain("Nothing closed.");
  });
});
