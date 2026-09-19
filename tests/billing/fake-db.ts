/**
 * A stand-in for the drizzle client, shaped for the billing queries.
 *
 * Billing reads two things (the org row, the org's memberships joined to users)
 * and writes one (the org row), so the fake keeps a mutable org record and lets
 * `update()` merge into it — that is what makes a replayed webhook observably a
 * no-op instead of a second write.
 */
import { memberships, organizations } from "../../db/schema";

export type Row = Record<string, any>;

export interface Write {
  table: "organizations" | "memberships" | "other";
  values: Row;
}

const CHAIN = ["leftJoin", "innerJoin", "where", "orderBy", "groupBy", "limit", "offset", "for"] as const;

function tableName(table: unknown): Write["table"] {
  if (table === organizations) return "organizations";
  if (table === memberships) return "memberships";
  return "other";
}

export class FakeDb {
  /** Org rows, keyed by id. `update()` merges into these. */
  orgs = new Map<number, Row>();
  /** Membership rows already joined to their user (role, isAgent, email). */
  members: Row[] = [];
  updates: Write[] = [];
  selects: Write["table"][] = [];
  private empties = new Map<Write["table"], number>();

  setOrg(row: Row) {
    this.orgs.set(row.id, { plan: "free", stripeCustomerId: null, stripeSubscriptionId: null, name: `Org ${row.id}`, ...row });
    return this;
  }

  org(id: number): Row | undefined {
    return this.orgs.get(id);
  }

  setMembers(rows: Row[]) {
    this.members = rows.map((r, i) => ({ orgId: 1, role: "member", isAgent: false, email: `m${i}@example.test`, createdAt: new Date(2026, 0, i + 1), ...r }));
    return this;
  }

  /** Make the next N selects against `table` come back empty (the "nothing matches" branch). */
  queueEmpty(table: Write["table"], times = 1) {
    this.empties.set(table, (this.empties.get(table) ?? 0) + times);
    return this;
  }

  reset() {
    this.orgs.clear();
    this.members = [];
    this.updates = [];
    this.selects = [];
    this.empties.clear();
    return this;
  }

  private rowsFor(table: Write["table"]): Row[] {
    const pending = this.empties.get(table) ?? 0;
    if (pending > 0) {
      this.empties.set(table, pending - 1);
      return [];
    }
    if (table === "organizations") return [...this.orgs.values()];
    if (table === "memberships") return this.members;
    return [];
  }

  select(_fields?: unknown) {
    let table: Write["table"] = "other";
    const b: any = {};
    b.from = (t: unknown) => {
      table = tableName(t);
      this.selects.push(table);
      return b;
    };
    for (const m of CHAIN) b[m] = () => b;
    b.then = (ok: any, err: any) => Promise.resolve(this.rowsFor(table)).then(ok, err);
    return b;
  }

  update(table: unknown) {
    const name = tableName(table);
    const b: any = {};
    b.set = (values: Row) => {
      this.updates.push({ table: name, values });
      if (name === "organizations") for (const [id, row] of this.orgs) this.orgs.set(id, { ...row, ...values });
      return b;
    };
    for (const m of CHAIN) b[m] = () => b;
    b.returning = () => b;
    b.then = (ok: any, err: any) => Promise.resolve([]).then(ok, err);
    return b;
  }

  insert(table: unknown) {
    const name = tableName(table);
    const b: any = {};
    b.values = (values: Row) => {
      this.updates.push({ table: name, values });
      return b;
    };
    b.returning = () => b;
    b.then = (ok: any, err: any) => Promise.resolve([]).then(ok, err);
    return b;
  }

  delete(table: unknown) {
    const b: any = {};
    void tableName(table);
    for (const m of CHAIN) b[m] = () => b;
    b.returning = () => b;
    b.then = (ok: any, err: any) => Promise.resolve([]).then(ok, err);
    return b;
  }
}

export const fakeDb = new FakeDb();
