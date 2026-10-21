import type { ReactNode } from "react";
import { FieldError, Label, Radio, RadioGroup, Text } from "react-aria-components";
import { Check, Plus } from "lucide-react";
import { t } from "@console/i18n";
import { Field, Marker } from "../field/field";
import { MAX_CHIPS } from "./limits";
import s from "./choice.module.css";

/** `disabled` is the reason the option cannot be chosen now: it stays listed and says why (never hidden). */
export type ChoiceOption = { value: string; label: string; description?: string; content?: ReactNode; disabled?: string };

/** Above this many options a choice is a server search picker, not a list (components.html §3). */
const MAX_LIST = 15;
const MAX_VISIBLE = 5;

/**
 * One choice from a fixed list (components.html §3). The control follows the option count: up to 5
 * short options give a segmented control, up to 5 with descriptions give radio cards, 6–15 give a
 * select. Nothing is ever preselected (`value` starts null). List permissions lowest first.
 * `footer` is the escape hatch, e.g. asking an admin to add a type that is not listed.
 * `look="chips"` draws short options as separate pills (a ✓ on the chosen one) and `add` ends their row (e.g.
 * "+ add kind"); `columns` lays radio cards out in a grid. `note` sits beside the label ("nothing is preselected").
 */
export function ChoiceField({ label, required, options, value, onChange, error, hint, footer, note, look, add, columns }: {
  label: string;
  required: boolean;
  options: readonly ChoiceOption[];
  value: string | null;
  onChange: (value: string) => void;
  error?: ReactNode;
  hint?: ReactNode;
  footer?: ReactNode;
  note?: ReactNode;
  look?: "chips";
  add?: ReactNode;
  columns?: 2 | 3;
}) {
  if (options.length > (look === "chips" ? MAX_CHIPS : MAX_LIST)) throw new Error(`ChoiceField "${label}": ${options.length} options; use a search picker`);
  const chips = look === "chips" && !options.some((o) => o.description);
  if (options.length > MAX_VISIBLE && !chips)
    return (
      <Field label={label} required={required} error={error} hint={hint}>
        {(p) => (
          <select {...p} className="field__input" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
            <option value="" disabled>{t("uiChoice.placeholder", { label })}</option>
            {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled != null}>{o.disabled ? `${o.label} · ${o.disabled}` : o.label}</option>)}
          </select>
        )}
      </Field>
    );
  const cards = !chips && options.some((o) => o.description || o.disabled);
  return (
    <RadioGroup
      className={s.group}
      // Always controlled: a caller's `undefined` would make React Aria switch from uncontrolled to controlled.
      value={value ?? null}
      onChange={onChange}
      isRequired={required}
      validationBehavior="aria"
      isInvalid={error != null}
      orientation={cards ? "vertical" : "horizontal"}
    >
      <Label className={s.label}>
        {label}
        <Marker required={required} />
        {note != null && <span className={s.note}>{note}</span>}
      </Label>
      <div className={cards ? s.cards : chips ? s.chips : s.seg} data-columns={columns}>
        {options.map((o) => (
          <Radio key={o.value} value={o.value} isDisabled={o.disabled != null} className={cards ? s.card : chips ? s.chip : s.segItem}>
            {cards && <span className={s.dot} aria-hidden />}
            {chips && <Check className={s.tick} size={14} aria-hidden />}
            <span className={s.optLabel}>{o.content ?? o.label}</span>
            {o.description && <span className={s.desc}>{o.description}</span>}
            {o.disabled && <span className={s.why}>{o.disabled}</span>}
          </Radio>
        ))}
        {add}
      </div>
      {hint != null && <Text slot="description" className={s.hint}>{hint}</Text>}
      <FieldError className={s.error}>{error}</FieldError>
      {footer}
    </RadioGroup>
  );
}

/** The dashed pill that ends a chips row: adds an option that is not listed (e.g. a tenant workplace kind). */
export function ChoiceAdd({ label, onPress, id }: { label: string; onPress: () => void; id?: string }) {
  return (
    <button type="button" id={id} className={s.chipAdd} onClick={onPress}>
      <Plus size={14} aria-hidden />
      {label}
    </button>
  );
}
