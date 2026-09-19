import { describe, expect, it } from "vitest";
import express from "express";
import { createHmac } from "crypto";
import {
  MAX_SKEW_SECONDS,
  mountRawBodyCapture,
  slackSignature,
  verifySlackRequest,
} from "../../server/integrations/slack/verify";

const SECRET = "testsecret";
const BODY = "command=%2Fptd&text=next&team_id=T1&user_id=U1";

const sign = (timestamp: string, body = BODY, secret = SECRET) => slackSignature(secret, timestamp, body);

describe("slackSignature", () => {
  it("is v0=<hex HMAC-SHA256 of v0:timestamp:body>", () => {
    const expected = `v0=${createHmac("sha256", SECRET).update(`v0:1700000000:${BODY}`, "utf8").digest("hex")}`;
    expect(sign("1700000000")).toBe(expected);
    expect(sign("1700000000")).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  it("covers the exact bytes and the timestamp", () => {
    expect(sign("1700000000")).not.toBe(sign("1700000001"));
    expect(sign("1700000000", `${BODY}&x=1`)).not.toBe(sign("1700000000"));
    expect(sign("1700000000", BODY, "other")).not.toBe(sign("1700000000"));
  });
});

describe("verifySlackRequest", () => {
  const now = 1_700_000_000_000;
  const ts = String(now / 1000);

  it("accepts a correctly signed, fresh request", () => {
    expect(verifySlackRequest({ rawBody: BODY, timestamp: ts, signature: sign(ts), secrets: [SECRET], nowMs: now })).toEqual({ ok: true });
  });

  it("rejects a stale timestamp even when the signature is right", () => {
    const old = String(now / 1000 - MAX_SKEW_SECONDS - 1);
    expect(verifySlackRequest({ rawBody: BODY, timestamp: old, signature: sign(old), secrets: [SECRET], nowMs: now })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("rejects a timestamp from the future beyond the window (clock-skew replay)", () => {
    const ahead = String(now / 1000 + MAX_SKEW_SECONDS + 5);
    expect(verifySlackRequest({ rawBody: BODY, timestamp: ahead, signature: sign(ahead), secrets: [SECRET], nowMs: now })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("rejects a bad signature, a tampered body and a wrong secret", () => {
    expect(verifySlackRequest({ rawBody: BODY, timestamp: ts, signature: `v0=${"0".repeat(64)}`, secrets: [SECRET], nowMs: now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifySlackRequest({ rawBody: `${BODY}&injected=1`, timestamp: ts, signature: sign(ts), secrets: [SECRET], nowMs: now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifySlackRequest({ rawBody: BODY, timestamp: ts, signature: sign(ts), secrets: ["nope"], nowMs: now })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects missing or malformed headers", () => {
    expect(verifySlackRequest({ rawBody: BODY, timestamp: null, signature: sign(ts), secrets: [SECRET], nowMs: now })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifySlackRequest({ rawBody: BODY, timestamp: ts, signature: null, secrets: [SECRET], nowMs: now })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifySlackRequest({ rawBody: BODY, timestamp: "not-a-number", signature: sign(ts), secrets: [SECRET], nowMs: now })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifySlackRequest({ rawBody: BODY, timestamp: ts, signature: "sha256=deadbeef", secrets: [SECRET], nowMs: now })).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("reports no_secret when the server has none configured", () => {
    expect(verifySlackRequest({ rawBody: BODY, timestamp: ts, signature: sign(ts), secrets: [undefined, "", null], nowMs: now })).toEqual({ ok: false, reason: "no_secret" });
  });

  it("tries every candidate secret, so a per-install override works", () => {
    expect(verifySlackRequest({ rawBody: BODY, timestamp: ts, signature: sign(ts, BODY, "per-install"), secrets: [SECRET, "per-install"], nowMs: now })).toEqual({ ok: true });
  });

  it("verifies an empty body without throwing", () => {
    expect(verifySlackRequest({ rawBody: "", timestamp: ts, signature: sign(ts, ""), secrets: [SECRET], nowMs: now })).toEqual({ ok: true });
  });
});

describe("mountRawBodyCapture", () => {
  it("moves the capture layer in front of the global body parsers", () => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    expect(mountRawBodyCapture(app, "/api/integrations/slack")).toBe("before-parsers");

    const stack = (app as unknown as { _router: { stack: { handle?: { name?: string } }[] } })._router.stack;
    const names = stack.map((l) => l.handle?.name);
    expect(names.indexOf("slackRawBodyCapture")).toBeLessThan(names.indexOf("jsonParser"));
  });

  it("reports `appended` when there is nothing to get in front of", () => {
    const app = express();
    expect(mountRawBodyCapture(app, "/api/integrations/slack")).toBe("appended");
  });
});
