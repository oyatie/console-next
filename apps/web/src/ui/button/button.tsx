import { lazy, Suspense, useId, useRef, useState, type ButtonHTMLAttributes, type FormHTMLAttributes, type ReactNode, type Ref } from "react";
import { t } from "@console/i18n";
import { chunk } from "../../lib/chunk-guard";
import type { ErrorSummaryItem } from "../error-summary";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./button-class";

const ErrorSummary = lazy(() => chunk(import("../error-summary")).then(m => ({ default: m.ErrorSummary })));

export type { ButtonSize, ButtonVariant };

/**
 * A button for feature views, which may not render raw controls. The label is a verb and its object.
 * `type` defaults to "button", so only an explicit submit submits a form. A hard-blocked command is not
 * this with `disabled`: use DisabledReason, which stays focusable and says why.
 */
export function Button({ variant = "secondary", size, icon, type = "button", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return <button {...rest} type={type} className={buttonClass(variant, { size, icon, className })} />;
}

/**
 * An icon-only button (a close ×, a row's ⋯, a zoom step): square, its name in `label` (the accessible name and the
 * tooltip). Never for a destructive act, which always says what it does in words (design-language §5.1).
 */
export function IconButton({ label, variant = "ghost", ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & { label: string; variant?: Exclude<ButtonVariant, "danger" | "ghost-danger">; size?: ButtonSize; ref?: Ref<HTMLButtonElement> }) {
  return <Button {...rest} variant={variant} icon aria-label={label} title={label} />;
}

/** An on/off button (`aria-pressed`): a filter or a view switch in a toolbar. */
export function ToggleButton({ pressed, look, count, countTone, className, children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> & {
  pressed: boolean;
  size?: ButtonSize;
  /** `chip`: a filter drawn as a pill (kit .optchip), bordered when off. */
  look?: "chip";
  /** The server's count after the label (kit .fchip .n): it keeps its width while it loads, so nothing beside it moves. */
  count?: ReactNode;
  /** `warn`: a to-do count (something waits on someone). */
  countTone?: "warn";
}) {
  const cls = [look === "chip" && "btn--chip", className].filter(Boolean).join(" ") || undefined;
  return (
    <Button {...rest} className={cls} aria-pressed={pressed} variant={look === "chip" || pressed ? "secondary" : "ghost"}>
      {children}
      {count !== undefined && <span className="btn__count" data-tone={countTone}>{count}</span>}
    </Button>
  );
}

/**
 * A form for feature views. `onSubmit` receives the submitter's `value` (two submit buttons may mean
 * "save" and "save and continue"); the browser's own submit is always prevented.
 */
export function Form({ onSubmit, children, onChangeCapture, ...rest }: Omit<FormHTMLAttributes<HTMLFormElement>, "onSubmit"> & { onSubmit: (submitter: string | null) => void }) {
  const [errors, setErrors] = useState<ErrorSummaryItem[]>([]);
  const [failures, setFailures] = useState(0);
  const armed = useRef(false);
  const formId = useId();
  const validate = (form: HTMLFormElement) => {
    const invalid = [...form.elements].filter((el): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
      el.matches("input, select, textarea") && !(el as HTMLInputElement).validity.valid);
    return invalid.map((el, index) => {
      el.id ||= `${formId}-${index}`;
      const label = el.labels?.[0];
      const text = new Range();
      if (label) {
        text.selectNode(label);
        const marker = label.querySelector("[data-marker]");
        if (marker) text.setEndBefore(marker);
      }
      const flag = Object.keys(ValidityState.prototype).find(key => el.validity[key as keyof ValidityState]);
      return {
        field: el.id,
        message: `${label ? text : el.name}: ${el.validity.customError ? el.validationMessage : t(`uiField.${flag as Exclude<keyof ValidityState, "valid" | "customError">}`)}`,
      };
    });
  };
  return (
    <form
      {...rest}
      noValidate
      onChangeCapture={(e) => {
        onChangeCapture?.(e);
        if (armed.current && !rest.noValidate) setErrors(validate(e.currentTarget));
      }}
      onSubmit={(e) => {
        e.preventDefault();
        const next = rest.noValidate ? [] : validate(e.currentTarget);
        armed.current = next.length > 0;
        setErrors(next);
        if (next.length) setFailures(n => n + 1);
        else onSubmit((e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ?? null);
      }}
    >
      {failures > 0 && <Suspense fallback={null}><ErrorSummary errors={errors} focusKey={failures} /></Suspense>}
      {children}
    </form>
  );
}

/** An attestation checkbox for feature views: the statement is its label. Use it only for a fact the user affirms. */
export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}
