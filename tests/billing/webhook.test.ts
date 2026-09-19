import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { fakeDb } from "./fake-db";
import { eventFixture, signPayload, subscriptionFixture } from "./stub";

// The module under test pulls in the billing service, which imports the drizzle
// client; signature checking itself never touches the database.
vi.mock("../../db", () => ({ db: fakeDb }));

const {
  SIGNATURE_TOLERANCE_SECONDS, computeSignature, constructEvent, parseSignatureHeader, verifySignature,
} = await import("../../server/billing/webhook");

const SECRET = "whsec_test_secret";
const PAYLOAD = JSON.stringify(eventFixture("customer.subscription.updated", subscriptionFixture(), "evt_sig_1"));
const NOW_MS = Date.UTC(2026, 8, 19, 10, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);

describe("parseSignatureHeader", () => {
  it("reads t and every v1 (a secret rotation sends two)", () => {
    expect(parseSignatureHeader("t=1758276000,v1=aa,v1=bb")).toEqual({ timestamp: 1758276000, signatures: ["aa", "bb"] });
  });

  it("ignores the v0 test-mode scheme and unknown keys", () => {
    expect(parseSignatureHeader("t=1,v0=zz,v1=aa,foo=bar")).toEqual({ timestamp: 1, signatures: ["aa"] });
  });

  it("rejects a header with no timestamp or no v1", () => {
    expect(parseSignatureHeader("v1=aa")).toBeNull();
    expect(parseSignatureHeader("t=1")).toBeNull();
    expect(parseSignatureHeader("garbage")).toBeNull();
  });
});

describe("computeSignature", () => {
  it("is HMAC-SHA256 over `${t}.${rawBody}`, not over the body alone", () => {
    const expected = createHmac("sha256", SECRET).update(`${NOW_S}.${PAYLOAD}`, "utf8").digest("hex");
    expect(computeSignature(NOW_S, PAYLOAD, SECRET)).toBe(expected);
    expect(computeSignature(NOW_S, PAYLOAD, SECRET)).not.toBe(createHmac("sha256", SECRET).update(PAYLOAD).digest("hex"));
  });

  it("signs exact bytes — a re-serialised body does not match", () => {
    const reserialised = JSON.stringify(JSON.parse(PAYLOAD).data.object);
    expect(computeSignature(NOW_S, reserialised, SECRET)).not.toBe(computeSignature(NOW_S, PAYLOAD, SECRET));
  });

  it("accepts a Buffer and a string identically", () => {
    expect(computeSignature(NOW_S, Buffer.from(PAYLOAD, "utf8"), SECRET)).toBe(computeSignature(NOW_S, PAYLOAD, SECRET));
  });
});

describe("verifySignature", () => {
  it("passes for a freshly signed payload", () => {
    const header = signPayload(PAYLOAD, SECRET, NOW_S);
    expect(verifySignature(PAYLOAD, header, SECRET, { nowMs: NOW_MS })).toEqual({ ok: true, timestamp: NOW_S });
  });

  it("passes when one of several v1 signatures matches (rotating the endpoint secret)", () => {
    const good = createHmac("sha256", SECRET).update(`${NOW_S}.${PAYLOAD}`, "utf8").digest("hex");
    const header = `t=${NOW_S},v1=${"0".repeat(64)},v1=${good}`;
    expect(verifySignature(PAYLOAD, header, SECRET, { nowMs: NOW_MS }).ok).toBe(true);
  });

  it("rejects a stale timestamp outside the 5-minute tolerance", () => {
    const stale = signPayload(PAYLOAD, SECRET, NOW_S - (SIGNATURE_TOLERANCE_SECONDS + 1));
    const res = verifySignature(PAYLOAD, stale, SECRET, { nowMs: NOW_MS });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/tolerance/);
  });

  it("rejects a timestamp too far in the future as well", () => {
    const ahead = signPayload(PAYLOAD, SECRET, NOW_S + SIGNATURE_TOLERANCE_SECONDS + 1);
    expect(verifySignature(PAYLOAD, ahead, SECRET, { nowMs: NOW_MS }).ok).toBe(false);
  });

  it("accepts a signature at the edge of the window", () => {
    const edge = signPayload(PAYLOAD, SECRET, NOW_S - SIGNATURE_TOLERANCE_SECONDS);
    expect(verifySignature(PAYLOAD, edge, SECRET, { nowMs: NOW_MS }).ok).toBe(true);
  });

  it("rejects the right signature for a tampered body", () => {
    const header = signPayload(PAYLOAD, SECRET, NOW_S);
    const tampered = PAYLOAD.replace('"active"', '"canceled"');
    expect(verifySignature(tampered, header, SECRET, { nowMs: NOW_MS }).ok).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    const header = signPayload(PAYLOAD, "whsec_someone_else", NOW_S);
    expect(verifySignature(PAYLOAD, header, SECRET, { nowMs: NOW_MS }).ok).toBe(false);
  });

  it("rejects junk, a missing header and a missing secret without throwing", () => {
    expect(verifySignature(PAYLOAD, "t=abc,v1=zz", SECRET, { nowMs: NOW_MS }).ok).toBe(false);
    expect(verifySignature(PAYLOAD, `t=${NOW_S},v1=nothex`, SECRET, { nowMs: NOW_MS }).ok).toBe(false);
    expect(verifySignature(PAYLOAD, undefined, SECRET, { nowMs: NOW_MS })).toEqual({ ok: false, error: "Missing Stripe-Signature header" });
    expect(verifySignature(PAYLOAD, signPayload(PAYLOAD, SECRET, NOW_S), undefined, { nowMs: NOW_MS }).ok).toBe(false);
  });
});

describe("constructEvent", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  });

  it("returns the parsed event only after the signature checks out", () => {
    const res = constructEvent(PAYLOAD, signPayload(PAYLOAD, SECRET, NOW_S), SECRET, { nowMs: NOW_MS });
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.event.type).toBe("customer.subscription.updated");
    expect(res.ok === true && res.event.id).toBe("evt_sig_1");
  });

  it("does not parse a body whose signature failed", () => {
    const res = constructEvent(PAYLOAD, "t=1,v1=aa", SECRET, { nowMs: NOW_MS });
    expect(res).toEqual({ ok: false, error: `Timestamp outside the ${SIGNATURE_TOLERANCE_SECONDS}s tolerance` });
  });

  it("rejects a correctly signed body that is not JSON, and one that is not an event", () => {
    const junk = "not json";
    expect(constructEvent(junk, signPayload(junk, SECRET, NOW_S), SECRET, { nowMs: NOW_MS })).toEqual({ ok: false, error: "Body is not valid JSON" });
    const notEvent = '{"hello":"world"}';
    expect(constructEvent(notEvent, signPayload(notEvent, SECRET, NOW_S), SECRET, { nowMs: NOW_MS })).toEqual({ ok: false, error: "Body is not a Stripe event" });
  });
});
