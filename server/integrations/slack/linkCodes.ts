import { randomInt } from "crypto";

/**
 * One-time codes that bind a Slack user to a PTD user.
 *
 * `slack.link_code` mints one in PTD; the person types `/ptd link <code>` in Slack
 * and the two identities are joined in `chat_identities`. The codes are held in
 * memory on purpose: they live ten minutes, a restart simply means asking for a new
 * one, and nothing about them is worth a schema change (the schema is frozen
 * anyway). Single-process deployments only — a multi-replica deployment would need
 * these in the database.
 */

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const LINK_CODE_LENGTH = 6;
/** No I, O, 0 or 1: these codes get read aloud and retyped. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Failed `/ptd link` attempts allowed per Slack user before we stop guessing. */
export const MAX_LINK_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

export interface LinkCodeEntry {
  userId: number;
  orgId: number;
  displayName: string;
  expiresAt: number;
}

const codes = new Map<string, LinkCodeEntry>();
const failures = new Map<string, number[]>();

function randomCode(): string {
  let out = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function pruneLinkCodes(now = Date.now()): void {
  for (const [code, entry] of codes) if (entry.expiresAt <= now) codes.delete(code);
}

export interface MintedLinkCode {
  code: string;
  expiresAt: Date;
  ttlMinutes: number;
}

/** A fresh code for one PTD user in one org. Any previous code of theirs is dropped. */
export function mintLinkCode(input: { userId: number; orgId: number; displayName: string }, now = Date.now()): MintedLinkCode {
  pruneLinkCodes(now);
  for (const [code, entry] of codes) {
    if (entry.userId === input.userId && entry.orgId === input.orgId) codes.delete(code);
  }
  let code = randomCode();
  while (codes.has(code)) code = randomCode();
  const expiresAt = now + LINK_CODE_TTL_MS;
  codes.set(code, { userId: input.userId, orgId: input.orgId, displayName: input.displayName, expiresAt });
  return { code, expiresAt: new Date(expiresAt), ttlMinutes: Math.round(LINK_CODE_TTL_MS / 60_000) };
}

export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Look a code up without spending it (used by the "already linked" path and tests). */
export function peekLinkCode(raw: string, now = Date.now()): LinkCodeEntry | null {
  pruneLinkCodes(now);
  return codes.get(normaliseCode(raw)) ?? null;
}

/** Spend a code. Returns null when it is unknown or expired; a code works exactly once. */
export function consumeLinkCode(raw: string, now = Date.now()): LinkCodeEntry | null {
  pruneLinkCodes(now);
  const code = normaliseCode(raw);
  const entry = codes.get(code);
  if (!entry) return null;
  codes.delete(code);
  return entry.expiresAt > now ? entry : null;
}

/** Records a failed attempt and reports whether the Slack user has run out of tries. */
export function recordLinkFailure(key: string, now = Date.now()): { failures: number; blocked: boolean } {
  const recent = (failures.get(key) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  recent.push(now);
  failures.set(key, recent);
  return { failures: recent.length, blocked: recent.length > MAX_LINK_FAILURES };
}

export function linkAttemptsBlocked(key: string, now = Date.now()): boolean {
  const recent = (failures.get(key) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  failures.set(key, recent);
  return recent.length > MAX_LINK_FAILURES;
}

export function clearLinkFailures(key: string): void {
  failures.delete(key);
}

/** Test-only reset of both maps. */
export function resetLinkState(): void {
  codes.clear();
  failures.clear();
}
