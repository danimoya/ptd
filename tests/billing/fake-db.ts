/**
 * A stand-in for the drizzle client, shaped for the billing queries.
 *
 * Billing reads five tables — the org row, the org's memberships joined to users,
 * its `org_integrations` config (kind `billing`, kind `ai`), the invoices it has
 * issued and the `ai_usage` ledger — and writes two (the org row and the config
 * row). The fake keeps those as plain arrays and lets `update()` merge into them,
 * which is what makes a replayed webhook observably a no-op instead of a second write.
 *
 * It is deliberately dumb about SQL, with one exception: `where()` conditions are
 * scanned for their bound parameters, so a query for `org_integrations` of kind
 * `billing` does not also return the `ai` row. Drizzle keeps those parameters in
 * `queryChunks`, which is what `paramValues` walks.
 */
import { aiUsage, invoices, memberships, orgIntegrations, organizations } from "../../db/schema";

export type Row = Record<string, any>;

export type TableName = "organizations" | "memberships" | "org_integrations" | "invoices" | "ai_usage" | "other";

export interface Write {
  table: TableName;
  values: Row;
}

const CHAIN = ["leftJoin", "innerJoin", "orderBy", "groupBy", "limit", "offset", "for"] as const;

function tableName(table: unknown): TableName {
  if (table === organizations) return "organizations";
  if (table === memberships) return "memberships";
  if (table === orgIntegrations) return "org_integrations";
  if (table === invoices) return "invoices";
  if (table === aiUsage) return "ai_usage";
  return "other";
}

/** Every literal bound into a drizzle condition, at any depth. */
export function paramValues(value: unknown, depth = 0, out: (string | number)[] = []): (string | number)[] {
  if (!value || depth > 10) return out;
  if (Array.isArray(value)) {
    for (const item of value) paramValues(item, depth + 1, out);
    return out;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("value" in record && (typeof record.value === "string" || typeof record.value === "number")) out.push(record.value as string | number);
    for (const key of Object.keys(record)) {
      // `table` loops back to every column; `decoder` carries no literals.
      if (key === "table" || key === "decoder") continue;
      paramValues(record[key], depth + 1, out);
    }
  }
  return out;
}

/** True when every selected field is an aggregate (`count()`, `sum()`) rather than a column. */
function isAggregateSelection(fields: unknown): boolean {
  if (!fields || typeof fields !== "object") return false;
  const values = Object.values(fields as Record<string, unknown>);
  if (values.length === 0) return false;
  return values.every((v) => Boolean(v) && typeof v === "object" && "queryChunks" in (v as Record<string, unknown>));
}

export class FakeDb {
  /** Org rows, keyed by id. `update()` merges into these. */
  orgs = new Map<number, Row>();
  /** Membership rows already joined to their user (role, isAgent, email). */
  members: Row[] = [];
  /** `org_integrations` rows: {id, orgId, kind, config, enabled}. */
  integrations: Row[] = [];
  invoices: Row[] = [];
  aiUsage: Row[] = [];
  updates: Write[] = [];
  deletes: Write[] = [];
  selects: TableName[] = [];
  private empties = new Map<TableName, number>();
  private nextId = 1;

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

  /** Seed one `org_integrations` row. `config` is stored as given. */
  setIntegration(row: Row) {
    const existing = this.integrations.findIndex((r) => r.orgId === row.orgId && r.kind === row.kind);
    const next = { id: this.nextId++, enabled: true, config: {}, ...row };
    if (existing >= 0) this.integrations[existing] = next;
    else this.integrations.push(next);
    return this;
  }

  integration(kind: string, orgId?: number): Row | undefined {
    return this.integrations.find((r) => r.kind === kind && (orgId === undefined || r.orgId === orgId));
  }

  /** The stored billing config, which is what the webhook and the sync write. */
  billingConfig(orgId?: number): Row | undefined {
    return this.integration("billing", orgId)?.config;
  }

  setInvoices(rows: Row[]) {
    this.invoices = rows.map((r, i) => ({ id: i + 1, orgId: 1, reference: `PTD-2026-09-000${i + 1}`, issuedAt: new Date(), ...r }));
    return this;
  }

  setAiUsage(rows: Row[]) {
    this.aiUsage = rows.map((r, i) => ({ id: i + 1, orgId: 1, costUsd: 0, createdAt: new Date(), ...r }));
    return this;
  }

  /** Make the next N selects against `table` come back empty (the "nothing matches" branch). */
  queueEmpty(table: TableName, times = 1) {
    this.empties.set(table, (this.empties.get(table) ?? 0) + times);
    return this;
  }

