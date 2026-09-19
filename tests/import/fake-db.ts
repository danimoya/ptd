/**
 * A drizzle stand-in for the importer tests.
 *
 * Modelled on tests/track/fake-db.ts, with the one thing an importer needs that
 * the Track surface never does: `insert(table).values([…])` with an ARRAY, which
 * is how apply.ts writes its chunks. Each queued insert comes back with a
 * generated id per row, so the caller's `.returning()` behaves like the real
 * multi-row INSERT … RETURNING.
 */

export type Row = Record<string, any>;

const CHAIN = ["leftJoin", "innerJoin", "where", "orderBy", "groupBy", "limit", "offset", "for"] as const;

export interface InsertCall {
  table: unknown;
  rows: Row[];
}

export class FakeDb {
  private queues = new Map<unknown, Row[][]>();
  private seq = 1000;
  inserts: InsertCall[] = [];
  updates: { table: unknown; values: Row }[] = [];

  reset() {
    this.queues.clear();
    this.inserts = [];
    this.updates = [];
    this.seq = 1000;
  }

  /** Canned answer for the next SELECT against `table`, in call order. */
  queue(table: unknown, rows: Row[]) {
    const q = this.queues.get(table) ?? [];
    q.push(rows);
    this.queues.set(table, q);
    return this;
  }

  private take(table: unknown): Row[] {
    const q = this.queues.get(table);
    return q && q.length ? q.shift()! : [];
  }

  /** Every row this run inserted into `table`, flattened across chunks. */
  insertedInto(table: unknown): Row[] {
    return this.inserts.filter((i) => i.table === table).flatMap((i) => i.rows);
  }

  select(_fields?: unknown) {
    let table: unknown = null;
    const b: any = {};
    b.from = (t: unknown) => {
      table = t;
      return b;
    };
    for (const m of CHAIN) b[m] = () => b;
    b.then = (ok: any, err: any) => Promise.resolve(this.take(table)).then(ok, err);
    return b;
  }

  insert(table: unknown) {
    const b: any = {};
    let rows: Row[] = [];
    b.values = (v: Row | Row[]) => {
      rows = Array.isArray(v) ? v : [v];
      this.inserts.push({ table, rows });
      return b;
    };
    b.onConflictDoNothing = () => b;
    b.returning = () => b;
    b.then = (ok: any, err: any) => {
      const queued = this.take(table);
      const out = queued.length ? queued : rows.map((r) => ({ id: ++this.seq, ...r }));
      return Promise.resolve(out).then(ok, err);
    };
    return b;
  }

  update(table: unknown) {
    const b: any = {};
    let values: Row = {};
    b.set = (v: Row) => {
      values = v;
      this.updates.push({ table, values: v });
      return b;
    };
    for (const m of CHAIN) b[m] = () => b;
    b.returning = () => b;
    b.then = (ok: any, err: any) => {
      const queued = this.take(table);
      return Promise.resolve(queued.length ? queued : [{ id: ++this.seq, ...values }]).then(ok, err);
    };
    return b;
  }

  delete(table: unknown) {
    const b: any = {};
    for (const m of CHAIN) b[m] = () => b;
    b.returning = () => b;
    b.then = (ok: any, err: any) => Promise.resolve(this.take(table)).then(ok, err);
    return b;
  }
}
