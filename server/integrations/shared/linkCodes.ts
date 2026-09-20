import { randomInt } from "crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { linkCodes as linkCodesTable, users } from "../../../db/schema";

/**
 * One-time codes that bind a chat account to a PTD user.
 *
 * `slack.link_code` / `telegram.link_code` / `teams.link_code` mint one in PTD; the
 * person types `/ptd link <code>` (Slack), `/link <code>` (Telegram) or
 * `@PTD link <code>` (Teams) and the two identities are joined in `chat_identities`.
 *
 * The codes live in the `link_codes` table: ten minutes, one use, one row. That
 * makes them survive a restart and, more to the point, makes them work when the
 * deployment runs more than one app replica — the code minted by the replica that
 * served the web request is spent by whichever replica happens to receive the chat
 * webhook. Spending is a single guarded `UPDATE … WHERE used_at IS NULL RETURNING`,
 * so two replicas racing on the same code cannot both win.
 *
 * Everything here is scoped by provider, so a Telegram code cannot be spent in Slack
 * and minting a Telegram code does not invalidate the same person's Slack code.
 *
 * The one thing still held in memory is the *failed-attempt* counter: it is a rate
 * limit, not a fact, and per-replica throttling only means a determined guesser gets
 * MAX_LINK_FAILURES tries per replica instead of per deployment — against a 32^6
 * keyspace that changes nothing. See docs/self-hosting.md, "Running more than one
 * app replica".
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

/** What a mint writes. `displayName` is not stored — the reads join `users` for it. */
export interface LinkCodeRow {
  code: string;
  userId: number;
  orgId: number;
  displayName: string;
  expiresAt: number;
}

/**
 * The persistence the flow needs, so the unit tests can run the same logic against
 * memory and production can run it against the table.
 */
export interface LinkCodeStore {
  /** Delete spent and expired rows for one provider. */
  prune(provider: string, now: number): Promise<void>;
  /** Drop this user's unspent codes — a fresh mint invalidates the previous one. */
  dropFor(provider: string, userId: number, orgId: number): Promise<void>;
  insert(provider: string, row: LinkCodeRow): Promise<void>;
  /** Is this code taken (spent or not)? Only used to avoid minting a duplicate. */
  taken(provider: string, code: string): Promise<boolean>;
  /** The live row, without spending it. Null when unknown, spent or expired. */
  peek(provider: string, code: string, now: number): Promise<LinkCodeEntry | null>;
  /**
   * Spend the code, atomically. Returns the entry only when this caller won the
   * race and the code was still valid; the attempt is counted either way.
   */
  claim(provider: string, code: string, now: number): Promise<LinkCodeEntry | null>;
}

/* ── the durable store ───────────────────────────────────────────────────── */

/** Imported lazily so a unit test on the memory store never needs DATABASE_URL. */
async function database() {
  return (await import("../../../db")).db;
}

const dbStore: LinkCodeStore = {
  async prune(provider, now) {
    const db = await database();
    await db
      .delete(linkCodesTable)
      .where(
        and(
          eq(linkCodesTable.provider, provider),
          or(lt(linkCodesTable.expiresAt, new Date(now)), sql`${linkCodesTable.usedAt} IS NOT NULL`),
        ),
      );
  },

  async dropFor(provider, userId, orgId) {
    const db = await database();
    await db
      .delete(linkCodesTable)
      .where(
        and(
          eq(linkCodesTable.provider, provider),
          eq(linkCodesTable.userId, userId),
          eq(linkCodesTable.orgId, orgId),
          isNull(linkCodesTable.usedAt),
        ),
      );
  },

  async insert(provider, row) {
    const db = await database();
    await db.insert(linkCodesTable).values({
      code: row.code,
      provider,
      userId: row.userId,
      orgId: row.orgId,
      expiresAt: new Date(row.expiresAt),
    });
  },

  async taken(provider, code) {
    const db = await database();
    const rows = await db
      .select({ id: linkCodesTable.id })
      .from(linkCodesTable)
      .where(and(eq(linkCodesTable.provider, provider), eq(linkCodesTable.code, code)))
      .limit(1);
    return rows.length > 0;
  },

  async peek(provider, code, now) {
    const db = await database();
    const [row] = await db
      .select({
        userId: linkCodesTable.userId,
        orgId: linkCodesTable.orgId,
        expiresAt: linkCodesTable.expiresAt,
        displayName: users.displayName,
      })
      .from(linkCodesTable)
      .leftJoin(users, eq(users.id, linkCodesTable.userId))
      .where(
        and(
          eq(linkCodesTable.provider, provider),
          eq(linkCodesTable.code, code),
          isNull(linkCodesTable.usedAt),
          gt(linkCodesTable.expiresAt, new Date(now)),
        ),
      )
      .limit(1);
    return row ? entryOf(row) : null;
  },

  async claim(provider, code, now) {
    const db = await database();
    // Count the attempt on the row itself first, so `attempts` reflects every try —
    // including the ones that arrive after the code was already spent.
    await db
      .update(linkCodesTable)
      .set({ attempts: sql`${linkCodesTable.attempts} + 1` })
      .where(and(eq(linkCodesTable.provider, provider), eq(linkCodesTable.code, code)));

    // One guarded UPDATE is the whole single-use guarantee: whoever flips used_at
    // from NULL gets the row back, everyone else gets nothing.
    const [claimed] = await db
      .update(linkCodesTable)
      .set({ usedAt: new Date(now) })
      .where(
        and(eq(linkCodesTable.provider, provider), eq(linkCodesTable.code, code), isNull(linkCodesTable.usedAt)),
      )
      .returning({
        userId: linkCodesTable.userId,
        orgId: linkCodesTable.orgId,
        expiresAt: linkCodesTable.expiresAt,
      });
    if (!claimed) return null;
    if (claimed.expiresAt.getTime() <= now) return null;

    const [user] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, claimed.userId))
      .limit(1);
    return entryOf({ ...claimed, displayName: user?.displayName ?? null });
  },
};

