/**
 * A stand-in for the drizzle client.
 *
 * The track actions are mostly orchestration — decide the attribution, refuse
 * the second open timer, fold the totals — and the thing worth testing is what
 * they *write*, not whether drizzle can build SQL. So this fake answers every
 * query builder chain from a per-table queue of canned rows and records each
 * insert/update/delete for assertions. A query with nothing queued comes back
 * empty, which is exactly the "nothing is running / not found" branch.
 */

export type Row = Record<string, any>;

interface Write {
  table: unknown;
  values: Row;
}

const CHAIN = ["leftJoin", "innerJoin", "where", "orderBy", "groupBy", "limit", "offset", "for"] as const;

export class FakeDb {
  private queues = new Map<unknown, Row[][]>();
  private seq = 100;
  inserts: Write[] = [];
  updates: Write[] = [];
  deletes: { table: unknown }[] = [];

  reset() {
    this.queues.clear();
    this.inserts = [];
    this.updates = [];
    this.deletes = [];
    this.seq = 100;
  }

  /** Queue the next result for the next query against `table`, in call order. */
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
      const rows = queued.length ? queued : [{ id: ++this.seq, checkIn: new Date(), checkOut: null, isBreak: false, ...values }];
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
      const rows = queued.length ? queued : [{ id: ++this.seq, checkIn: new Date(Date.now() - 60_000), checkOut: new Date(), isBreak: false, ...values }];
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
