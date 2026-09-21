/**
 * A stand-in for the drizzle client that actually *keeps* what it is told.
 *
 * The queue-of-canned-rows fake in ./fake-db.ts is right for verification, which
 * only reads. Access codes are a conversation — ask, store, redeem, store again —
 * so testing them against a fake that forgets every write would only prove the
 * code compiles. This one holds one invoice row, applies updates to it, and
 * answers each query from whichever table it was pointed at, so a test can run the
 * real sequence: request a code, read the code out of it, redeem it, and watch the
 * attempt counter and the recipient list move.
 *
 * It recognises tables by identity, not by name, so a query pointed at the wrong
 * table answers nothing rather than answering something plausible.
 */

import { auditEvents, invoices, memberships, users } from "../../db/schema";

export type Row = Record<string, any>;

const CHAIN = ["leftJoin", "orderBy", "groupBy", "limit", "offset", "for"] as const;

export interface AuditRecord {
  orgId: number | null;
  kind: string;
  target: string | null;
  meta: Record<string, unknown> | null;
}

export class AccessDb {
  invoice: Row;
  /** Owners, admins and managers, as `standingAddresses` reads them. */
  staff: Row[] = [];
  /** Every user row, for the contractor lookup by id. */
  people: Row[] = [];
  audits: AuditRecord[] = [];
  updates = 0;

  constructor(invoice: Row) {
    this.invoice = invoice;
  }

  private rowsFor(table: unknown): Row[] {
    if (table === invoices) return [this.invoice];
    if (table === memberships) return this.staff;
    if (table === users) return this.people;
    return [];
  }

  select(_fields?: unknown) {
    const b: any = {};
    let rows: Row[] = [];
    let joined = false;
    b.from = (table: unknown) => {
      rows = this.rowsFor(table);
      return b;
    };
    // `standingAddresses` selects FROM memberships and joins users; the staff rows
    // already carry both halves, so the join is a no-op rather than a cross product.
    b.innerJoin = () => {
      joined = true;
      return b;
    };
    for (const m of CHAIN) b[m] = () => b;
    b.where = () => b;
    b.then = (ok: any, err: any) => Promise.resolve(joined ? rows : rows).then(ok, err);
    return b;
  }

  insert(table: unknown) {
    const b: any = {};
    b.values = (values: Row) => {
      if (table === auditEvents) {
        this.audits.push({ orgId: values.orgId ?? null, kind: values.kind, target: values.target ?? null, meta: values.meta ?? null });
      }
      const rows = [{ id: 1, ...values }];
      b.returning = () => Promise.resolve(rows);
      b.then = (ok: any, err: any) => Promise.resolve(rows).then(ok, err);
      return b;
    };
    return b;
  }

  update(table: unknown) {
    const b: any = {};
    b.set = (values: Row) => {
      if (table === invoices) {
        this.updates += 1;
        Object.assign(this.invoice, values);
      }
      b.where = () => b;
      b.returning = () => Promise.resolve([this.invoice]);
      b.then = (ok: any, err: any) => Promise.resolve([this.invoice]).then(ok, err);
      return b;
    };
    return b;
  }

  delete() {
    const b: any = {};
    b.where = () => Promise.resolve([]);
    return b;
  }
}

/** The live instance the mocked `../../db` module hands out. */
export const state: { db: AccessDb } = { db: new AccessDb({}) };
