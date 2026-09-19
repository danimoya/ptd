/**
 * Folding of grouped SQL rows into the human/agent buckets the surfaces read.
 *
 * Kept pure and db-free so the shape that other agents' code depends on — the
 * `task.totals` contract — can be unit-tested without a database, and so the
 * same fold serves task totals, stream totals and the day summary.
 *
 * Postgres (and HeliosDB-Nano) hand back SUM() over bigint/numeric as a string
 * through postgres.js, so every number is coerced on the way in.
 */

export interface HumanBucket {
  minutes: number;
}

export interface AgentBucket {
  minutes: number;
  tokens: number;
  costUsd: number;
}

export interface BySource {
  human: HumanBucket;
  agent: AgentBucket;
}

/** One `GROUP BY <key>, entry_source` row. */
export interface GroupRow {
  key: number | null;
  entrySource: string | null;
  seconds: unknown;
  tokens?: unknown;
  cost?: unknown;
}

interface Acc {
  humanSeconds: number;
  agentSeconds: number;
  tokens: number;
  cost: number;
}

export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Whole minutes, the unit every surface displays. */
export const minutesFrom = (seconds: number): number => Math.max(0, Math.round(seconds / 60));

/**
 * api_cost_usd is a float4 column, so a stored 0.04 reads back as
 * 0.03999999910593033. Four decimals is past the tenth of a cent and well
 * inside float4's ~7 significant digits, so it restores the number the caller
 * sent without inventing precision.
 */
export const usd = (value: number): number => Math.round(value * 10_000) / 10_000;

export function emptyBySource(): BySource {
  return { human: { minutes: 0 }, agent: { minutes: 0, tokens: 0, costUsd: 0 } };
}

/** Total worked minutes across both sources. */
export const totalMinutes = (b: BySource): number => b.human.minutes + b.agent.minutes;

/**
 * Group rows into one BySource per key. Rounding happens once, at the end, so
 * that many short sessions do not each lose up to 30 seconds.
 */
export function foldGroups(rows: GroupRow[]): Map<number | null, BySource> {
  const acc = new Map<number | null, Acc>();
  for (const row of rows) {
    const cur = acc.get(row.key) ?? { humanSeconds: 0, agentSeconds: 0, tokens: 0, cost: 0 };
    const seconds = Math.max(0, num(row.seconds));
    if (row.entrySource === "agent") {
      cur.agentSeconds += seconds;
      cur.tokens += num(row.tokens);
      cur.cost += num(row.cost);
    } else {
      cur.humanSeconds += seconds;
    }
    acc.set(row.key, cur);
  }
  const out = new Map<number | null, BySource>();
  for (const [key, a] of acc) {
    out.set(key, {
      human: { minutes: minutesFrom(a.humanSeconds) },
      agent: { minutes: minutesFrom(a.agentSeconds), tokens: Math.round(a.tokens), costUsd: usd(a.cost) },
    });
  }
  return out;
}

/** Minutes of one closed (or still-running, measured to `now`) entry. */
export function entryMinutes(checkIn: Date | string, checkOut: Date | string | null, now = new Date()): number {
  const from = new Date(checkIn).getTime();
  const to = checkOut ? new Date(checkOut).getTime() : now.getTime();
  return minutesFrom(Math.max(0, (to - from) / 1000));
}
