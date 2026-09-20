import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { customFields, taskCustomValues } from "../../db/schema";
import { ActionError } from "../actions/registry";

/** db/schema.ts is frozen and exports no row types for these tables, so they are inferred here. */
export type CustomField = typeof customFields.$inferSelect;

/**
 * Per-organization custom fields on a card.
 *
 * A field is defined once for the org (`custom_fields`) and holds a value per
 * card (`task_custom_values`). Two decisions worth knowing:
 *
 *  - **`key` is derived from the name and then frozen.** It is what every wire
 *    shape uses (`custom: { severity: "high" }`), so renaming the field changes
 *    its label and not its identity — an agent's saved payload keeps working.
 *  - **Archiving, never deleting.** Cards keep values for an archived field so
 *    history stays honest; the field just stops being offered. `field.list`
 *    hides archived fields unless asked, and `custom` omits their values.
 */

export const FIELD_KINDS = ["text", "number", "date", "select", "multiselect", "checkbox", "url"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const MAX_FIELDS_PER_ORG = 40;
const MAX_TEXT_LENGTH = 2000;

export function isChoiceKind(kind: string): boolean {
  return kind === "select" || kind === "multiselect";
}

/** "Customer severity" → "customer_severity". Stable, lowercase, no leading digit. */
export function deriveKey(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 34);
  if (!base) return "field";
  return /^[0-9]/.test(base) ? `f_${base}` : base;
}

export function choicesOf(field: Pick<CustomField, "options">): string[] {
  const raw = (field.options ?? {}) as Record<string, unknown>;
  return Array.isArray(raw.choices) ? (raw.choices as unknown[]).filter((c): c is string => typeof c === "string") : [];
}

export interface FieldRow {
  id: number;
  name: string;
  key: string;
  kind: FieldKind | string;
  options: string[];
  position: number;
  archived: boolean;
  createdAt: string | null;
}

export function serializeField(row: CustomField): FieldRow {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    kind: row.kind,
    options: choicesOf(row),
    position: row.position,
    archived: row.archived,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };
}

export async function listFieldRows(orgId: number, includeArchived = false): Promise<CustomField[]> {
  const rows = (await db
    .select()
    .from(customFields)
    .where(eq(customFields.orgId, orgId))
    .orderBy(asc(customFields.position), asc(customFields.id))) as CustomField[];
  return includeArchived ? rows : rows.filter((r) => !r.archived);
}

export async function requireField(orgId: number, fieldId: number): Promise<CustomField> {
  const [row] = await db
    .select()
    .from(customFields)
    .where(and(eq(customFields.id, fieldId), eq(customFields.orgId, orgId)))
    .limit(1);
  if (!row) throw new ActionError("not_found", `Custom field ${fieldId} not found in this organization`);
  return row as CustomField;
}

function normaliseChoices(kind: string, options: string[] | undefined): string[] | null {
  if (!isChoiceKind(kind)) {
    if (options && options.length > 0) throw new ActionError("invalid", `A ${kind} field has no options — only select and multiselect do`);
    return null;
  }
  const cleaned: string[] = [];
  for (const raw of options ?? []) {
    const choice = String(raw).trim();
    if (!choice) continue;
    if (choice.length > 80) throw new ActionError("invalid", `Option "${choice.slice(0, 20)}…" is longer than 80 characters`);
    if (!cleaned.includes(choice)) cleaned.push(choice);
  }
  if (cleaned.length === 0) throw new ActionError("invalid", `A ${kind} field needs at least one option`);
  if (cleaned.length > 50) throw new ActionError("invalid", "A field may offer at most 50 options");
  return cleaned;
}

export async function createField(
  orgId: number,
  input: { name: string; kind: string; options?: string[]; position?: number }
): Promise<CustomField> {
  const name = input.name.trim();
  if (!name) throw new ActionError("invalid", "A field needs a name");
  if (!(FIELD_KINDS as readonly string[]).includes(input.kind)) {
    throw new ActionError("invalid", `kind must be one of ${FIELD_KINDS.join(", ")}`);
  }
  const existing = await listFieldRows(orgId, true);
  if (existing.length >= MAX_FIELDS_PER_ORG) {
    throw new ActionError("invalid", `An organization may define at most ${MAX_FIELDS_PER_ORG} custom fields — archive one first`);
  }
  if (existing.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
    throw new ActionError("conflict", `A custom field named "${name}" already exists in this organization`);
  }

  // The key is the wire identity, so a collision gets a suffix rather than an error.
  const taken = new Set(existing.map((f) => f.key));
  const base = deriveKey(name);
  let key = base;
  for (let i = 2; taken.has(key) && i < 100; i++) key = `${base}_${i}`;

  const choices = normaliseChoices(input.kind, input.options);
  const position = input.position ?? (existing.length === 0 ? 0 : Math.max(...existing.map((f) => f.position)) + 1);
  const [row] = await db
    .insert(customFields)
    .values({ orgId, name, key, kind: input.kind, options: choices ? { choices } : null, position })
    .returning();
  return row as CustomField;
}