  reset() {
    this.orgs.clear();
    this.members = [];
    this.integrations = [];
    this.invoices = [];
    this.aiUsage = [];
    this.updates = [];
    this.deletes = [];
    this.selects = [];
    this.empties.clear();
    this.nextId = 1;
    return this;
  }

  private all(table: TableName): Row[] {
    if (table === "organizations") return [...this.orgs.values()];
    if (table === "memberships") return this.members;
    if (table === "org_integrations") return this.integrations;
    if (table === "invoices") return this.invoices;
    if (table === "ai_usage") return this.aiUsage;
    return [];
  }

  private rowsFor(table: TableName, params: (string | number)[]): Row[] {
    const pending = this.empties.get(table) ?? 0;
    if (pending > 0) {
      this.empties.set(table, pending - 1);
      return [];
    }
    const rows = this.all(table);
    // Only `org_integrations` is filtered: one organization holds several kinds,
    // so an unfiltered answer would hand the billing reader the AI row.
    if (table !== "org_integrations") return rows;
    const strings = params.filter((p): p is string => typeof p === "string");
    const numbers = params.filter((p): p is number => typeof p === "number");
    return rows.filter(
      (row) =>
        (strings.length === 0 || strings.includes(row.kind)) &&
        (numbers.length === 0 || numbers.includes(row.orgId) || numbers.includes(row.id)),
    );
  }

  select(fields?: unknown) {
    let table: TableName = "other";
    let params: (string | number)[] = [];
    const b: any = {};
    b.from = (t: unknown) => {
      table = tableName(t);
      this.selects.push(table);
      return b;
    };
    b.where = (...args: unknown[]) => {
      params = paramValues(args);
      return b;
    };
    for (const m of CHAIN) b[m] = () => b;
    b.then = (ok: any, err: any) => {
      const rows = this.rowsFor(table, params);
      // `select({ n: count() })` wants one row of totals, not the rows themselves.
      const result = isAggregateSelection(fields) ? [Object.fromEntries(Object.keys(fields as Row).map((k) => [k, rows.length]))] : rows;
      return Promise.resolve(result).then(ok, err);
    };
    return b;
  }

  update(table: unknown) {
    const name = tableName(table);
    let values: Row = {};
    let params: (string | number)[] = [];
    const b: any = {};
    b.set = (v: Row) => {
      values = v;
      this.updates.push({ table: name, values: v });
      if (name === "organizations") for (const [id, row] of this.orgs) this.orgs.set(id, { ...row, ...v });
      return b;
    };
    b.where = (...args: unknown[]) => {
      params = paramValues(args);
      if (name === "org_integrations") {
        const targets = this.integrations.filter((row) => params.length === 0 || params.includes(row.id) || params.includes(row.orgId));
        for (const row of targets) Object.assign(row, values);
      }
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
    let inserted: Row[] = [];
    b.values = (values: Row | Row[]) => {
      const rows = Array.isArray(values) ? values : [values];
      inserted = rows.map((v) => ({ id: this.nextId++, ...v }));
      for (const row of inserted) {
        this.updates.push({ table: name, values: row });
        if (name === "org_integrations") this.integrations.push(row);
        if (name === "invoices") this.invoices.push(row);
        if (name === "ai_usage") this.aiUsage.push(row);
        if (name === "memberships") this.members.push(row);
      }
      return b;
    };
    b.returning = () => b;
    b.then = (ok: any, err: any) => Promise.resolve(inserted).then(ok, err);
    return b;
  }

  delete(table: unknown) {
    const name = tableName(table);
    const b: any = {};
    let removed: Row[] = [];
    b.where = (...args: unknown[]) => {
      const params = paramValues(args);
      if (name === "org_integrations") {
        const strings = params.filter((p): p is string => typeof p === "string");
        const numbers = params.filter((p): p is number => typeof p === "number");
        removed = this.integrations.filter(
          (row) =>
            (strings.length === 0 || strings.includes(row.kind)) &&
            (numbers.length === 0 || numbers.includes(row.orgId) || numbers.includes(row.id)),
        );
        this.integrations = this.integrations.filter((row) => !removed.includes(row));
        for (const row of removed) this.deletes.push({ table: name, values: row });
      }
      return b;
    };
    for (const m of CHAIN) b[m] = () => b;
    b.returning = () => b;
    b.then = (ok: any, err: any) => Promise.resolve(removed).then(ok, err);
    return b;
  }
}

export const fakeDb = new FakeDb();
