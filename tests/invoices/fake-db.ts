/**
 * A stand-in for the drizzle client, for the invoicing modules.
 *
 * What is worth testing here is the certification logic — the hash, the
 * signature, the three integrity checks — not whether drizzle can build SQL. So
 * this fake answers every builder chain from a queue of canned rows in call order
 * and records what was written.
 *
 * Local to tests/invoices on purpose, so this suite and tests/track cannot break
 * each other.
 */

export type Row = Record<string, any>;

const CHAIN = ["leftJoin", "innerJoin", "where", "orderBy", "groupBy", "limit", "offset", "for"] as const;

export class FakeDb {
  private results: Row[][] = [];
  inserts: { table: unknown; values: Row }[] = [];
  updates: { table: unknown; values: Row }[] = [];
  deletes: { table: unknown }[] = [];
  selects = 0;

  reset() {
    this.results = [];
    this.inserts = [];
    this.updates = [];
    this.deletes = [];
    this.selects = 0;
    return this;
  }

  /** Queue the next result set; one call per expected query, in order. */
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
      b.returning = (_cols?: unknown) => Promise.resolve(rows);
      b.then = (ok: any, err: any) => Promise.resolve(rows).then(ok, err);
      return b;
    };
    return b;
  }

  delete(table: unknown) {
    const b: any = {};
    this.deletes.push({ table });
    b.where = () => Promise.resolve([]);
    return b;
  }
}