export async function updateField(
  orgId: number,
  fieldId: number,
  patch: { name?: string; options?: string[]; position?: number; archived?: boolean }
): Promise<CustomField> {
  const field = await requireField(orgId, fieldId);
  const update: Record<string, unknown> = {};

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new ActionError("invalid", "A field needs a name");
    const others = (await listFieldRows(orgId, true)).filter((f) => f.id !== fieldId);
    if (others.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      throw new ActionError("conflict", `A custom field named "${name}" already exists in this organization`);
    }
    update.name = name;
  }
  if (patch.options !== undefined) {
    const choices = normaliseChoices(field.kind, patch.options);
    // Dropping a choice that cards already use would silently invalidate them.
    if (choices) {
      const used = await usedChoices(orgId, field);
      const orphaned = used.filter((v) => !choices.includes(v));
      if (orphaned.length > 0) {
        throw new ActionError("invalid", `Cards still use the option(s) ${orphaned.join(", ")} — clear them before removing the option`);
      }
      update.options = { choices };
    }
  }
  if (patch.position !== undefined) update.position = patch.position;
  if (patch.archived !== undefined) update.archived = patch.archived;
  if (Object.keys(update).length === 0) return field;

  const [row] = await db
    .update(customFields)
    .set(update)
    .where(and(eq(customFields.id, fieldId), eq(customFields.orgId, orgId)))
    .returning();
  return row as CustomField;
}

/** Every distinct choice this field currently holds on a card. */
async function usedChoices(orgId: number, field: CustomField): Promise<string[]> {
  const rows = await db
    .select({ value: taskCustomValues.value })
    .from(taskCustomValues)
    .innerJoin(customFields, eq(taskCustomValues.fieldId, customFields.id))
    .where(and(eq(customFields.orgId, orgId), eq(taskCustomValues.fieldId, field.id)));
  const out = new Set<string>();
  for (const row of rows) {
    const value = row.value;
    if (typeof value === "string") out.add(value);
    else if (Array.isArray(value)) for (const v of value) if (typeof v === "string") out.add(v);
  }
  return [...out];
}

/**
 * Coerce and validate one value against its field.
 *
 * Returns the value as it will be stored, or throws with a message that names
 * the field by key — an agent posting `task.set_custom` gets told which key was
 * wrong, not just "invalid".
 */
export function validateValue(field: Pick<CustomField, "key" | "kind" | "options">, raw: unknown): unknown {
  const where = `custom field "${field.key}"`;
  switch (field.kind) {
    case "text": {
      if (typeof raw !== "string") throw new ActionError("invalid", `${where} takes text`);
      if (raw.length > MAX_TEXT_LENGTH) throw new ActionError("invalid", `${where} is at most ${MAX_TEXT_LENGTH} characters`);
      return raw;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n)) throw new ActionError("invalid", `${where} takes a number, got ${JSON.stringify(raw)}`);
      return n;
    }
    case "date": {
      if (typeof raw !== "string" || !raw.trim()) throw new ActionError("invalid", `${where} takes an ISO date such as 2026-09-20`);
      const date = new Date(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw);
      if (Number.isNaN(date.getTime())) throw new ActionError("invalid", `${where}: "${raw}" is not a valid ISO 8601 date`);
      // Stored as a plain day: a custom date is a calendar date, not an instant.
      return date.toISOString().slice(0, 10);
    }
    case "checkbox": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "false") return raw === "true";
      throw new ActionError("invalid", `${where} takes true or false`);
    }
    case "url": {
      if (typeof raw !== "string" || !raw.trim()) throw new ActionError("invalid", `${where} takes a URL`);
      const value = raw.trim();
      if (value.length > 500) throw new ActionError("invalid", `${where} is at most 500 characters`);
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new ActionError("invalid", `${where}: "${value}" is not a URL (include https://)`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ActionError("invalid", `${where} accepts http(s) URLs only, not ${parsed.protocol}`);
      }
      return value;
    }
    case "select": {
      const choices = choicesOf(field);
      if (typeof raw !== "string" || !choices.includes(raw)) {
        throw new ActionError("invalid", `${where} accepts one of: ${choices.join(", ")}`);
      }
      return raw;
    }
    case "multiselect": {
      const choices = choicesOf(field);
      const list = Array.isArray(raw) ? raw : [raw];
      const out: string[] = [];
      for (const item of list) {
        if (typeof item !== "string" || !choices.includes(item)) {
          throw new ActionError("invalid", `${where} accepts any of: ${choices.join(", ")}`);
        }
        if (!out.includes(item)) out.push(item);
      }
      return out;
    }
    default:
      throw new ActionError("invalid", `${where} has an unknown kind "${field.kind}"`);
  }
}

