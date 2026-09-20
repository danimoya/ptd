/**
 * A stand-in for the drizzle client, local to the usage tests.
 *
 * The verified-usage actions are orchestration — decide the cost basis, refuse a
 * human entry, write four columns — so what is worth testing is what they *write*,
 * not whether drizzle can build SQL. Every builder chain resolves from a
 * per-table queue of canned rows, and every insert/update is recorded.
 *
 * A deliberate copy rather than a shared helper: the Track surface's fake belongs
 * to the Track tests and may change with them.
 */

export type Row = Record<string, any>;

interface Write {
  table: unknown;
  values: Row;
}

const CHAIN = ["leftJoin", "innerJoin", "where", "orderBy", "groupBy", "limit", "offset", "for"] as const;

export class FakeDb {
  private queues = new Map<unknown, Row[][]>();
  private seq = 500;
  inserts: Write[] = [];
  updates: Write[] = [];
  deletes: { table: unknown }[] = [];

  reset(): void {
    this.queues.clear();
    this.inserts = [];
    this.updates = [];
    this.deletes = [];
    this.seq = 500;
  }

  /** Queue the next result for the next query against `table`, in call order. */
  queue(table: unknown, rows: Row[]): this {
    const q = this.queues.get(table) ?? [];
    q.push(rows);
    this.queues.set(table, q);
    return this;
  }

  private take(table: unknown): Row[] {
    const q = this.queues.get(table);
    return q && q.length ? q.shift()! : [];
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
    let values: Row = {};
    b.values = (v: Row) => {
      values = v;
      this.inserts.push({ table, values: v });
      return b;
    };
    b.returning = () => b;
    b.then = (ok: any, err: any) => {
      const queued = this.take(table);
      const rows = queued.length ? queued : [{ id: ++this.seq, createdAt: new Date(), ...values }];
      return Promise.resolve(rows).then(ok, err);
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
      const rows = queued.length ? queued : [{ id: ++this.seq, ...values }];
      return Promise.resolve(rows).then(ok, err);
    };
    return b;
  }

  delete(table: unknown) {
    const b: any = {};
    this.deletes.push({ table });
    for (const m of CHAIN) b[m] = () => b;
    b.returning = () => b;
    b.then = (ok: any, err: any) => Promise.resolve(this.take(table)).then(ok, err);
    return b;
  }
}
