import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { t } from "@console/i18n";
import s from "./field.module.css";

/** What a Field hands its control: the ids that tie the label, hint and error to it. */
export type ControlProps = { id: string; "aria-describedby"?: string; "aria-invalid"?: true; required: boolean };

/** The required-or-optional marker. Every field label carries one, so `required` is never left implicit. */
export const Marker = ({ required }: { required: boolean }) => (
  <span data-marker className={s.marker}>{t(required ? "uiField.required" : "uiField.optional")}</span>
);

/** Related fields share one accessible legend and requiredness marker. */
export function FieldSet({ label, required, children }: { label: ReactNode; required: boolean; children: ReactNode }) {
  return <fieldset className={s.field}>
    <legend className={s.label}>{label}<Marker required={required} /></legend>
    {children}
  </fieldset>;
}

/**
 * A labelled form field (components.html §1): the label is always visible and carries the required or optional marker,
 * the unit sits after the control, the hint and example sit under it, and the error appears right
 * under the field. Server errors arrive here too: the caller maps `errors[].field` to `error`.
 * The control is a render prop so any native control (input, select, textarea, date) gets the ids.
 */
export function Field({ id: givenId, label, required, unit, hint, example, error, warning, tag, children }: {
  id?: string;
  label: ReactNode;
  /** `null`: a search or filter box, which is neither required nor optional, so it carries no marker. */
  required: boolean | null;
  unit?: ReactNode;
  hint?: ReactNode;
  /** A worked example, shown with an "e.g." prefix. */
  example?: string;
  error?: ReactNode;
  /** A soft check that failed (amber, never blocks): e.g. a check digit that does not match. */
  warning?: ReactNode;
  /** Extra marks after the label, e.g. a derived-value tag. */
  tag?: ReactNode;
  children: (control: ControlProps) => ReactNode;
}) {
  const generatedId = useId();
  const id = givenId ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const warningId = `${id}-warning`;
  const hasHint = hint != null || example != null;
  const describedBy = [hasHint && hintId, error != null && errorId, warning != null && warningId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={id}>
        {label}
        {required !== null && <Marker required={required} />}
        {tag}
      </label>
      <div className={s.control}>
        {children({ id, "aria-describedby": describedBy, "aria-invalid": error != null ? true : undefined, required: required === true })}
        {unit != null && <span className={s.unit}>{unit}</span>}
      </div>
      {hasHint && (
        <p data-hint="field" id={hintId} className={s.hint}>
          {hint != null && <span>{hint}</span>}
          {example != null && <span>{t("uiField.example", { example })}</span>}
        </p>
      )}
      {error != null && <p id={errorId} className={s.error}>{error}</p>}
      {warning != null && <p id={warningId} className={s.warning}>{warning}</p>}
    </div>
  );
}

/**
 * A text input that never submits its form on Enter: free text is not a commit gesture, and an Enter
 * that ends Korean IME composition (isComposing / keyCode 229) is left to the IME.
 */
export function TextInput({ className, onKeyDown, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      {...rest}
      className={className ? `field__input ${className}` : "field__input"}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (e.nativeEvent.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
          e.preventDefault();
        }
        onKeyDown?.(e);
      }}
    />
  );
}
