/**
 * A stand-in for the drizzle client, for the auth and invitation routes.
 *
 * What is worth testing in those routes is the decision — does an unknown
 * address still get a 200, is a spent token refused, does the new hash actually
 * get written — not whether drizzle can build SQL. So this fake answers every
 * builder chain from a queue of canned rows, in call order, and records what was
 * written so a test can assert on it.
 *
 * Local to tests/auth on purpose, so this suite and tests/reports cannot break
 * each other.
 */

export type Row = Record<string, any>;

const CHAIN = ["from", "leftJoin", "innerJoin", "where", "orderBy", "groupBy", "limit", "offset", "for"] as const;

export class FakeDb {
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

  /** Queue one result set per expected query, in the order they will be made. */
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
    for (const m of CHAIN) b[m] = () => b;
    b.then = (ok: any, err: any) => Promise.resolve(this.take()).then(ok, err);
    return b;
  }

  insert(table: unknown) {
    const b: any = {};
    b.values = (values: Row) => {
      this.inserts.push({ table, values });
      const rows = [{ id: 77, ...values }];
      b.returning = () => Promise.resolve(rows);
      b.then = (ok: any, err: any) => Promise.resolve(rows).then(ok, err);
      return b;
    };
    return b;
  }

  update(table: unknown) {
    const b: any = {};
    b.set = (values: Row) => {
      this.updates.push({ table, values });
      const rows = [{ id: 77, ...values }];
      b.where = () => b;
      b.returning = () => Promise.resolve(rows);
      b.then = (ok: any, err: any) => Promise.resolve(rows).then(ok, err);
      return b;
    };
    return b;
  }

  delete(_table: unknown) {
    const b: any = {};
    b.where = () => b;
    b.returning = () => Promise.resolve([]);
    b.then = (ok: any, err: any) => Promise.resolve([]).then(ok, err);
    return b;
  }

  execute(_query?: unknown) {
    return Promise.resolve(this.take());
  }

  /** The values of the last write against a given table, for assertions. */
  lastUpdate(table: unknown): Row | undefined {
    for (let i = this.updates.length - 1; i >= 0; i -= 1) if (this.updates[i].table === table) return this.updates[i].values;
    return undefined;
  }

  lastInsert(table: unknown): Row | undefined {
    for (let i = this.inserts.length - 1; i >= 0; i -= 1) if (this.inserts[i].table === table) return this.inserts[i].values;
    return undefined;
  }
}

export const fakeDb = new FakeDb();