function entryOf(row: { userId: number; orgId: number | null; expiresAt: Date; displayName: string | null }): LinkCodeEntry {
  return {
    userId: row.userId,
    // org_id is nullable in the schema (ON DELETE SET NULL); a code whose org is
    // gone is unusable, and 0 never matches a real membership.
    orgId: row.orgId ?? 0,
    displayName: row.displayName ?? `user ${row.userId}`,
    expiresAt: row.expiresAt.getTime(),
  };
}

/* ── the memory store (unit tests) ───────────────────────────────────────── */

export interface MemoryLinkCodeStore extends LinkCodeStore {
  /** Attempts recorded against a code — the `attempts` column, for the tests. */
  attemptsOf(provider: string, code: string): number;
}

/**
 * The same semantics without a database. `resetLinkState()` installs one of these,
 * which is why the adapter tests need neither a container nor a migration.
 */
export function memoryLinkCodeStore(): MemoryLinkCodeStore {
  const rows = new Map<string, (LinkCodeRow & { usedAt: number | null; attempts: number })[]>();
  const bucket = (provider: string) => {
    const existing = rows.get(provider);
    if (existing) return existing;
    const fresh: (LinkCodeRow & { usedAt: number | null; attempts: number })[] = [];
    rows.set(provider, fresh);
    return fresh;
  };
  const live = (provider: string, code: string, now: number) =>
    bucket(provider).find((r) => r.code === code && r.usedAt === null && r.expiresAt > now);

  return {
    async prune(provider, now) {
      rows.set(
        provider,
        bucket(provider).filter((r) => r.usedAt === null && r.expiresAt > now),
      );
    },
    async dropFor(provider, userId, orgId) {
      rows.set(
        provider,
        bucket(provider).filter((r) => !(r.userId === userId && r.orgId === orgId && r.usedAt === null)),
      );
    },
    async insert(provider, row) {
      bucket(provider).push({ ...row, usedAt: null, attempts: 0 });
    },
    async taken(provider, code) {
      return bucket(provider).some((r) => r.code === code);
    },
    async peek(provider, code, now) {
      const row = live(provider, code, now);
      return row ? { userId: row.userId, orgId: row.orgId, displayName: row.displayName, expiresAt: row.expiresAt } : null;
    },
    async claim(provider, code, now) {
      for (const row of bucket(provider)) if (row.code === code) row.attempts += 1;
      const row = bucket(provider).find((r) => r.code === code && r.usedAt === null);
      if (!row) return null;
      row.usedAt = now;
      if (row.expiresAt <= now) return null;
      return { userId: row.userId, orgId: row.orgId, displayName: row.displayName, expiresAt: row.expiresAt };
    },
    attemptsOf(provider, code) {
      return bucket(provider).find((r) => r.code === code)?.attempts ?? 0;
    },
  };
}

let store: LinkCodeStore = dbStore;

/** Swap the persistence. `null` puts the `link_codes` table back. */
export function setLinkCodeStore(next: LinkCodeStore | null): void {
  store = next ?? dbStore;
}

/* ── the flow ────────────────────────────────────────────────────────────── */

/** `<provider>:<account key>` → recent failure timestamps. Per replica, on purpose. */
const failures = new Map<string, number[]>();

function randomCode(): string {
  let out = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function pruneLinkCodes(provider: string, now = Date.now()): Promise<void> {
  return store.prune(provider, now);
}

export interface MintedLinkCode {
  code: string;
  expiresAt: Date;
  ttlMinutes: number;
}

/** A fresh code for one PTD user in one org. Any previous code of theirs is dropped. */
export async function mintLinkCode(
  provider: string,
  input: { userId: number; orgId: number; displayName: string },
  now = Date.now(),
): Promise<MintedLinkCode> {
  await store.prune(provider, now);
  await store.dropFor(provider, input.userId, input.orgId);

  // (provider, code) is indexed but not unique, so a duplicate is checked for
  // rather than enforced. Five tries against a 32^6 keyspace is generous.
  let code = randomCode();
  for (let i = 0; i < 5 && (await store.taken(provider, code)); i++) code = randomCode();

  const expiresAt = now + LINK_CODE_TTL_MS;
  await store.insert(provider, { code, userId: input.userId, orgId: input.orgId, displayName: input.displayName, expiresAt });
  return { code, expiresAt: new Date(expiresAt), ttlMinutes: Math.round(LINK_CODE_TTL_MS / 60_000) };
}

export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Look a code up without spending it (used by the "already linked" path and tests). */
export function peekLinkCode(provider: string, raw: string, now = Date.now()): Promise<LinkCodeEntry | null> {
  const code = normaliseCode(raw);
  if (!code) return Promise.resolve(null);
  return store.peek(provider, code, now);
}

/** Spend a code. Returns null when it is unknown, already spent or expired. */
export function consumeLinkCode(provider: string, raw: string, now = Date.now()): Promise<LinkCodeEntry | null> {
  const code = normaliseCode(raw);
  if (!code) return Promise.resolve(null);
  return store.claim(provider, code, now);
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

/**
 * Test-only reset: installs a fresh in-memory store and forgets every failure
 * counter. Production code never calls it — the table is the store there.
 */
export function resetLinkState(provider?: string): void {
  setLinkCodeStore(memoryLinkCodeStore());
  if (!provider) {
    failures.clear();
    return;
  }
  for (const key of failures.keys()) if (key.startsWith(`${provider}:`)) failures.delete(key);
}
