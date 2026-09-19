/**
 * A minimal stand-in for the drizzle client, for the reporting actions.
 *
 * The reports are folds over rows: what is worth testing is the fold and the
 * scope gate, not whether drizzle can build SQL. So this fake answers every
 * builder chain from a queue of canned rows and records what was written. A
 * query with nothing queued comes back empty, which is the "nothing logged"
 * branch every report has to survive.
 *
 * Deliberately local to tests/reports rather than borrowed from tests/track, so
 * the two suites cannot break each other.
 */

export type Row = Record<string, any>;

const CHAIN = ["leftJoin", "innerJoin", "where", "orderBy", "groupBy", "limit", "offset", "for"] as const;

export class FakeDb {
  /** Results handed out in call order, regardless of which table was queried. */
  private results: Row[][] = [];
  inserts: { table: unknown; values: Row }[] = [];
  updates: { table: unknown; values: Row }[] = [];
  selects = 0;

  reset() {
    this.results = [];
    this.inserts = [];
    this.updates = [];
    this.selects = 0;
    return this;
  }

  /** Queue the next result set; queue once per expected query, in order. */
  queue(...sets: Row[][]) {
    this.results.push(...sets);
    return this;
  }

  private take(): Row[] {
    return this.results.length ? this.results.shift()! : [];
  }

  select(_fields?: unknown) {
    this.selects += 1;
    const b: any = {};
    b.from = () => b;
    for (const m of CHAIN) b[m] = () => b;
    b.then = (ok: any, err: any) => Promise.resolve(this.take()).then(ok, err);
    return b;
  }

  insert(table: unknown) {
    const b: any = {};
    b.values = (values: Row) => {
      this.inserts.push({ table, values });
      b.returning = () => Promise.resolve([{ id: 77, ...values }]);
      b.then = (ok: any, err: any) => Promise.resolve([{ id: 77, ...values }]).then(ok, err);
      return b;
    };
    return b;
  }

  update(table: unknown) {
    const b: any = {};
    b.set = (values: Row) => {
      this.updates.push({ table, values });
      b.where = () => b;
      b.returning = () => Promise.resolve([{ id: 77, ...values }]);
      b.then = (ok: any, err: any) => Promise.resolve([{ id: 77, ...values }]).then(ok, err);
      return b;
    };
    return b;
  }
}
