import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEmailTransport, setEmailTransport } from "../../server/email/transport";
import {
  contactLetter,
  contactRecipient,
  contactSchema,
  handleContact,
  registerContactRoutes,
} from "../../server/contact";

/**
 * The contract under test is the one a stranger on the landing page relies on:
 * a valid enquiry is never answered with a failure. Mail that cannot be sent
 * comes back as `queued: false` plus an address to write to, and the honeypot
 * is answered as if it had worked — because telling a bot it was caught only
 * teaches the bot.
 */

interface Sent {
  to?: string;
  from?: string;
  replyTo?: string;
  subject?: string;
  text?: string;
  html?: string;
}

let sent: Sent[] = [];

function stubTransport(behaviour: "ok" | "throws" = "ok") {
  setEmailTransport({
    sendMail: async (options: Sent) => {
      if (behaviour === "throws") throw new Error("connect ECONNREFUSED 127.0.0.1:587");
      sent.push(options);
      return { messageId: "<stub@ptd.test>" };
    },
  } as never);
}

/** The handler on its own — no limiter, so the behavioural tests do not eat it. */
function bareApp() {
  const app = express();
  app.use(express.json());
  app.post("/api/contact", handleContact);
  return app;
}

const GOOD = {
  name: "Rina Oyelaran",
  email: "rina@northwind.example",
  company: "Northwind Studio",
  orgSize: "51–200",
  need: "on-prem",
  message: "Forty people and nine agents, behind our own firewall. Who do we talk to?",
};

const REAL_ENV = { ...process.env };

beforeEach(() => {
  sent = [];
  delete process.env.CONTACT_TO;
  for (const key of Object.keys(process.env)) if (key.startsWith("SMTP_")) delete process.env[key];
  resetEmailTransport();
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  resetEmailTransport();
});

describe("the recipient", () => {
  it("falls back to the house address", () => {
    expect(contactRecipient()).toBe("me@danimoya.com");
  });

  it("is overridable, and whitespace does not count as an override", () => {
    process.env.CONTACT_TO = "sales@ptd.example";
    expect(contactRecipient()).toBe("sales@ptd.example");
    process.env.CONTACT_TO = "   ";
    expect(contactRecipient()).toBe("me@danimoya.com");
  });
});

describe("what the form accepts", () => {
  it("fills in the optional fields rather than rejecting them", () => {
    const parsed = contactSchema.parse({ name: "Ada", email: "ada@example.com", message: "Hello" });
    expect(parsed.company).toBe("");
    expect(parsed.orgSize).toBe("11–50");
    expect(parsed.need).toBe("hosted");
    expect(parsed.website).toBe("");
  });

  it("refuses a body with nothing to reply to", () => {
    const bad = contactSchema.safeParse({ name: "Ada", email: "not-an-address", message: "Hello" });
    expect(bad.success).toBe(false);
  });
});

describe("the letter", () => {
  it("carries every field in both bodies", () => {
    const letter = contactLetter(contactSchema.parse(GOOD));
    for (const body of [letter.text, letter.html]) {
      expect(body).toContain("Rina Oyelaran");
      expect(body).toContain("rina@northwind.example");
      expect(body).toContain("Northwind Studio");
      expect(body).toContain("51–200");
      expect(body).toContain("On-premises deployment");
      expect(body).toContain("behind our own firewall");
    }
    expect(letter.subject).toBe("PTD enquiry — Rina Oyelaran (Northwind Studio)");
  });

  it("escapes anything that would otherwise be markup", () => {
    const letter = contactLetter(
      contactSchema.parse({ ...GOOD, name: "<script>alert(1)</script>", message: "a & b" })
    );
    expect(letter.html).not.toContain("<script>");
    expect(letter.html).toContain("&lt;script&gt;");
    expect(letter.html).toContain("a &amp; b");
  });
});

describe("POST /api/contact", () => {
  it("sends the enquiry, From us and reply-to the stranger", async () => {
    stubTransport();
    process.env.SMTP_FROM = "PTD <no-reply@ptd.example>";
    process.env.CONTACT_TO = "sales@ptd.example";

    const res = await request(bareApp()).post("/api/contact").send(GOOD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, queued: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("sales@ptd.example");
    expect(sent[0].from).toBe("PTD <no-reply@ptd.example>");
    // From must stay ours for SPF and DKIM; reply-to is what makes "reply" work.
    expect(sent[0].replyTo).toBe("Rina Oyelaran <rina@northwind.example>");
    expect(sent[0].text).toContain("behind our own firewall");
  });

  it("answers 400 with the field that is wrong, and sends nothing", async () => {
    stubTransport();
    const res = await request(bareApp()).post("/api/contact").send({ name: "", email: "nope", message: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(Object.keys(res.body.details.fieldErrors).sort()).toEqual(["email", "message", "name"]);
    expect(sent).toHaveLength(0);
  });

  it("answers a filled honeypot exactly as it answers a real one, and sends nothing", async () => {
    stubTransport();
    const res = await request(bareApp())
      .post("/api/contact")
      .send({ ...GOOD, website: "https://buy-followers.example" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, queued: true });
    expect(sent).toHaveLength(0);
  });

  it("still answers 200 when SMTP is not configured, and hands back an address", async () => {
    setEmailTransport(null);
    process.env.CONTACT_TO = "sales@ptd.example";

    const res = await request(bareApp()).post("/api/contact").send(GOOD);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.queued).toBe(false);
    expect(res.body.reason).toBe("smtp_not_configured");
    expect(res.body.contactEmail).toBe("sales@ptd.example");
  });

  it("still answers 200 when the transport refuses it", async () => {
    stubTransport("throws");

    const res = await request(bareApp()).post("/api/contact").send(GOOD);

    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(false);
    expect(res.body.reason).toBe("smtp_error");
    expect(res.body.contactEmail).toBe("me@danimoya.com");
  });
});

// Last, deliberately: the limiter is module-level state, so spending its window
// here cannot affect the tests above.
describe("the rate limit", () => {
  it("stops after five in the window", async () => {
    stubTransport();
    const app = express();
    app.use(express.json());
    registerContactRoutes(app);

    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post("/api/contact").send(GOOD);
      codes.push(res.status);
    }

    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
    expect(sent).toHaveLength(5);
  });
});
