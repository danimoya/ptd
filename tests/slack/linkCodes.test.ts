import { beforeEach, describe, expect, it } from "vitest";
import {
  LINK_CODE_LENGTH,
  LINK_CODE_TTL_MS,
  MAX_LINK_FAILURES,
  clearLinkFailures,
  consumeLinkCode,
  linkAttemptsBlocked,
  mintLinkCode,
  normaliseCode,
  peekLinkCode,
  recordLinkFailure,
  resetLinkState,
} from "../../server/integrations/slack/linkCodes";

const user = { userId: 7, orgId: 3, displayName: "Dani" };

beforeEach(() => resetLinkState());

describe("mintLinkCode", () => {
  it("mints a six-character code from an unambiguous alphabet", () => {
    const { code, ttlMinutes } = mintLinkCode(user);
    expect(code).toHaveLength(LINK_CODE_LENGTH);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(code).not.toMatch(/[IO01]/);
    expect(ttlMinutes).toBe(10);
  });

  it("carries the expiry and the identity it is for", () => {
    const now = 1_700_000_000_000;
    const { code, expiresAt } = mintLinkCode(user, now);
    expect(expiresAt.getTime()).toBe(now + LINK_CODE_TTL_MS);
    expect(peekLinkCode(code, now)).toMatchObject({ userId: 7, orgId: 3, displayName: "Dani" });
  });

  it("replaces the caller's previous code, so only the newest one works", () => {
    const first = mintLinkCode(user).code;
    const second = mintLinkCode(user).code;
    expect(first).not.toBe(second);
    expect(peekLinkCode(first)).toBeNull();
    expect(peekLinkCode(second)).not.toBeNull();
  });

  it("keeps other people's codes", () => {
    const mine = mintLinkCode(user).code;
    const theirs = mintLinkCode({ userId: 8, orgId: 3, displayName: "Sam" }).code;
    expect(peekLinkCode(mine)).not.toBeNull();
    expect(peekLinkCode(theirs)).not.toBeNull();
  });
});

describe("consumeLinkCode", () => {
  it("works exactly once", () => {
    const { code } = mintLinkCode(user);
    expect(consumeLinkCode(code)).toMatchObject({ userId: 7 });
    expect(consumeLinkCode(code)).toBeNull();
  });

  it("is case- and punctuation-insensitive about what the user typed", () => {
    const { code } = mintLinkCode(user);
    expect(normaliseCode(` ${code.toLowerCase()}-`)).toBe(code);
    expect(consumeLinkCode(` ${code.toLowerCase()} `)).toMatchObject({ userId: 7 });
  });

  it("expires after ten minutes", () => {
    const now = 1_700_000_000_000;
    const { code } = mintLinkCode(user, now);
    expect(peekLinkCode(code, now + LINK_CODE_TTL_MS - 1)).not.toBeNull();
    expect(consumeLinkCode(code, now + LINK_CODE_TTL_MS + 1)).toBeNull();
  });

  it("returns null for a code nobody minted", () => {
    expect(consumeLinkCode("ZZZZZZ")).toBeNull();
    expect(consumeLinkCode("")).toBeNull();
  });
});

describe("failure throttle", () => {
  it("blocks a Slack user after too many bad codes, and a success clears it", () => {
    const key = "T1:U1";
    for (let i = 0; i < MAX_LINK_FAILURES; i++) expect(recordLinkFailure(key).blocked).toBe(false);
    expect(recordLinkFailure(key).blocked).toBe(true);
    expect(linkAttemptsBlocked(key)).toBe(true);
    clearLinkFailures(key);
    expect(linkAttemptsBlocked(key)).toBe(false);
  });

  it("forgets failures older than the window", () => {
    const key = "T1:U2";
    const now = 1_700_000_000_000;
    for (let i = 0; i <= MAX_LINK_FAILURES; i++) recordLinkFailure(key, now);
    expect(linkAttemptsBlocked(key, now)).toBe(true);
    expect(linkAttemptsBlocked(key, now + 11 * 60 * 1000)).toBe(false);
  });

  it("throttles each Slack user separately", () => {
    for (let i = 0; i <= MAX_LINK_FAILURES; i++) recordLinkFailure("T1:U1");
    expect(linkAttemptsBlocked("T1:U1")).toBe(true);
    expect(linkAttemptsBlocked("T1:U9")).toBe(false);
  });
});