/**
 * Apply a `{ key: value }` patch to one card. `null` clears a key; a key the org
 * does not define is an error rather than a silent no-op, so a typo in an
 * agent's payload surfaces immediately.
 */
export async function setCustomValues(
  orgId: number,
  taskId: number,
  values: Record<string, unknown>
): Promise<{ set: Record<string, unknown>; cleared: string[] }> {
  const fields = await listFieldRows(orgId, true);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const existing = await db
    .select({ id: taskCustomValues.id, fieldId: taskCustomValues.fieldId })
    .from(taskCustomValues)
    .where(eq(taskCustomValues.taskId, taskId));
  const rowByField = new Map(existing.map((r) => [r.fieldId, r.id]));

  const set: Record<string, unknown> = {};
  const cleared: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const field = byKey.get(key);
    if (!field) {
      throw new ActionError("invalid", `"${key}" is not a custom field in this organization — call field.list for the keys`);
    }
    if (field.archived && raw !== null) {
      throw new ActionError("invalid", `Custom field "${key}" is archived — unarchive it before writing to it`);
    }
    const rowId = rowByField.get(field.id);
    if (raw === null) {
      if (rowId !== undefined) await db.delete(taskCustomValues).where(eq(taskCustomValues.id, rowId));
      cleared.push(key);
      continue;
    }
    const value = validateValue(field, raw);
    if (rowId !== undefined) await db.update(taskCustomValues).set({ value }).where(eq(taskCustomValues.id, rowId));
    else await db.insert(taskCustomValues).values({ taskId, fieldId: field.id, value });
    set[key] = value;
  }
  return { set, cleared };
}

/**
 * `{ taskId: { key: value } }` for the whole org, or for the given task ids.
 *
 * One query, filtered in JS: the alternative is an `IN (…)` list per page, and
 * HeliosDB-Nano is happier with a plain join than with a long IN. Archived
 * fields are left out — a value nobody can see or edit is not part of the card.
 */
export async function customValuesMap(orgId: number, taskIds?: number[]): Promise<Map<number, Record<string, unknown>>> {
  const wanted = taskIds ? new Set(taskIds) : null;
  const rows = await db
    .select({ taskId: taskCustomValues.taskId, key: customFields.key, archived: customFields.archived, value: taskCustomValues.value })
    .from(taskCustomValues)
    .innerJoin(customFields, eq(taskCustomValues.fieldId, customFields.id))
    .where(eq(customFields.orgId, orgId));
  const out = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    if (row.archived) continue;
    if (wanted && !wanted.has(row.taskId)) continue;
    const bag = out.get(row.taskId) ?? {};
    bag[row.key] = row.value ?? null;
    out.set(row.taskId, bag);
  }
  return out;
}

/** The `custom` bag for one card. */
export async function customValuesFor(orgId: number, taskId: number): Promise<Record<string, unknown>> {
  return (await customValuesMap(orgId, [taskId])).get(taskId) ?? {};
}

/** Copy every value from one card to another — used when a recurrence clones its template. */
export async function copyCustomValues(orgId: number, fromTaskId: number, toTaskId: number): Promise<number> {
  const fields = await listFieldRows(orgId, true);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const source = (await customValuesMap(orgId, [fromTaskId])).get(fromTaskId) ?? {};
  let copied = 0;
  for (const [key, value] of Object.entries(source)) {
    const field = byKey.get(key);
    if (!field || value === null) continue;
    await db.insert(taskCustomValues).values({ taskId: toTaskId, fieldId: field.id, value });
    copied += 1;
  }
  return copied;
}
