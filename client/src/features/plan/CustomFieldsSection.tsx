import { useState } from "react";
import { Archive, Loader2, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { canAccess, useMe } from "@/hooks/use-me";
import { useCustomFields, useFieldMutations } from "./api";
import { DatePicker, Field } from "./pickers";
import { dayOf, toDayString } from "./logic";
import type { CustomFieldDef, CustomValues } from "./types";

/**
 * The card's custom fields.
 *
 * The definitions belong to the organization (`field.list`); the values belong
 * to the card and are held as draft state by the dialog, so they are saved with
 * everything else rather than field by field. A field's `kind` decides the
 * control, and the server validates the same rule again on the way in — the
 * control is a convenience, never the enforcement.
 *
 * Managers also get the one affordance that makes the feature usable without an
 * API client: a compact "new field" row. Renaming, reordering and archiving the
 * rest is `field.update` / `field.archive`.
 */
export function CustomFieldsSection({
  values,
  onChange,
  disabled,
}: {
  values: CustomValues;
  onChange: (key: string, value: unknown) => void;
  /** True when the caller may not write values (a member on someone else's card). */
  disabled?: boolean;
}) {
  const { role } = useMe();
  const isManager = canAccess(role, "manager");
  const { data: fields = [], isLoading } = useCustomFields();

  return (
    <details className="rule-t pt-3" data-testid="custom-fields-section">
      <summary className="flex cursor-pointer items-center justify-between text-sm">
        <span className="eyebrow">Fields</span>
        <span className="font-mono text-xs tabular-nums text-ink-muted">{isLoading ? "…" : fields.length === 0 ? "none" : fields.length}</span>
      </summary>

      <div className="mt-3 space-y-3">
        {!isLoading && fields.length === 0 && (
          <p className="font-serif text-xs text-ink-muted">
            No custom fields yet.{isManager ? " Add one below — it appears on every card in the organization." : " A manager can add them."}
          </p>
        )}

        {fields.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((field) => (
              <FieldControl key={field.id} field={field} value={values[field.key]} onChange={(v) => onChange(field.key, v)} disabled={disabled} />
            ))}
          </div>
        )}

        {disabled && fields.length > 0 && (
          <p className="font-mono text-[10px] text-ink-muted">Read-only: a member may only set fields on a card assigned to them.</p>
        )}

        {isManager && <NewFieldRow existing={fields} />}
      </div>
    </details>
  );
}

function FieldControl({
  field,
  value,
  onChange,
  disabled,
}: {
  field: CustomFieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const hint = field.kind === "multiselect" ? "any of" : field.kind;

  if (field.kind === "checkbox") {
    return (
      <Field label={field.name} hint={hint}>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? true : null)}
            className="accent-vermilion"
            data-testid={`custom-${field.key}`}
          />
          <span className="font-serif text-sm text-ink-muted">{value === true ? "yes" : "no"}</span>
        </label>
      </Field>
    );
  }

  if (field.kind === "select") {
    return (
      <Field label={field.name} hint={hint}>
        <select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
          className="draft-input w-full appearance-none bg-parchment"
          data-testid={`custom-${field.key}`}
        >
          <option value="">—</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  if (field.kind === "multiselect") {
    const selected = Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === "string") : [];
    return (
      <Field label={field.name} hint={hint}>
        <div className="flex flex-wrap gap-1.5" data-testid={`custom-${field.key}`}>
          {field.options.map((option) => {
            const on = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() => {
                  const next = on ? selected.filter((s) => s !== option) : [...selected, option];
                  onChange(next.length ? next : null);
                }}
                className={cn(
                  "border px-2 py-1 font-mono text-[11px] transition-colors focus-ink disabled:opacity-50",
                  on ? "border-ink bg-ink text-parchment" : "border-rule text-ink-muted hover:border-ink hover:text-ink"
                )}
              >
                {option}
              </button>
            );
          })}
        </div>
      </Field>
    );
  }

  if (field.kind === "date") {
    return (
      <Field label={field.name} hint={hint}>
        <DatePicker
          value={dayOf(typeof value === "string" ? value : null)}
          onChange={(date) => onChange(date ? toDayString(date) : null)}
          placeholder="—"
        />
      </Field>
    );
  }

  const isNumber = field.kind === "number";
  return (
    <Field label={field.name} hint={hint}>
      <input
        type={isNumber ? "number" : field.kind === "url" ? "url" : "text"}
        value={value === null || value === undefined ? "" : String(value)}
        disabled={disabled}
        placeholder={field.kind === "url" ? "https://…" : "—"}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw.trim() === "") return onChange(null);
          onChange(isNumber ? Number(raw) : raw);
        }}
        className={cn("draft-input w-full", isNumber && "font-mono tabular-nums")}
        data-testid={`custom-${field.key}`}
      />
    </Field>
  );
}

