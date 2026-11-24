import { useId, type ComponentProps, type ReactNode } from "react";
import { t } from "@console/i18n";
import s from "./field.module.css";
export { TextInput } from "./text-input";

/** What a Field hands its control: the ids that tie the label, hint and error to it. */
export type ControlProps = { id: string; "aria-describedby"?: string; "aria-invalid"?: true; required: boolean };

/** The required-or-optional marker. Every field label carries one, so `required` is never left implicit. */
export const Marker = ({ required }: { required: boolean }) => (
  <span data-marker className={s.marker}>{t(required ? "uiField.required" : "uiField.optional")}</span>
);

/** Related fields share native disabling and an optional legend; null omits the group marker. */
export function FieldSet({ label, required, children, className, ...props }: ComponentProps<"fieldset"> & { label?: ReactNode; required: boolean | null }) {
  return <fieldset {...props} className={className ? `${s.field} ${className}` : s.field}>
    {label != null && <legend className={s.label}>{label}{required !== null && <Marker required={required} />}</legend>}
    {children}
  </fieldset>;
}

/**
 * A labelled form field (components.html §1): the label is always visible and carries the required or optional marker,
 * the unit sits after the control, the hint and example sit under it, and the error appears right
 * under the field. Server errors arrive here too: the caller maps `errors[].field` to `error`.
 * The control is a render prop so any native control (input, select, textarea, date) gets the ids.
 */
export function Field({ id: givenId, label, required, unit, hint, hintHeld = false, example, error, warning, tag, children }: {
  id?: string;
  label: ReactNode;
  /** `null`: a search or filter box, which is neither required nor optional, so it carries no marker. */
  required: boolean | null;
  unit?: ReactNode;
  hint?: ReactNode;
  /** The hint keeps its line but is not shown or read yet (a line the value will fill, so filling it moves nothing). */
  hintHeld?: boolean;
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
  const describedBy = [hasHint && !hintHeld && hintId, error != null && errorId, warning != null && warningId].filter(Boolean).join(" ") || undefined;
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
        <p data-hint="field" id={hintId} className={s.hint} data-held={hintHeld || undefined}>
          {hint != null && <span>{hint}</span>}
          {example != null && <span>{t("uiField.example", { example })}</span>}
        </p>
      )}
      {error != null && <p id={errorId} className={s.error}>{error}</p>}
      {warning != null && <p id={warningId} className={s.warning}>{warning}</p>}
    </div>
  );
}
