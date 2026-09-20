import { randomInt } from "crypto";

/**
 * One-time codes that bind a chat account to a PTD user.
 *
 * `slack.link_code` / `telegram.link_code` / `teams.link_code` mint one in PTD; the
 * person types `/ptd link <code>` (Slack), `/link <code>` (Telegram) or
 * `@PTD link <code>` (Teams) and the two identities are joined in `chat_identities`.
 *
 * The codes are held in memory on purpose: they live ten minutes, a restart simply
 * means asking for a new one, and nothing about them is worth a schema change (the
 * schema is frozen anyway). Single-process deployments only — a multi-replica
 * deployment would need these in the database.
 *
 * Everything here is scoped by provider, so a Telegram code cannot be spent in Slack
 * and minting a Telegram code does not invalidate the same person's Slack code.
 */

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const LINK_CODE_LENGTH = 6;
/** No I, O, 0 or 1: these codes get read aloud and retyped. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Failed link attempts allowed per chat account before we stop guessing. */
export const MAX_LINK_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

export interface LinkCodeEntry {
  userId: number;
  orgId: number;
  displayName: string;
  expiresAt: number;
}

/** provider → code → entry. */
const codes = new Map<string, Map<string, LinkCodeEntry>>();
/** `<provider>:<account key>` → recent failure timestamps. */
const failures = new Map<string, number[]>();

function bucket(provider: string): Map<string, LinkCodeEntry> {
  const existing = codes.get(provider);
  if (existing) return existing;
  const fresh = new Map<string, LinkCodeEntry>();
  codes.set(provider, fresh);
  return fresh;
}

function randomCode(): string {
  let out = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function pruneLinkCodes(provider: string, now = Date.now()): void {
  const store = bucket(provider);
  for (const [code, entry] of store) if (entry.expiresAt <= now) store.delete(code);
}

export interface MintedLinkCode {
  code: string;
  expiresAt: Date;
  ttlMinutes: number;
}

/** A fresh code for one PTD user in one org. Any previous code of theirs is dropped. */
export function mintLinkCode(
  provider: string,
  input: { userId: number; orgId: number; displayName: string },
  now = Date.now(),
): MintedLinkCode {
  pruneLinkCodes(provider, now);
  const store = bucket(provider);
  for (const [code, entry] of store) {
    if (entry.userId === input.userId && entry.orgId === input.orgId) store.delete(code);
  }
  let code = randomCode();
  while (store.has(code)) code = randomCode();
  const expiresAt = now + LINK_CODE_TTL_MS;
  store.set(code, { userId: input.userId, orgId: input.orgId, displayName: input.displayName, expiresAt });
  return { code, expiresAt: new Date(expiresAt), ttlMinutes: Math.round(LINK_CODE_TTL_MS / 60_000) };
}

export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Look a code up without spending it (used by the "already linked" path and tests). */
export function peekLinkCode(provider: string, raw: string, now = Date.now()): LinkCodeEntry | null {
  pruneLinkCodes(provider, now);
  return bucket(provider).get(normaliseCode(raw)) ?? null;
}

/** Spend a code. Returns null when it is unknown or expired; a code works exactly once. */
export function consumeLinkCode(provider: string, raw: string, now = Date.now()): LinkCodeEntry | null {
  pruneLinkCodes(provider, now);
  const store = bucket(provider);
  const code = normaliseCode(raw);
  const entry = store.get(code);
  if (!entry) return null;
  store.delete(code);
  return entry.expiresAt > now ? entry : null;
}

/** Records a failed attempt and reports whether that chat account has run out of tries. */
export function recordLinkFailure(provider: string, key: string, now = Date.now()): { failures: number; blocked: boolean } {
  const id = `${provider}:${key}`;
  const recent = (failures.get(id) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  recent.push(now);
  failures.set(id, recent);
  return { failures: recent.length, blocked: recent.length > MAX_LINK_FAILURES };
}

export function linkAttemptsBlocked(provider: string, key: string, now = Date.now()): boolean {
  const id = `${provider}:${key}`;
  const recent = (failures.get(id) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  failures.set(id, recent);
  return recent.length > MAX_LINK_FAILURES;
}

export function clearLinkFailures(provider: string, key: string): void {
  failures.delete(`${provider}:${key}`);
}

/** Test-only reset. Without a provider it forgets every provider's codes and failures. */
export function resetLinkState(provider?: string): void {
  if (!provider) {
    codes.clear();
    failures.clear();
    return;
  }
  codes.delete(provider);
  for (const key of failures.keys()) if (key.startsWith(`${provider}:`)) failures.delete(key);
}