const KINDS = ["text", "number", "date", "select", "multiselect", "checkbox", "url"] as const;

/** Manager-only: define a new field without leaving the card. */
function NewFieldRow({ existing }: { existing: CustomFieldDef[] }) {
  const { create, archive } = useFieldMutations();
  const [openForm, setOpenForm] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("text");
  const [options, setOptions] = useState("");

  const needsOptions = kind === "select" || kind === "multiselect";
  const submit = async () => {
    const list = options.split(",").map((o) => o.trim()).filter(Boolean);
    if (!name.trim() || (needsOptions && list.length === 0)) return;
    try {
      await create.mutateAsync({ name: name.trim(), kind, options: needsOptions ? list : undefined });
      setName("");
      setOptions("");
      setOpenForm(false);
    } catch {
      // useFieldMutations already surfaced it as a toast.
    }
  };

  if (!openForm) {
    return (
      <button
        type="button"
        onClick={() => setOpenForm(true)}
        className="inline-flex items-center gap-1.5 border border-rule px-2 py-1 transition-colors hover:border-ink focus-ink"
        data-testid="field-new"
      >
        <Plus className="h-3 w-3 text-vermilion" />
        <span className="eyebrow !text-current">new field</span>
      </button>
    );
  }

  return (
    <div className="paper-flat space-y-2 p-2.5">
      <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Field name, e.g. Customer severity"
          className="draft-input w-full"
          data-testid="field-new-name"
        />
        <select value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])} className="draft-input w-full appearance-none bg-parchment" data-testid="field-new-kind">
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      {needsOptions && (
        <input
          value={options}
          onChange={(e) => setOptions(e.target.value)}
          placeholder="Options, comma separated — low, high, critical"
          className="draft-input w-full font-mono text-xs"
          data-testid="field-new-options"
        />
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={create.isPending}
          className="flex items-center gap-1.5 border border-ink bg-ink px-3 py-1.5 text-parchment transition-colors hover:bg-parchment hover:text-ink focus-ink disabled:opacity-60"
          data-testid="field-new-save"
        >
          {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          <span className="eyebrow !text-current">add field</span>
        </button>
        <button type="button" onClick={() => setOpenForm(false)} className="border border-rule px-3 py-1.5 transition-colors hover:border-ink focus-ink">
          <span className="eyebrow !text-current">cancel</span>
        </button>
        {existing.length > 0 && (
          <span className="ml-auto flex flex-wrap items-center gap-1">
            {existing.map((field) => (
              <button
                key={field.id}
                type="button"
                title={`Archive "${field.name}" — cards keep the values they already hold`}
                onClick={() => archive.mutate({ fieldId: field.id, archived: true })}
                className="inline-flex items-center gap-1 border border-rule px-1.5 py-0.5 font-mono text-[10px] text-ink-muted transition-colors hover:border-vermilion hover:text-vermilion focus-ink"
                data-testid={`field-archive-${field.key}`}
              >
                <Archive className="h-2.5 w-2.5" />
                {field.key}
                <X className="h-2.5 w-2.5" />
              </button>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
