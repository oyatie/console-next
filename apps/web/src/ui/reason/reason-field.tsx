import type { ReactNode } from "react";
import { FieldError, Label, Radio, RadioGroup } from "react-aria-components";
import { t } from "@console/i18n";
import { Field, Marker } from "../field/field";
import { reasonProblem, type Reason } from "./reason";
import s from "./reason.module.css";

export type ReasonCode = { code: string; label: string };

/**
 * Reason chips + memo (components.html §2, reason-enum-chips-with-memo). The codes come from the
 * server's list for this area; `other` names its Other code, which is always shown last and makes the
 * memo required. Nothing is preselected. `showErrors` turns on the inline errors once the user tried
 * to commit; `memoMax` is the server's limit (never a constant here). `footer` is the admin
 * add-a-code slot.
 */
export function ReasonField({ label, codes, other, value, onChange, memoMax, showErrors = false, error, footer }: {
  label: string;
  codes: readonly ReasonCode[];
  other: string;
  value: Reason;
  onChange: (next: Reason) => void;
  memoMax: number;
  showErrors?: boolean;
  /** A server error for this reason (e.g. a retired code). */
  error?: ReactNode;
  footer?: ReactNode;
}) {
  const ordered = [...codes.filter((c) => c.code !== other), ...codes.filter((c) => c.code === other)];
  const problem = showErrors ? reasonProblem(value, other) : null;
  const memoRequired = value.code === other;
  return (
    <div className={s.reason}>
      <RadioGroup
        className={s.group}
        value={value.code}
        onChange={(code) => onChange({ ...value, code })}
        isRequired
        validationBehavior="aria"
        isInvalid={problem === "pick" || error != null}
        orientation="horizontal"
      >
        <Label className={s.label}>
          {label}
          <Marker required />
        </Label>
        <div className={s.chips}>
          {ordered.map((c) => (
            <Radio key={c.code} value={c.code} className={s.chip}>{c.label}</Radio>
          ))}
        </div>
        <FieldError className={s.error}>{error ?? t("uiReason.pick", { label })}</FieldError>
      </RadioGroup>
      <Field
        label={t("uiReason.memo")}
        required={memoRequired}
        hint={t("uiReason.count", { count: value.memo.length, max: memoMax })}
        error={problem === "memo" ? t("uiReason.memoRequired") : undefined}
      >
        {(p) => (
          <textarea
            {...p}
            className="field__input field__area"
            maxLength={memoMax}
            value={value.memo}
            onChange={(e) => onChange({ ...value, memo: e.target.value })}
          />
        )}
      </Field>
      {footer}
    </div>
  );
}
