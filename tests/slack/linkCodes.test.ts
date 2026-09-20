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

/**
 * The codes live in `link_codes` now, so every function that touches one is async.
 * `resetLinkState()` installs the in-memory store, which satisfies the same contract
 * as the table (tests/scale/durable.test.ts checks that claim-once behaviour against
 * the store interface directly).
 */

const user = { userId: 7, orgId: 3, displayName: "Dani" };

beforeEach(() => resetLinkState());

describe("mintLinkCode", () => {
  it("mints a six-character code from an unambiguous alphabet", async () => {
    const { code, ttlMinutes } = await mintLinkCode(user);
    expect(code).toHaveLength(LINK_CODE_LENGTH);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(code).not.toMatch(/[IO01]/);
    expect(ttlMinutes).toBe(10);
  });

  it("carries the expiry and the identity it is for", async () => {
    const now = 1_700_000_000_000;
    const { code, expiresAt } = await mintLinkCode(user, now);
    expect(expiresAt.getTime()).toBe(now + LINK_CODE_TTL_MS);
    await expect(peekLinkCode(code, now)).resolves.toMatchObject({ userId: 7, orgId: 3, displayName: "Dani" });
  });

  it("replaces the caller's previous code, so only the newest one works", async () => {
    const first = (await mintLinkCode(user)).code;
    const second = (await mintLinkCode(user)).code;
    expect(first).not.toBe(second);
    await expect(peekLinkCode(first)).resolves.toBeNull();
    await expect(peekLinkCode(second)).resolves.not.toBeNull();
  });

  it("keeps other people's codes", async () => {
    const mine = (await mintLinkCode(user)).code;
    const theirs = (await mintLinkCode({ userId: 8, orgId: 3, displayName: "Sam" })).code;
    await expect(peekLinkCode(mine)).resolves.not.toBeNull();
    await expect(peekLinkCode(theirs)).resolves.not.toBeNull();
  });
});

describe("consumeLinkCode", () => {
  it("works exactly once", async () => {
    const { code } = await mintLinkCode(user);
    await expect(consumeLinkCode(code)).resolves.toMatchObject({ userId: 7 });
    await expect(consumeLinkCode(code)).resolves.toBeNull();
  });

  it("is case- and punctuation-insensitive about what the user typed", async () => {
    const { code } = await mintLinkCode(user);
    expect(normaliseCode(` ${code.toLowerCase()}-`)).toBe(code);
    await expect(consumeLinkCode(` ${code.toLowerCase()} `)).resolves.toMatchObject({ userId: 7 });
  });

  it("expires after ten minutes", async () => {
    const now = 1_700_000_000_000;
    const { code } = await mintLinkCode(user, now);
    await expect(peekLinkCode(code, now + LINK_CODE_TTL_MS - 1)).resolves.not.toBeNull();
    await expect(consumeLinkCode(code, now + LINK_CODE_TTL_MS + 1)).resolves.toBeNull();
  });

  it("returns null for a code nobody minted", async () => {
    await expect(consumeLinkCode("ZZZZZZ")).resolves.toBeNull();
    await expect(consumeLinkCode("")).resolves.toBeNull();
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
