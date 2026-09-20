/**
 * A stand-in for the drizzle client, shaped for the reads and the one write the
 * AI actions make.
 *
 * Unlike the billing fake it honours the WHERE clause: `eq()` conditions carry
 * their column name and their value in the SQL object drizzle builds, so the
 * chain below pulls those pairs out and filters rows with them. That matters
 * here because `task.get` fetches the whole backlog and then one specific card —
 * a fake that ignored the predicate would answer with the wrong card and the
 * test would prove nothing.
 */
import { apps, orgIntegrations, streams, taskEvents, tasks, users } from "../../db/schema";

export type Row = Record<string, any>;

type TableName = "tasks" | "streams" | "apps" | "users" | "task_events" | "org_integrations" | "other";

function tableName(table: unknown): TableName {
  if (table === tasks) return "tasks";
  if (table === streams) return "streams";
  if (table === apps) return "apps";
  if (table === users) return "users";
  if (table === taskEvents) return "task_events";
  if (table === orgIntegrations) return "org_integrations";
  return "other";
}

/**
 * Pull `{column: value}` equality pairs out of a drizzle condition.
 *
 * The SQL object is a tree of `queryChunks`; an `eq(col, v)` contributes the
 * column node, a `" = "` literal and then the bound parameter, so pairing a
 * column with the next parameter recovers the filter. Anything that is not a
 * plain equality is ignored, which is fine — every query on this path is
 * `and(eq(...), eq(...))`.
 */
export function eqFilters(condition: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let pending: string | null = null;

  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (typeof node.name === "string" && node.config && !("queryChunks" in node)) {
      pending = node.name;
      return;
    }
    if ("value" in node && node.encoder && pending) {
      out[pending] = node.value;
      pending = null;
      return;
    }
    if (Array.isArray(node.queryChunks)) for (const chunk of node.queryChunks) walk(chunk);
  };

  walk(condition);
  return out;
}

/** snake_case column name → the camelCase key the fake rows use. */
const camel = (name: string) => name.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

function matches(row: Row, filters: Record<string, unknown>): boolean {
  return Object.entries(filters).every(([column, value]) => {
    const key = camel(column);
    if (!(key in row)) return true; // a column the fake row does not model
    return row[key] === value;
  });
}

class Chain implements PromiseLike<Row[]> {
  private table: TableName = "other";
  private filters: Record<string, unknown> = {};
  private max: number | null = null;

  constructor(private fake: FakeDb) {}

  from(table: unknown) {
    this.table = tableName(table);
    this.fake.selects.push(this.table);
    return this;
  }
  where(condition: unknown) {
    this.filters = { ...this.filters, ...eqFilters(condition) };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  orderBy() {
    return this;
  }
  leftJoin() {
    return this;
  }
  innerJoin() {
    return this;
  }
  offset() {
    return this;
  }

  private rows(): Row[] {
    const all = this.fake.rows[this.table] ?? [];
    const hits = all.filter((r) => matches(r, this.filters));
    const page = this.max === null ? hits : hits.slice(0, this.max);
    // Copies, like a real query: handing back the stored object would let an
    // UPDATE mutate the "before" snapshot a caller is holding, and diffTask
    // would then see no change at all.
    return page.map((r) => ({ ...r }));
  }

  then<R1 = Row[], R2 = never>(
    onfulfilled?: ((value: Row[]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.rows()).then(onfulfilled, onrejected);
  }
}

export class FakeDb {
  rows: Record<TableName, Row[]> = {
    tasks: [],
    streams: [],
    apps: [],
    users: [],
    task_events: [],
    org_integrations: [],
    other: [],
  };
  selects: TableName[] = [];
  inserts: { table: TableName; values: Row }[] = [];
  updates: { table: TableName; values: Row; filters: Record<string, unknown> }[] = [];

  reset() {
    for (const key of Object.keys(this.rows) as TableName[]) this.rows[key] = [];
    this.selects = [];
    this.inserts = [];
    this.updates = [];
    return this;
  }

  setTasks(rows: Row[]) {
    this.rows.tasks = rows.map((r) => ({ ...r }));
    return this;
  }

  task(id: number): Row | undefined {
    return this.rows.tasks.find((t) => t.id === id);
  }

  select(_fields?: unknown) {
    return new Chain(this);
  }

  insert(table: unknown) {
    const name = tableName(table);
    return {
      values: async (values: Row) => {
        this.inserts.push({ table: name, values });
        this.rows[name].push({ id: this.rows[name].length + 1, ...values });
        return [];
      },
    };
  }

  update(table: unknown) {
    const name = tableName(table);
    return {
      set: (values: Row) => {
        let filters: Record<string, unknown> = {};
        const step = {
          where: (condition: unknown) => {
            filters = eqFilters(condition);
            return step;
          },
          returning: async () => {
            this.updates.push({ table: name, values, filters });
            const hit = this.rows[name].find((r) => matches(r, filters));
            if (!hit) return [];
            Object.assign(hit, values);
            return [{ ...hit }];
          },
        };
        return step;
      },
    };
  }

  delete() {
    return { where: async () => [] };
  }
}

export const fakeDb = new FakeDb();
