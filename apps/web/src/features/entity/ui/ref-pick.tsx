import type { ReactNode } from "react";
import type { CodeRef, RefListKey } from "@console/api/pending";
import { t } from "@console/i18n";
import { CodePicker } from "../../../ui/code-picker/code-picker";
import type { CodeOption } from "../../../ui/code-picker/code-picker";
import { Field, TextInput } from "../../../ui/field/field";
import { codeRef } from "../domain/capture";
import { useCodeSearch } from "./use-ref";
import s from "./entity-create.module.css";
import { Muted } from "../../../ui/muted/muted";

/**
 * A field whose value is a code from an official list, kept as `{code, label, version}` (design §4): picked by
 * search, never typed. A list that is not loaded never blocks; the field says so and the code is assigned later.
 */
export function RefPick({ listKey, label, required, value, onChange, hint, error, qualified }: {
  listKey: Exclude<RefListKey, "tax_office" | "nts_industry_code" | "bank">;
  label: string;
  required: boolean;
  value: CodeRef | null;
  onChange: (v: CodeRef | null, option?: CodeOption) => void;
  hint?: ReactNode;
  error?: ReactNode;
  /** Store the label with its parent (a district under its province), so the pick reads whole on its own. */
  qualified?: boolean;
}) {
  const c = useCodeSearch(listKey, t(`capture.list.${listKey}`));
  // company-15: a list the product does not bundle (KSIC, NHIS offices: licence held) is never promised; the code
  // printed on the paper is typed instead, stored as unchecked, and the field says so.
  if (!c.list.loaded && c.ready && listKey !== "admin_region")
    return (
      <div className={s.refSlot}><Field label={label} required={required} error={error} hint={<>{t("entityOps.code.typed")}{hint != null && <> · {hint}</>}</>}>
        {(f) => <TextInput {...f} className="code" maxLength={20} value={value?.code ?? ""} onChange={(x) => onChange(x.target.value.trim() ? codeRef(x.target.value.trim().toUpperCase(), x.target.value.trim().toUpperCase(), "UNVERIFIED") : null)} />}
      </Field></div>
    );
  // The stored pick stays selectable while the search shows other codes.
  const options = value && !c.options.some((o) => o.code === value.code) ? [{ code: value.code, label: value.label }, ...c.options] : c.options;
  return (
    <div className={s.refSlot}>
      <CodePicker
        label={label}
        required={required}
        list={c.list}
        query={c.query}
        onQueryChange={c.setQuery}
        options={options}
        value={value?.code ?? null}
        onChange={(code) => {
          const o = code === null ? undefined : options.find((x) => x.code === code);
          onChange(o ? (o.code === value?.code ? value : codeRef(o.code, qualified && o.context ? `${o.context} ${o.label}` : o.label, c.list.version)) : null, o);
        }}
        loading={c.loading}
        error={error}
        fallback={value && <span>{value.label} <span className="code">{value.code}</span></span>}
      />
      {hint != null && <Muted>{hint}</Muted>}
    </div>
  );
}
