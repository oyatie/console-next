import { useId, type ReactNode } from "react";
import { t } from "@console/i18n";
import s from "./field.module.css";

/**
 * A value the server computed (components.html §1, derived-field-with-reason): the value, an Auto
 * tag and the basis it was computed from. `onOverride` offers Edit; the caller then asks for a reason
 * code before the server records the override. Once overridden, `override` shows that recorded
 * reason in place of the basis, and `onRevert` offers recomputing.
 */
export function DerivedValue({ label, value, basis, override, onOverride, onRevert }: {
  label: string;
  value: ReactNode;
  basis?: ReactNode;
  override?: ReactNode;
  onOverride?: () => void;
  onRevert?: () => void;
}) {
  const id = useId();
  return (
    <div className={s.field} role="group" aria-labelledby={id}>
      <div className={s.label}>
        <span id={id}>{label}</span>
        <span className={override == null ? s.derived : s.overridden}>{t(override == null ? "uiField.derived" : "uiField.overridden")}</span>
        {onOverride && override == null && (
          <button type="button" className={`link ${s.link}`} onClick={onOverride} aria-label={t("uiField.override.label", { label })}>
            {t("uiField.override")}
          </button>
        )}
      </div>
      <div className={s.value}>{value}</div>
      {(override ?? basis) != null && <p data-hint="derived" className={s.hint}>{override ?? basis}</p>}
      {override != null && onRevert && (
        <button type="button" className={`link ${s.link}`} onClick={onRevert}>{t("uiField.revert")}</button>
      )}
    </div>
  );
}
